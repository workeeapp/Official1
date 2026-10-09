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
import { useLocation } from "react-router-dom";
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
import { sortChatMessages } from "@/pages/Chat/chatTime";
import { ApiError } from "@/types";

export type ChatMessage = ChatThreadMessage;

interface ChatContextValue {
  chatAsId: string;
  setChatAsId: (id: string) => void;
  chatWithId: string;
  setChatWithId: (id: string) => void;
  threads: Record<string, ChatMessage[]>;
  rawResponses: Record<string, unknown>;
  rawRequests: Record<string, unknown>;
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
  const [rawRequests, setRawRequests] = useState<Record<string, unknown>>({});
  const [sendingEmployeeId, setSendingEmployeeId] = useState<string | null>(null);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationIdsRef = useRef<Record<string, KnownConversation>>({});
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const location = useLocation();
  const viewingChat = location.pathname === "/chat" || location.pathname.startsWith("/chat/");

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!viewingChat || !chatAsId || !chatWithId) {
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
          applyHistory(
            threadId,
            history,
            conversationIdsRef.current,
            pendingIdsRef.current,
            setThreads,
            setRawResponses,
            setRawRequests,
          );
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
        const next = applyLiveMessage(thread, event.message, pendingIdsRef.current);
        return next === thread ? current : { ...current, [threadId]: next };
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
  }, [viewingChat, chatAsId, chatWithId]);

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
      pendingIdsRef.current.add(userMessage.id);

      setThreads((current) => ({
        ...current,
        [threadId]: [...(current[threadId] ?? []), userMessage],
      }));
      setError(null);
      setSendingEmployeeId(threadId);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const { reply, raw, request, timing, messageIds } = await chatApi.send(
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
        const replyId = messageIds?.assistant ?? crypto.randomUUID();
        if (!messageIds) {
          pendingIdsRef.current.add(replyId);
        }
        const replyMessage: ChatMessage = {
          id: replyId,
          author: "assistant",
          speaker: input.assistantSpeaker ?? "Assistant",
          text: parsed.response,
          createdAt: new Date().toISOString(),
          actions: parsed.actions,
          ...(parsed.buttons ? { buttons: parsed.buttons } : {}),
          llmMs: timing?.llmMs,
          afterLlmMs: timing?.afterLlmMs,
        };

        setThreads((current) => ({
          ...current,
          [threadId]: placeTurnReply(current[threadId] ?? [], {
            pendingUserId: userMessage.id,
            savedUserId: messageIds?.user,
            reply: replyMessage,
          }),
        }));
        setRawResponses((current) => ({
          ...current,
          [threadId]: raw ?? reply,
        }));
        setRawRequests((current) => ({
          ...current,
          [threadId]: request,
        }));
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
      setRawRequests((current) => {
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
      rawRequests,
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
      rawRequests,
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
  pendingIds: ReadonlySet<string>,
  setThreads: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>,
  setRawResponses: Dispatch<SetStateAction<Record<string, unknown>>>,
  setRawRequests: Dispatch<SetStateAction<Record<string, unknown>>>,
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

  setThreads((current) => {
    const merged = sortChatMessages(
      conversationChanged
        ? history.messages
        : mergeMessages(current[threadId] ?? [], history.messages, pendingIds),
    );
    if (sameMessages(current[threadId] ?? [], merged)) {
      return current;
    }
    return {
      ...current,
      [threadId]: merged,
    };
  });
  setRawResponses((current) => {
    if (conversationChanged) {
      const next = { ...current };
      if (history.raw === undefined || history.raw === null) {
        if (current[threadId] === undefined) {
          return current;
        }
        delete next[threadId];
        return next;
      }
      if (current[threadId] === history.raw) {
        return current;
      }
      return { ...next, [threadId]: history.raw };
    }
    const raw = history.raw ?? current[threadId];
    if (current[threadId] === raw) {
      return current;
    }
    return {
      ...current,
      [threadId]: raw,
    };
  });
  setRawRequests((current) => {
    if (conversationChanged) {
      const next = { ...current };
      if (history.request === undefined || history.request === null) {
        if (current[threadId] === undefined) {
          return current;
        }
        delete next[threadId];
        return next;
      }
      if (current[threadId] === history.request) {
        return current;
      }
      return { ...next, [threadId]: history.request };
    }
    const request = history.request ?? current[threadId];
    if (current[threadId] === request) {
      return current;
    }
    return {
      ...current,
      [threadId]: request,
    };
  });
}

function sameMessages(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => {
    const other = right[index];
    return (
      message.id === other.id &&
      message.author === other.author &&
      message.speaker === other.speaker &&
      message.text === other.text &&
      message.createdAt === other.createdAt &&
      message.llmMs === other.llmMs &&
      message.afterLlmMs === other.afterLlmMs &&
      JSON.stringify(message.actions ?? []) === JSON.stringify(other.actions ?? [])
    );
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

// Client and server clocks can differ; a saved copy is never much older than the local one.
const PENDING_MATCH_SKEW_MS = 5 * 60 * 1000;

function canReplacePending(pending: ChatMessage, saved: ChatMessage): boolean {
  if (messageKey(pending) !== messageKey(saved)) {
    return false;
  }
  const pendingAt = Date.parse(pending.createdAt ?? "");
  const savedAt = Date.parse(saved.createdAt ?? "");
  if (Number.isNaN(pendingAt) || Number.isNaN(savedAt)) {
    return true;
  }
  return savedAt >= pendingAt - PENDING_MATCH_SKEW_MS;
}

/**
 * Locally created (pending) messages are replaced only by server messages this thread has
 * not shown yet — repeating an earlier text must not match the old saved copy.
 */
export function mergeMessages(
  local: ChatMessage[],
  incoming: ChatMessage[],
  pendingIds: ReadonlySet<string> = new Set(),
): ChatMessage[] {
  if (incoming.length === 0) {
    return local;
  }

  const localById = new Map(local.map((message) => [message.id, message]));
  const incomingIds = new Set(incoming.map((message) => message.id));
  const fresh = incoming.filter((message) => !localById.has(message.id));
  const replacedBy = new Map<string, ChatMessage>();
  const replacedPending = new Set<string>();
  for (const message of local) {
    if (!pendingIds.has(message.id) || incomingIds.has(message.id)) {
      continue;
    }
    const saved = fresh.find(
      (candidate) =>
        !replacedBy.has(candidate.id) && canReplacePending(message, candidate),
    );
    if (saved) {
      replacedBy.set(saved.id, message);
      replacedPending.add(message.id);
    }
  }

  const mergedIncoming = incoming.map((message) => {
    const previous = localById.get(message.id) ?? replacedBy.get(message.id);
    return {
      ...message,
      createdAt: message.createdAt ?? previous?.createdAt,
      llmMs: message.llmMs ?? previous?.llmMs,
      afterLlmMs: message.afterLlmMs ?? previous?.afterLlmMs,
    };
  });
  const localOnly = local.filter(
    (message) => !incomingIds.has(message.id) && !replacedPending.has(message.id),
  );
  return sortChatMessages([...mergedIncoming, ...localOnly]);
}

/**
 * The POST reply carries the saved ids of this turn. History polling may already
 * have shown either row (possibly before the engine appended its notice), so the
 * pending user bubble takes the saved id and the reply replaces any saved copy.
 */
export function placeTurnReply(
  thread: ChatMessage[],
  input: { pendingUserId: string; savedUserId?: string; reply: ChatMessage },
): ChatMessage[] {
  const { pendingUserId, savedUserId, reply } = input;
  let next = thread;
  if (savedUserId && savedUserId !== pendingUserId) {
    const hasSaved = next.some((message) => message.id === savedUserId);
    next = hasSaved
      ? next.filter((message) => message.id !== pendingUserId)
      : next.map((message) =>
          message.id === pendingUserId ? { ...message, id: savedUserId } : message,
        );
  }
  const savedIndex = next.findIndex((message) => message.id === reply.id);
  if (savedIndex < 0) {
    return [...next, reply];
  }
  const saved = next[savedIndex];
  const merged = [...next];
  merged[savedIndex] = {
    ...reply,
    createdAt: saved.createdAt ?? reply.createdAt,
  };
  return merged;
}

/** Live server message: replace its pending local copy, or append it. */
export function applyLiveMessage(
  thread: ChatMessage[],
  message: ChatMessage,
  pendingIds: ReadonlySet<string>,
): ChatMessage[] {
  if (thread.some((existing) => existing.id === message.id)) {
    return thread;
  }
  const pendingIndex = thread.findIndex(
    (existing) => pendingIds.has(existing.id) && canReplacePending(existing, message),
  );
  if (pendingIndex >= 0) {
    const pending = thread[pendingIndex];
    const next = [...thread];
    next[pendingIndex] = {
      ...message,
      llmMs: message.llmMs ?? pending.llmMs,
      afterLlmMs: message.afterLlmMs ?? pending.afterLlmMs,
    };
    return next;
  }
  return [...thread, message];
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);

  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }

  return context;
}
