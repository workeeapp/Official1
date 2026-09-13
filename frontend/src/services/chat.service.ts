import type {
  ChatHistoryResponse,
  ChatLiveEvent,
  ChatMessageRequest,
  ChatMessageResponse,
} from "@workee/shared";
import { api } from "./http";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export const chatApi = {
  history(employeeId: string, signal?: AbortSignal): Promise<ChatHistoryResponse> {
    const query = new URLSearchParams({ employeeId });
    return api<ChatHistoryResponse>(`/api/chat/messages?${query}`, { signal });
  },
  send(
    input: ChatMessageRequest,
    signal?: AbortSignal,
  ): Promise<ChatMessageResponse> {
    return api<ChatMessageResponse>("/api/chat/messages", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    });
  },
  reset(employeeId: string, signal?: AbortSignal): Promise<ChatHistoryResponse> {
    return api<ChatHistoryResponse>("/api/chat/reset", {
      method: "POST",
      body: JSON.stringify({ employeeId }),
      signal,
    });
  },
  subscribe(
    employeeId: string,
    onEvent: (event: ChatLiveEvent) => void,
  ): () => void {
    if (typeof EventSource === "undefined") {
      return () => {};
    }

    const query = new URLSearchParams({ employeeId });
    const source = new EventSource(`${API_BASE}/api/chat/events?${query}`, {
      withCredentials: true,
    });
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data) as ChatLiveEvent);
      } catch {
        /* ignore malformed live events */
      }
    };
    return () => source.close();
  },
};
