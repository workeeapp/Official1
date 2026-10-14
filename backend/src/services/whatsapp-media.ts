import { getEnv } from "../config/env.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

const GRAPH = "https://graph.facebook.com/v22.0";

export interface DownloadedWhatsAppMedia {
  bytes: Buffer;
  mimeType: string;
  sha256: string;
}

function graphCredentials(): { token: string; phoneNumberId: string } {
  const env = getEnv();
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    throw new ServiceUnavailableError();
  }
  return { token, phoneNumberId };
}

/**
 * Inbound media: GET /{media-id} returns a short-lived url (about 5 minutes),
 * which is fetched with the same Bearer token.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  maxBytes: number,
): Promise<DownloadedWhatsAppMedia> {
  const { token } = graphCredentials();
  const metaResponse = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaResponse.ok) {
    recordWhatsAppEvent("media_meta_fail", `status=${metaResponse.status}`);
    throw new ServiceUnavailableError();
  }
  const meta = (await metaResponse.json()) as {
    url?: unknown;
    mime_type?: unknown;
    file_size?: unknown;
    sha256?: unknown;
  };
  const url = typeof meta.url === "string" ? meta.url : "";
  if (!url) {
    throw new ServiceUnavailableError();
  }
  const declaredSize = typeof meta.file_size === "number" ? meta.file_size : 0;
  if (declaredSize > maxBytes) {
    throw new MediaTooLargeError();
  }

  const fileResponse = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileResponse.ok) {
    recordWhatsAppEvent("media_download_fail", `status=${fileResponse.status}`);
    throw new ServiceUnavailableError();
  }
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new MediaTooLargeError();
  }
  return {
    bytes,
    mimeType: typeof meta.mime_type === "string" ? meta.mime_type : "",
    sha256: typeof meta.sha256 === "string" ? meta.sha256 : "",
  };
}

/** Outbound media: upload our copy and get a media id usable for about 30 days. */
export async function uploadWhatsAppMedia(input: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<string> {
  const { token, phoneNumberId } = graphCredentials();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", input.mimeType);
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
    input.fileName || "file",
  );
  const response = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) {
    recordWhatsAppEvent("media_upload_fail", `status=${response.status}`);
    throw new ServiceUnavailableError();
  }
  const json = (await response.json()) as { id?: unknown };
  if (typeof json.id !== "string" || !json.id) {
    throw new ServiceUnavailableError();
  }
  return json.id;
}

export class MediaTooLargeError extends Error {
  constructor() {
    super("Media too large");
    this.name = "MediaTooLargeError";
  }
}
