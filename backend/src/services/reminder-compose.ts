import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient } from "./llm-client.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export async function composeScheduledOutbound(input: {
  brief: string;
  itemLabel: string;
  actorName: string;
  recipientName: string;
  previousText?: string;
  /** When set, summarize these commits into an English product digest. */
  gitChangelog?: string;
}): Promise<string | null> {
  const brief = input.brief.trim() || input.itemLabel.trim();
  const gitLog = input.gitChangelog?.trim() ?? "";
  if (!brief && !gitLog) {
    return null;
  }

  const isGitDigest = Boolean(gitLog);

  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const conversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId,
      model: config.model,
      temperature: isGitDigest ? 0.4 : 1,
      instructions: isGitDigest
        ? [
            "You write one outbound WhatsApp message in English.",
            "Output ONLY the message body. No JSON, no quotes, no preamble.",
            "Summarize product/user-facing changes: features, bug fixes, behavior.",
            "Keep it clear and moderately detailed — not a raw git log, not dump of SHAs/paths/diffs.",
            "Use 2–6 short bullets or short paragraphs. Do not invent changes absent from the commit list.",
            "Address the recipient in second person when natural.",
          ].join("\n")
        : [
            "You write one outbound WhatsApp message.",
            "Output ONLY the message body in Hebrew (unless the brief asks another language).",
            "No JSON, no quotes, no preamble, no numbering.",
            "Second person to the recipient when it is a message to them. For a joke to the speaker, just tell the joke.",
            "Follow the brief; do not invent a different task.",
            "Every run must be NEW. Never repeat a previous joke or the same punchline.",
            "If the brief says בדיחה / עדות and does not mention בית משפט / משפט / עד בבית משפט: treat עדות as ethnic communities (אשכנזים, ספרדים, מזרחים, תימנים, etc.) — NOT courtroom testimony.",
          ].join("\n"),
      message: isGitDigest
        ? [
            `Sender: ${input.actorName || "someone"}`,
            `Recipient: ${input.recipientName || "teammate"}`,
            `Clock label: ${input.itemLabel || "dev digest"}`,
            `Brief: ${brief || "Summarize what we shipped since the last report in clear English."}`,
            "Commit notes (internal source — do not paste verbatim as a log):",
            gitLog,
            input.previousText?.trim()
              ? `Previous digest (avoid repeating the same wording):\n${input.previousText.trim()}`
              : "No previous digest on file.",
            "Write the WhatsApp digest now.",
          ].join("\n")
        : [
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
      `item=${input.itemLabel.slice(0, 40)} chars=${text.length} git=${isGitDigest}`,
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
