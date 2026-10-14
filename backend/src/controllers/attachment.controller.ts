import type { Request, Response } from "express";
import { openAttachmentContent } from "../services/attachment.service.js";
import { NotFoundError, UnauthorizedError } from "../utils/errors.js";

function contentDisposition(inline: boolean, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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
