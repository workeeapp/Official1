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
 * A failed inbound media fetch. `transient` = worth retrying (network error,
 * timeout, 408/425/429, 5xx); anything else (4xx, missing url) is permanent.
 */
export class MediaFetchError extends Error {
  constructor(
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(status ? `Media fetch failed (${status})` : "Media fetch failed");
    this.name = "MediaFetchError";
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchOrTransient(url: string, token: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // Network error / reset / DNS — the request never completed.
    throw new MediaFetchError(true);
  }
}

/**
 * Inbound media: GET /{media-id} returns a short-lived url (about 5 minutes),
 * which is fetched with the same Bearer token. One attempt; no side effects.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  maxBytes: number,
): Promise<DownloadedWhatsAppMedia> {
  const { token } = graphCredentials();
  const metaResponse = await fetchOrTransient(`${GRAPH}/${encodeURIComponent(mediaId)}`, token);
  if (!metaResponse.ok) {
    recordWhatsAppEvent("media_meta_fail", `status=${metaResponse.status}`);
    throw new MediaFetchError(isTransientStatus(metaResponse.status), metaResponse.status);
  }
  let meta: { url?: unknown; mime_type?: unknown; file_size?: unknown; sha256?: unknown };
  try {
    meta = (await metaResponse.json()) as typeof meta;
  } catch {
    throw new MediaFetchError(true);
  }
  const url = typeof meta.url === "string" ? meta.url : "";
  if (!url) {
    throw new MediaFetchError(false);
  }
  const declaredSize = typeof meta.file_size === "number" ? meta.file_size : 0;
  if (declaredSize > maxBytes) {
    throw new MediaTooLargeError();
  }

  const fileResponse = await fetchOrTransient(url, token);
  if (!fileResponse.ok) {
    recordWhatsAppEvent("media_download_fail", `status=${fileResponse.status}`);
    throw new MediaFetchError(isTransientStatus(fileResponse.status), fileResponse.status);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await fileResponse.arrayBuffer());
  } catch {
    // Body cut off mid-transfer.
    throw new MediaFetchError(true);
  }
  if (bytes.length > maxBytes) {
    throw new MediaTooLargeError();
  }
  return {
    bytes,
    mimeType: typeof meta.mime_type === "string" ? meta.mime_type : "",
    sha256: typeof meta.sha256 === "string" ? meta.sha256 : "",
  };
}

/** Waits before retry 1 and retry 2 (the initial attempt is not delayed). */
export const MEDIA_RETRY_DELAYS_MS = [500, 2_000] as const;

let retrySleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Tests only: replace the backoff wait (null restores the real timer). */
export function setMediaRetrySleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  retrySleep = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/**
 * downloadWhatsAppMedia with at most two retries after the initial attempt,
 * only for transient failures. Pure fetch: nothing is stored until it
 * succeeds, so a retry can never create a duplicate attachment.
 */
export async function downloadWhatsAppMediaWithRetry(
  mediaId: string,
  maxBytes: number,
): Promise<DownloadedWhatsAppMedia> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await downloadWhatsAppMedia(mediaId, maxBytes);
    } catch (error) {
      const retryable = error instanceof MediaFetchError && error.transient;
      const delay = MEDIA_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) {
        throw error;
      }
      recordWhatsAppEvent(
        "media_download_retry",
        `retry=${attempt + 1} status=${(error as MediaFetchError).status ?? "network"}`,
      );
      await retrySleep(delay);
    }
  }
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
