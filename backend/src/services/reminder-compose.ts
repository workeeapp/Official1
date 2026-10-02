import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient } from "./llm-client.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import type { ComposeFactsBundle } from "./compose-facts.js";

/**
 * One outbound WhatsApp compose path. Optional facts come from compose-facts
 * loaders (git_log / saved_data); creative clocks have no facts block.
 */
export async function composeScheduledOutbound(input: {
  brief: string;
  itemLabel: string;
  actorName: string;
  recipientName: string;
  previousText?: string;
  facts?: ComposeFactsBundle;
}): Promise<string | null> {
  const brief = input.brief.trim() || input.itemLabel.trim();
  const bundle = input.facts;
  const facts = bundle?.facts?.trim() ?? "";
  const kind = bundle?.kind ?? "creative";
  if (bundle?.fixedBody?.trim()) {
    return bundle.fixedBody.trim().slice(0, 4096);
  }
  if (!brief && !facts) {
    return null;
  }

  const hasFacts = Boolean(facts);

  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const conversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId,
      model: config.model,
      temperature: hasFacts ? 0.4 : 1,
      instructions: [
        "You write one outbound WhatsApp message.",
        "Output ONLY the message body. No JSON, no quotes, no preamble.",
        "Language: follow the brief (Hebrew or English). If unclear, prefer the brief's language; default Hebrew for product status, English for code digests when the brief is English.",
        hasFacts
          ? "Answer ONLY from the FACTS block (and SESSION_CLOCK / time window when present). Do not invent facts absent from that block."
          : "No FACTS block — invent the message from the brief alone (greeting, joke, note, etc.).",
        "Do not claim you saved, updated, or sent anything else — this turn is message-only.",
        "Keep it readable WhatsApp text. Bold with single *asterisks* when useful.",
        ...composeKindHints(kind),
      ].join("\n"),
      message: [
        `Sender: ${input.actorName || (hasFacts ? "someone" : "מישהו")}`,
        `Recipient: ${input.recipientName || (hasFacts ? "teammate" : "הנמען")}`,
        `Clock label: ${input.itemLabel || "scheduled message"}`,
        `Brief / question to answer now: ${brief || "(follow FACTS)"}`,
        bundle?.sessionClock?.trim()
          ? `SESSION_CLOCK:\n${bundle.sessionClock.trim()}`
          : "",
        bundle?.windowLabel?.trim()
          ? `Time window: ${bundle.windowLabel.trim()}`
          : "",
        hasFacts
          ? `${bundle?.factsLabel || "FACTS"}:\n${facts}`
          : "FACTS: (none — invent from the brief)",
        input.previousText?.trim()
          ? `Previous send (avoid repeating the same wording when covering overlapping content):\n${input.previousText.trim()}`
          : "No previous send on file.",
        hasFacts ? "" : `Freshness token (vary your wording): ${freshness}`,
        "Write the WhatsApp message now.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const text = turn.reply.trim();
    if (!text) {
      return null;
    }
    recordWhatsAppEvent(
      "reminder_compose_ok",
      `item=${input.itemLabel.slice(0, 40)} chars=${text.length} kind=${kind}`,
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

function composeKindHints(kind: ComposeFactsBundle["kind"]): string[] {
  if (kind === "git_log") {
    return [
      "Git digest: summarize product/user-facing changes from the commit notes.",
      "Prefer completeness; 4–10 short bullets; one distinct capability per bullet.",
      "Do not merge unrelated features into one vague line. Not SHAs / not a raw git log dump.",
      "Address the recipient in second person when natural. Respect the time window label in the intro.",
    ];
  }
  if (kind === "saved_data") {
    return [
      "Saved-data status: follow the brief (tasks / shopping / shared list / what X needs on a day / full dump).",
      "For אני/שלי about the recipient: only THEIR own rows (owner matches them).",
      "For another named person: only that owner's visible rows.",
      "Format: short intro + one • item per line. Empty → one plain sentence that there is nothing.",
      "No schema jargon (list_name, metadata, …).",
    ];
  }
  return [
    "Creative/fixed-brief send: second person when messaging them; for a joke to the speaker, just tell the joke.",
    "Every run must be NEW. Never repeat a previous joke or the same punchline.",
    "If the brief says בדיחה / עדות and does not mention בית משפט / משפט / עד בבית משפט: treat עדות as ethnic communities (אשכנזים, ספרדים, מזרחים, תימנים, etc.) — NOT courtroom testimony.",
  ];
}
