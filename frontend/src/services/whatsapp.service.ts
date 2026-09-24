import type { WhatsAppStatusResponse } from "@workee/shared";
import { api } from "./http";

export const whatsappApi = {
  status(signal?: AbortSignal): Promise<WhatsAppStatusResponse> {
    return api<WhatsAppStatusResponse>("/api/whatsapp/status", { signal });
  },
};
