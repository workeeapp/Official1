import { attachmentContentUrl, type ChatAttachmentRef } from "@workee/shared";
import { api, apiUrl } from "./http";

export const attachmentApi = {
  contentUrl(id: string): string {
    return apiUrl(attachmentContentUrl(id));
  },

  /** Upload a local file for the next chat turn (JSON base64). */
  async upload(input: {
    employeeId: string;
    file: File;
    caption?: string;
    signal?: AbortSignal;
  }): Promise<ChatAttachmentRef> {
    const buffer = await input.file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const contentBase64 = btoa(binary);
    const res = await api<{ attachment: ChatAttachmentRef }>("/api/attachments", {
      method: "POST",
      body: JSON.stringify({
        employeeId: input.employeeId,
        fileName: input.file.name,
        mimeType: input.file.type || "application/octet-stream",
        contentBase64,
        ...(input.caption ? { caption: input.caption } : {}),
      }),
      signal: input.signal,
    });
    return res.attachment;
  },
};
