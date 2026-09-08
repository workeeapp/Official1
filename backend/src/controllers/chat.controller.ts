import type { Request, Response } from "express";
import { sendChatMessage } from "../services/chat.service.js";
import { parseChatMessageBody } from "../validation/chat.validation.js";
import { UnauthorizedError } from "../utils/errors.js";

export async function sendMessage(req: Request, res: Response): Promise<void> {
  if (!req.user || !req.sessionId) {
    throw new UnauthorizedError();
  }

  const { message, employeeId } = parseChatMessageBody(req.body);
  const { reply, raw } = await sendChatMessage({
    sessionId: req.sessionId,
    userId: req.user.id,
    employeeId,
    message,
  });

  res.status(200).json({ reply, raw });
}
