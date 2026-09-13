import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  parseLlmReply,
  type ChatHistoryResponse,
  type ChatLiveEvent,
  type ChatThreadMessage,
} from "@workee/shared";

type KnownConversation = {
  id: string | null;
  startedAt: string | null;
};
import { chatApi } from "@/services/chat.service";
import { ApiError } from "@/types";

export type ChatMessage = ChatThreadMessage;

interface ChatContextValue {
  chatAsId: string;
  setChatAsId: (id: string) => void;
  threads: Record<string, ChatMessage[]>;
  rawResponses: Record<string, unknown>;
  sendingEmployeeId: string | null;
  historyLoadingId: string | null;
  resetting: boolean;
  error: string | null;
  send: (input: {
    employeeId: string;
    speaker: string;
    text: string;
  }) => Promise<void>;
  resetConversation: () => Promise<void>;
  stop: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [chatAsId, setChatAsIdState] = useState("");
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [rawResponses, setRawResponses] = useState<Record<string, unknown>>({});
  const [sendingEmployeeId, setSendingEmployeeId] = useState<string | null>(null);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationIdsRef = useRef<Record<string, KnownConversation>>({});

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!chatAsId) {
      return;
    }

    const employeeId = chatAsId;
    const abort = new AbortController();
    let initial = true;
    setHistoryLoadingId(employeeId);

    const refresh = () =>
      chatApi
        .history(employeeId, abort.signal)
        .then((history) => {
          applyHistory(employeeId, history, conversationIdsRef.current, setThreads, setRawResponses);
        })
        .catch((caught) => {
          if (caught instanceof ApiError && caught.code === "ABORTED") {
            return;
          }

          if (initial) {
            setError(
              caught instanceof ApiError
                ? caught.message
                : "Unable to load chat history.",
            );
          }
        })
        .finally(() => {
          if (initial) {
            initial = false;
            setHistoryLoadingId((current) =>
              current === employeeId ? null : current,
            );
          }
        });

    const applyLiveEvent = (event: ChatLiveEvent) => {
      if (event.employeeId !== employeeId) {
        return;
      }
      setThreads((current) => {
        const thread = current[employeeId] ?? [];
        const already = thread.some(
          (message) =>
            message.id === event.message.id ||
            messageKey(message) === messageKey(event.message),
        );
        return already
          ? current
          : { ...current, [employeeId]: [...thread, event.message] };
      });
      if (event.raw !== undefined) {
        setRawResponses((current) => ({
          ...current,
          [employeeId]: event.raw,
        }));
      }
    };

    void refresh();
    const poll = window.setInterval(() => {
      void refresh();
    }, 2000);
    const unsubscribe = chatApi.subscribe(employeeId, applyLiveEvent);

    return () => {
      abort.abort();
      window.clearInterval(poll);
      unsubscribe();
    };
  }, [chatAsId]);

  const setChatAsId = useCallback((id: string) => {
    setChatAsIdState(id);
    setError(null);
  }, []);

  const send = useCallback(
    async (input: { employeeId: string; speaker: string; text: string }) => {
      if (sendingEmployeeId) {
        return;
      }

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        author: "you",
        speaker: input.speaker,
        text: input.text,
      };

      setThreads((current) => ({
        ...current,
        [input.employeeId]: [...(current[input.employeeId] ?? []), userMessage],
      }));
      setError(null);
      setSendingEmployeeId(input.employeeId);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const { reply, raw, notifications } = await chatApi.send(
          {
            message: input.text,
            employeeId: input.employeeId,
          },
          abort.signal,
        );
        const parsed = parseLlmReply(reply);

        setThreads((current) => {
          const next = {
            ...current,
            [input.employeeId]: [
              ...(current[input.employeeId] ?? []),
              {
                id: crypto.randomUUID(),
                author: "assistant" as const,
                speaker: "Assistant",
                text: parsed.response,
                actions: parsed.actions,
              },
            ],
          };

          for (const notification of notifications ?? []) {
            const thread = next[notification.employeeId] ?? [];
            next[notification.employeeId] = thread.some(
              (message) =>
                message.id === notification.message.id ||
                messageKey(message) === messageKey(notification.message),
            )
              ? thread
              : [...thread, notification.message];
          }

          return next;
        });
        setRawResponses((current) => {
          const next = {
            ...current,
            [input.employeeId]: raw ?? reply,
          };

          for (const notification of notifications ?? []) {
            if (notification.raw !== undefined) {
              next[notification.employeeId] = notification.raw;
            }
          }

          return next;
        });
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === "ABORTED") {
          return;
        }

        setError(
          caught instanceof ApiError
            ? caught.message
            : "Something went wrong. Please try again.",
        );
      } finally {
        if (abortRef.current === abort) {
          abortRef.current = null;
        }
        setSendingEmployeeId(null);
      }
    },
    [sendingEmployeeId],
  );

  const resetConversation = useCallback(async () => {
    if (!chatAsId || sendingEmployeeId || resetting) {
      return;
    }

    setResetting(true);
    setError(null);

    try {
      const history = await chatApi.reset(chatAsId);
      conversationIdsRef.current[chatAsId] = {
        id: history.conversationId,
        startedAt: history.startedAt,
      };
      setThreads((current) => ({
        ...current,
        [chatAsId]: [],
      }));
      setRawResponses((current) => {
        const next = { ...current };
        delete next[chatAsId];
        return next;
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to reset the conversation.",
      );
    } finally {
      setResetting(false);
    }
  }, [chatAsId, resetting, sendingEmployeeId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const value = useMemo(
    () => ({
      chatAsId,
      setChatAsId,
      threads,
      rawResponses,
      sendingEmployeeId,
      historyLoadingId,
      resetting,
      error,
      send,
      resetConversation,
      stop,
    }),
    [
      chatAsId,
      setChatAsId,
      threads,
      rawResponses,
      sendingEmployeeId,
      historyLoadingId,
      resetting,
      error,
      send,
      resetConversation,
      stop,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

function applyHistory(
  employeeId: string,
  history: ChatHistoryResponse,
  knownIds: Record<string, KnownConversation>,
  setThreads: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>,
  setRawResponses: Dispatch<SetStateAction<Record<string, unknown>>>,
): void {
  const known = knownIds[employeeId];
  if (isStaleHistory(known, history)) {
    return;
  }

  const conversationChanged =
    known?.id != null &&
    history.conversationId != null &&
    known.id !== history.conversationId;

  knownIds[employeeId] = {
    id: history.conversationId,
    startedAt: history.startedAt,
  };

  setThreads((current) => ({
    ...current,
    [employeeId]: conversationChanged
      ? history.messages
      : mergeMessages(current[employeeId] ?? [], history.messages),
  }));
  setRawResponses((current) => {
    if (conversationChanged) {
      const next = { ...current };
      if (history.raw === undefined || history.raw === null) {
        delete next[employeeId];
        return next;
      }
      return { ...next, [employeeId]: history.raw };
    }
    return {
      ...current,
      [employeeId]: history.raw ?? current[employeeId],
    };
  });
}

function isStaleHistory(
  known: KnownConversation | undefined,
  history: ChatHistoryResponse,
): boolean {
  if (!known?.startedAt || !history.startedAt) {
    return false;
  }
  return history.startedAt < known.startedAt;
}

function messageKey(message: ChatMessage): string {
  return `${message.author}|${message.speaker}|${message.text}`;
}

function mergeMessages(
  local: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (incoming.length === 0) {
    return local;
  }

  const incomingIds = new Set(incoming.map((message) => message.id));
  const incomingKeys = new Set(incoming.map((message) => messageKey(message)));
  const localOnly = local.filter(
    (message) =>
      !incomingIds.has(message.id) && !incomingKeys.has(messageKey(message)),
  );
  return [...incoming, ...localOnly];
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);

  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }

  return context;
}
