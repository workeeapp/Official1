import type { Request, Response } from "express";
import { subscribeChatEvents } from "../services/chat-events.service.js";
import {
  getChatHistory,
  requireDigitalChatPartner,
  resetChatConversation,
  sendChatMessage,
} from "../services/chat.service.js";
import { getEmployeeForUser } from "../services/employee.service.js";
import {
  parseChatMessageBody,
  parseChatPairBody,
  parseEmployeeIdQuery,
  parseOptionalEmployeeId,
} from "../validation/chat.validation.js";
import { UnauthorizedError } from "../utils/errors.js";

export async function listMessages(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employeeId = parseEmployeeIdQuery(req.query.employeeId);
  const digitalEmployeeId = parseOptionalEmployeeId(req.query.digitalEmployeeId);
  const history = await getChatHistory(req.user.id, employeeId, digitalEmployeeId);
  res.status(200).json(history);
}

export async function sendMessage(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const { message, employeeId, digitalEmployeeId } = parseChatMessageBody(req.body);
  const { reply, raw, notifications } = await sendChatMessage({
    userId: req.user.id,
    employeeId,
    digitalEmployeeId,
    message,
  });

  res.status(200).json({ reply, raw, notifications });
}

export async function resetConversation(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const { employeeId, digitalEmployeeId } = parseChatPairBody(req.body);
  const history = await resetChatConversation(req.user.id, employeeId, digitalEmployeeId);
  res.status(200).json(history);
}

export async function streamChatEvents(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const employeeId = parseEmployeeIdQuery(req.query.employeeId);
  const digitalEmployeeId = parseOptionalEmployeeId(req.query.digitalEmployeeId);
  await getEmployeeForUser(req.user.id, employeeId);
  const digital = await requireDigitalChatPartner(req.user.id, digitalEmployeeId);
  const partnerId = digital.id;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  const unsubscribe = subscribeChatEvents(req.user.id, employeeId, partnerId, res);
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  await new Promise<void>((resolve) => {
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      resolve();
    });
  });
}
