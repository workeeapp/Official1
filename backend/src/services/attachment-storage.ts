import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { getEnv } from "../config/env.js";

export interface AttachmentStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  getStream(key: string): Readable;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorage implements AttachmentStorage {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    const root = resolve(this.root);
    const full = resolve(root, key);
    if (!full.startsWith(root + sep)) {
      throw new Error("Invalid storage key");
    }
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  getStream(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

let override: AttachmentStorage | null = null;
let cached: AttachmentStorage | null = null;

export function setAttachmentStorageForTests(storage: AttachmentStorage | null): void {
  override = storage;
}

export function getAttachmentStorage(): AttachmentStorage {
  if (override) {
    return override;
  }
  cached ??= new LocalDiskStorage(resolve(process.cwd(), getEnv().UPLOADS_DIR));
  return cached;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export function extensionForMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_MIME[base] ?? "bin";
}

/** `userId/yyyy/mm/<uuid>.<ext>` — never derived from the sender's file name. */
export function attachmentStorageKey(
  userId: string,
  attachmentId: string,
  mimeType: string,
  now = new Date(),
): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${userId}/${year}/${month}/${attachmentId}.${extensionForMime(mimeType)}`;
}
