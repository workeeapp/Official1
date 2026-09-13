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
  chatThreadKey,
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
  chatWithId: string;
  setChatWithId: (id: string) => void;
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
    digitalEmployeeId?: string;
    assistantSpeaker?: string;
  }) => Promise<void>;
  resetConversation: () => Promise<void>;
  stop: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [chatAsId, setChatAsIdState] = useState("");
  const [chatWithId, setChatWithIdState] = useState("");
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
    if (!chatAsId || !chatWithId) {
      return;
    }

    const employeeId = chatAsId;
    const digitalEmployeeId = chatWithId;
    const threadId = chatThreadKey(employeeId, digitalEmployeeId);
    const abort = new AbortController();
    let initial = true;
    setHistoryLoadingId(threadId);

    const refresh = () =>
      chatApi
        .history(employeeId, digitalEmployeeId, abort.signal)
        .then((history) => {
          applyHistory(threadId, history, conversationIdsRef.current, setThreads, setRawResponses);
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
              current === threadId ? null : current,
            );
          }
        });

    const applyLiveEvent = (event: ChatLiveEvent) => {
      if (event.employeeId !== employeeId) {
        return;
      }
      if (event.digitalEmployeeId && event.digitalEmployeeId !== digitalEmployeeId) {
        return;
      }
      setThreads((current) => {
        const thread = current[threadId] ?? [];
        const already = thread.some(
          (message) =>
            message.id === event.message.id ||
            messageKey(message) === messageKey(event.message),
        );
        return already
          ? current
          : { ...current, [threadId]: [...thread, event.message] };
      });
      if (event.raw !== undefined) {
        setRawResponses((current) => ({
          ...current,
          [threadId]: event.raw,
        }));
      }
    };

    void refresh();
    const poll = window.setInterval(() => {
      void refresh();
    }, 2000);
    const unsubscribe = chatApi.subscribe(employeeId, digitalEmployeeId, applyLiveEvent);

    return () => {
      abort.abort();
      window.clearInterval(poll);
      unsubscribe();
    };
  }, [chatAsId, chatWithId]);

  const setChatAsId = useCallback((id: string) => {
    setChatAsIdState(id);
    setError(null);
  }, []);

  const setChatWithId = useCallback((id: string) => {
    setChatWithIdState(id);
    setError(null);
  }, []);

  const send = useCallback(
    async (input: {
      employeeId: string;
      speaker: string;
      text: string;
      digitalEmployeeId?: string;
      assistantSpeaker?: string;
    }) => {
      if (sendingEmployeeId) {
        return;
      }

      const threadId = input.digitalEmployeeId
        ? chatThreadKey(input.employeeId, input.digitalEmployeeId)
        : input.employeeId;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        author: "you",
        speaker: input.speaker,
        text: input.text,
        createdAt: new Date().toISOString(),
      };

      setThreads((current) => ({
        ...current,
        [threadId]: [...(current[threadId] ?? []), userMessage],
      }));
      setError(null);
      setSendingEmployeeId(threadId);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const { reply, raw, notifications } = await chatApi.send(
          {
            message: input.text,
            employeeId: input.employeeId,
            ...(input.digitalEmployeeId
              ? { digitalEmployeeId: input.digitalEmployeeId }
              : {}),
          },
          abort.signal,
        );
        const parsed = parseLlmReply(reply);

        setThreads((current) => {
          const next = {
            ...current,
            [threadId]: [
              ...(current[threadId] ?? []),
              {
                id: crypto.randomUUID(),
                author: "assistant" as const,
                speaker: input.assistantSpeaker ?? "Assistant",
                text: parsed.response,
                createdAt: new Date().toISOString(),
                actions: parsed.actions,
              },
            ],
          };

          for (const notification of notifications ?? []) {
            const partnerId =
              notification.digitalEmployeeId ?? input.digitalEmployeeId;
            const notificationThread = partnerId
              ? chatThreadKey(notification.employeeId, partnerId)
              : notification.employeeId;
            const thread = next[notificationThread] ?? [];
            next[notificationThread] = thread.some(
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
            [threadId]: raw ?? reply,
          };

          for (const notification of notifications ?? []) {
            if (notification.raw !== undefined) {
              const partnerId =
                notification.digitalEmployeeId ?? input.digitalEmployeeId;
              const notificationThread = partnerId
                ? chatThreadKey(notification.employeeId, partnerId)
                : notification.employeeId;
              next[notificationThread] = notification.raw;
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
    if (!chatAsId || !chatWithId || sendingEmployeeId || resetting) {
      return;
    }

    const threadId = chatThreadKey(chatAsId, chatWithId);
    setResetting(true);
    setError(null);

    try {
      const history = await chatApi.reset(chatAsId, chatWithId);
      conversationIdsRef.current[threadId] = {
        id: history.conversationId,
        startedAt: history.startedAt,
      };
      setThreads((current) => ({
        ...current,
        [threadId]: [],
      }));
      setRawResponses((current) => {
        const next = { ...current };
        delete next[threadId];
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
  }, [chatAsId, chatWithId, resetting, sendingEmployeeId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const value = useMemo(
    () => ({
      chatAsId,
      setChatAsId,
      chatWithId,
      setChatWithId,
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
      chatWithId,
      setChatWithId,
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
  threadId: string,
  history: ChatHistoryResponse,
  knownIds: Record<string, KnownConversation>,
  setThreads: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>,
  setRawResponses: Dispatch<SetStateAction<Record<string, unknown>>>,
): void {
  const known = knownIds[threadId];
  if (isStaleHistory(known, history)) {
    return;
  }

  const conversationChanged =
    known?.id != null &&
    history.conversationId != null &&
    known.id !== history.conversationId;

  knownIds[threadId] = {
    id: history.conversationId,
    startedAt: history.startedAt,
  };

  setThreads((current) => ({
    ...current,
    [threadId]: conversationChanged
      ? history.messages
      : mergeMessages(current[threadId] ?? [], history.messages),
  }));
  setRawResponses((current) => {
    if (conversationChanged) {
      const next = { ...current };
      if (history.raw === undefined || history.raw === null) {
        delete next[threadId];
        return next;
      }
      return { ...next, [threadId]: history.raw };
    }
    return {
      ...current,
      [threadId]: history.raw ?? current[threadId],
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

  const localById = new Map(local.map((message) => [message.id, message]));
  const localByKey = new Map(local.map((message) => [messageKey(message), message]));
  const incomingIds = new Set(incoming.map((message) => message.id));
  const incomingKeys = new Set(incoming.map((message) => messageKey(message)));
  const mergedIncoming = incoming.map((message) => {
    if (message.createdAt) {
      return message;
    }

    const previous =
      localById.get(message.id) ?? localByKey.get(messageKey(message));
    return previous?.createdAt
      ? { ...message, createdAt: previous.createdAt }
      : message;
  });
  const localOnly = local.filter(
    (message) =>
      !incomingIds.has(message.id) && !incomingKeys.has(messageKey(message)),
  );
  return [...mergedIncoming, ...localOnly];
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);

  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }

  return context;
}
