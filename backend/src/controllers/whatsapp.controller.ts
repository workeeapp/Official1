import type { Request, Response } from "express";
import {
  extractInboundTexts,
  handleInboundWhatsAppTexts,
  verifyWhatsAppWebhook,
  WhatsAppForbiddenError,
} from "../services/whatsapp.service.js";

export function verifyWebhook(req: Request, res: Response): void {
  try {
    const challenge = verifyWhatsAppWebhook({
      mode: stringQuery(req.query["hub.mode"]),
      token: stringQuery(req.query["hub.verify_token"]),
      challenge: stringQuery(req.query["hub.challenge"]),
    });
    res.status(200).type("text/plain").send(challenge);
  } catch (error) {
    if (error instanceof WhatsAppForbiddenError) {
      res.status(403).end();
      return;
    }
    throw error;
  }
}

export function receiveWebhook(req: Request, res: Response): void {
  const inbound = extractInboundTexts(req.body);
  console.log(`WhatsApp webhook POST fields=${webhookFields(req.body)}`);
  if (inbound.length > 0) {
    console.log(`WhatsApp inbound ${inbound.length} text message(s)`);
    void handleInboundWhatsAppTexts(inbound);
  }
  res.status(200).json({ status: "ok" });
}

function webhookFields(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "none";
  }
  const entry = (body as { object?: unknown; entry?: unknown }).entry;
  if (!Array.isArray(entry)) {
    return String((body as { object?: unknown }).object ?? "unknown");
  }
  const fields: string[] = [];
  for (const item of entry) {
    const changes = item && typeof item === "object" ? (item as { changes?: unknown }).changes : [];
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      if (change && typeof change === "object" && "field" in change) {
        fields.push(String((change as { field: unknown }).field));
      }
    }
  }
  return fields.join(",") || "empty";
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
