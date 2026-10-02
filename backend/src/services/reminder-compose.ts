import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient } from "./llm-client.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export async function composeScheduledOutbound(input: {
  brief: string;
  itemLabel: string;
  actorName: string;
  recipientName: string;
  previousText?: string;
  /** When set, summarize these commits into a product digest. */
  gitChangelog?: string;
  /** Human label for the commit window (e.g. last 7 days / since last report). */
  gitWindowLabel?: string;
  /** Live EMPLOYEE_SAVED_DATA (+ contacts) for status / list answers at fire. */
  savedDataContext?: string;
  /** Asia/Jerusalem clock label for "today/tomorrow" briefs. */
  sessionClock?: string;
}): Promise<string | null> {
  const brief = input.brief.trim() || input.itemLabel.trim();
  const gitLog = input.gitChangelog?.trim() ?? "";
  const savedData = input.savedDataContext?.trim() ?? "";
  if (!brief && !gitLog && !savedData) {
    return null;
  }

  const isGitDigest = Boolean(gitLog);
  const isSavedData = Boolean(savedData) && !isGitDigest;

  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const conversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId,
      model: config.model,
      temperature: isGitDigest || isSavedData ? 0.4 : 1,
      instructions: isGitDigest
        ? [
            "You write one outbound WhatsApp message.",
            "Output ONLY the message body. No JSON, no quotes, no preamble.",
            "Language: follow the brief (Hebrew or English). If unclear, use the brief's language; default English.",
            "Summarize product/user-facing changes from the commit notes: features, bug fixes, behavior.",
            "Coverage rules (important):",
            "- Prefer completeness over brevity when several distinct capabilities appear.",
            "- Use 4–10 short bullets when needed; one distinct capability per bullet.",
            "- Do NOT merge unrelated features into one vague line.",
            "- If commits mention injecting scheduled/reminder outbound into chat context, session clock / today-tomorrow-week day plans, cancel holds, privacy/visibility, filings memory — call those out explicitly.",
            "- Do not invent changes absent from the commit list.",
            "Keep it readable WhatsApp text — not SHAs, not a raw git log dump.",
            "Address the recipient in second person when natural.",
            "Respect the stated time window label when framing the intro (e.g. since last report / last 7 days).",
          ].join("\n")
        : isSavedData
          ? [
              "You write one outbound WhatsApp message.",
              "Output ONLY the message body. No JSON, no quotes, no preamble, no schema jargon.",
              "Language: follow the brief (Hebrew or English). Default Hebrew if unclear.",
              "Answer ONLY from the saved-data facts below (and SESSION_CLOCK for today/tomorrow/weekday).",
              "Follow the brief: tasks / shopping / full dump / what X needs on a day — filter accordingly.",
              "For אני/שלי about the recipient: only THEIR own rows (owner matches them).",
              "For another named person: only that owner's visible rows.",
              "Format: short intro + one • item per line. Empty → one plain sentence that there is nothing.",
              "Do not invent items. Do not claim you saved/updated/sent anything else — this turn is answer-only.",
              "Bold with single *asterisks* when useful (WhatsApp).",
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
            `Brief: ${brief || "Summarize what we shipped in the window below."}`,
            `Time window: ${input.gitWindowLabel || "recent commits"}`,
            "Commit notes (internal source — do not paste verbatim as a log):",
            gitLog,
            input.previousText?.trim()
              ? `Previous digest (avoid repeating the same wording when covering overlapping commits):\n${input.previousText.trim()}`
              : "No previous digest on file.",
            "Write the WhatsApp digest now. Cover distinct capabilities from the commits.",
          ].join("\n")
        : isSavedData
          ? [
              `Sender: ${input.actorName || "מישהו"}`,
              `Recipient: ${input.recipientName || "הנמען"}`,
              `Clock label: ${input.itemLabel || "סטטוס מתוזמן"}`,
              `Brief / question to answer now: ${brief || "מה שמור לי עכשיו?"}`,
              input.sessionClock?.trim()
                ? `SESSION_CLOCK:\n${input.sessionClock.trim()}`
                : "SESSION_CLOCK: Asia/Jerusalem (use now for today/tomorrow).",
              "Saved facts (internal — answer from these only):",
              savedData,
              input.previousText?.trim()
                ? `Previous status send (vary wording if overlapping):\n${input.previousText.trim()}`
                : "No previous status send on file.",
              "Write the WhatsApp answer now.",
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
      `item=${input.itemLabel.slice(0, 40)} chars=${text.length} git=${isGitDigest} saved=${isSavedData}`,
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
