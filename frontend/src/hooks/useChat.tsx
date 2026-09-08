import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parseLlmReply } from "@workee/shared";
import { chatApi } from "@/services/chat.service";
import { ApiError } from "@/types";

export interface ChatMessage {
  id: string;
  author: "you" | "assistant";
  speaker: string;
  text: string;
  actions?: string[];
}

interface ChatContextValue {
  chatAsId: string;
  setChatAsId: (id: string) => void;
  threads: Record<string, ChatMessage[]>;
  rawResponses: Record<string, unknown>;
  sendingEmployeeId: string | null;
  error: string | null;
  send: (input: {
    employeeId: string;
    speaker: string;
    text: string;
  }) => Promise<void>;
  stop: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [chatAsId, setChatAsIdState] = useState("");
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [rawResponses, setRawResponses] = useState<Record<string, unknown>>({});
  const [sendingEmployeeId, setSendingEmployeeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

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
        const { reply, raw } = await chatApi.send(
          {
            message: input.text,
            employeeId: input.employeeId,
          },
          abort.signal,
        );
        const parsed = parseLlmReply(reply);

        setThreads((current) => ({
          ...current,
          [input.employeeId]: [
            ...(current[input.employeeId] ?? []),
            {
              id: crypto.randomUUID(),
              author: "assistant",
              speaker: "Assistant",
              text: parsed.response,
              actions: parsed.actions,
            },
          ],
        }));
        setRawResponses((current) => ({
          ...current,
          [input.employeeId]: raw ?? reply,
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
      error,
      send,
      stop,
    }),
    [chatAsId, setChatAsId, threads, rawResponses, sendingEmployeeId, error, send, stop],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);

  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }

  return context;
}
