import type { ChatMessageRequest, ChatMessageResponse } from "@workee/shared";
import { api } from "./http";

export const chatApi = {
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
};
