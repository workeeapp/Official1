import { attachmentContentUrl } from "@workee/shared";
import { apiUrl } from "./http";

export const attachmentApi = {
  contentUrl(id: string): string {
    return apiUrl(attachmentContentUrl(id));
  },
};
