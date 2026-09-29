import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient } from "./llm-client.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export async function composeScheduledOutbound(input: {
  brief: string;
  itemLabel: string;
  actorName: string;
  recipientName: string;
  previousText?: string;
}): Promise<string | null> {
  const brief = input.brief.trim() || input.itemLabel.trim();
  if (!brief) {
    return null;
  }

  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const conversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId,
      model: config.model,
      temperature: 1,
      instructions: [
        "You write one outbound WhatsApp message.",
        "Output ONLY the message body in Hebrew (unless the brief asks another language).",
        "No JSON, no quotes, no preamble, no numbering.",
        "Second person to the recipient when it is a message to them. For a joke to the speaker, just tell the joke.",
        "Follow the brief; do not invent a different task.",
        "Every run must be NEW. Never repeat a previous joke or the same punchline.",
        "If the brief says בדיחה / עדות and does not mention בית משפט / משפט / עד בבית משפט: treat עדות as ethnic communities (אשכנזים, ספרדים, מזרחים, תימנים, etc.) — NOT courtroom testimony.",
      ].join("\n"),
      message: [
        `Sender: ${input.actorName || "מישהו"}`,
        `Recipient: ${input.recipientName || "הנמען"}`,
        `Clock label: ${input.itemLabel || "הודעה מתוזמנת"}`,
        `Brief / instruction: ${brief}`,
        input.previousText?.trim()
          ? `Do NOT repeat or lightly rephrase this previous send:\n${input.previousText.trim()}`
          : "No previous send on file — invent a fresh one.",
        `Freshness token (vary your wording): ${freshness}`,
        "Write the final message now.",
      ].join("\n"),
    });
    const text = turn.reply.trim();
    if (!text) {
      return null;
    }
    recordWhatsAppEvent(
      "reminder_compose_ok",
      `item=${input.itemLabel.slice(0, 40)} chars=${text.length}`,
    );
    return text.slice(0, 4096);
  } catch (error) {
    recordWhatsAppEvent(
      "reminder_compose_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return null;
  }
}
