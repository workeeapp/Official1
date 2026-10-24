import type { Request, Response } from "express";
import {
  ingestUploadedBytes,
  openAttachmentContent,
  toChatAttachmentRef,
} from "../services/attachment.service.js";
import { ValidationError, NotFoundError, UnauthorizedError } from "../utils/errors.js";
import { ATTACHMENT_MAX_BYTES } from "@workee/shared";

function contentDisposition(inline: boolean, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** POST /api/attachments — JSON { employeeId, fileName, mimeType, contentBase64, caption? }. */
export async function uploadAttachment(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }
  const body = req.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    throw new ValidationError("Attachment body is required", {
      body: "Required",
    });
  }
  const employeeId = String(body.employeeId ?? "").trim();
  const fileName = String(body.fileName ?? body.file_name ?? "upload").trim();
  const mimeType = String(body.mimeType ?? body.mime_type ?? "").trim();
  const caption = String(body.caption ?? "").trim();
  const b64 = String(body.contentBase64 ?? body.content_base64 ?? "").trim();
  if (!employeeId) {
    throw new ValidationError("Employee is required", {
      employeeId: "Required",
    });
  }
  if (!b64) {
    throw new ValidationError("File content is required", {
      contentBase64: "Required",
    });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
  } catch {
    throw new ValidationError("Invalid base64 content", {
      contentBase64: "Invalid",
    });
  }
  const hardCap = Math.max(...Object.values(ATTACHMENT_MAX_BYTES));
  if (!bytes.length || bytes.length > hardCap) {
    throw new ValidationError("File too large or empty", {
      contentBase64: "Size",
    });
  }
  const row = await ingestUploadedBytes({
    userId: req.user.id,
    uploaderId: employeeId,
    bytes,
    mimeType: mimeType || "application/octet-stream",
    fileName,
    caption,
  });
  if (!row) {
    throw new ValidationError("Could not store attachment", {
      contentBase64: "Rejected",
    });
  }
  res.status(201).json({ attachment: toChatAttachmentRef(row) });
}

export async function getAttachmentContent(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const id = typeof req.params.id === "string" ? req.params.id : "";
  const content = await openAttachmentContent(req.user.id, id);
  if (!content) {
    throw new NotFoundError();
  }

  res.status(200);
  res.setHeader("Content-Type", content.mimeType);
  if (content.sizeBytes > 0) {
    res.setHeader("Content-Length", String(content.sizeBytes));
  }
  res.setHeader("Content-Disposition", contentDisposition(content.inline, content.fileName));
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!content.mimeType.toLowerCase().startsWith("application/pdf")) {
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  }
  res.setHeader("Cache-Control", "private, max-age=3600");

  await new Promise<void>((resolve) => {
    content.stream.on("error", () => {
      if (!res.headersSent) {
        res.status(404).end();
      } else {
        res.destroy();
      }
      resolve();
    });
    content.stream.on("end", () => resolve());
    res.on("close", () => {
      content.stream.destroy();
      resolve();
    });
    content.stream.pipe(res);
  });
}
