import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient } from "./llm-client.js";
import {
  recordLlmUsage,
  type ComposeLlmBilling,
} from "./llm-usage.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import type { ComposeFactsBundle } from "./compose-facts.js";

/**
 * One outbound WhatsApp compose path. Optional facts come from compose-facts
 * loaders (git_log / saved_data); creative clocks have no facts block.
 * Conditional watches skip fixedBody short-circuit and get tips + gender.
 */
export async function composeScheduledOutbound(input: {
  brief: string;
  itemLabel: string;
  actorName: string;
  recipientName: string;
  previousText?: string;
  facts?: ComposeFactsBundle;
  /** Conditional watch fire — styled tip message, use FACTS not raw fixedBody. */
  watch?: boolean;
  addressGender?: "male" | "female" | null;
  /** When set, records LlmUsages with purpose=reminder_compose. */
  billing?: ComposeLlmBilling | null;
}): Promise<string | null> {
  const brief = input.brief.trim() || input.itemLabel.trim();
  const bundle = input.facts;
  const facts = bundle?.facts?.trim() ?? "";
  const kind = bundle?.kind ?? "creative";
  const isWatch = input.watch === true;
  if (!isWatch && bundle?.fixedBody?.trim()) {
    return bundle.fixedBody.trim().slice(0, 4096);
  }
  if (!brief && !facts && !bundle?.fixedBody?.trim()) {
    return null;
  }

  const hasFacts = Boolean(facts) || Boolean(bundle?.fixedBody?.trim());
  const factsBlock = facts || bundle?.fixedBody?.trim() || "";

  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const openaiConversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId: openaiConversationId,
      model: config.model,
      temperature: hasFacts ? (isWatch ? 0.55 : 0.4) : 1,
      instructions: [
        "You write one outbound WhatsApp message.",
        "Output ONLY the message body. No JSON, no quotes, no preamble.",
        "Language: follow the brief (Hebrew or English). If unclear, prefer the brief's language; default Hebrew for product status, English for code digests when the brief is English.",
        hasFacts
          ? "Answer ONLY from the FACTS block (and SESSION_CLOCK / time window when present). Do not invent facts absent from that block."
          : "No FACTS block — invent the message from the brief alone (greeting, joke, note, etc.).",
        "Do not claim you saved, updated, or sent anything else — this turn is message-only.",
        "Keep it readable WhatsApp text. Bold with single *asterisks* when useful.",
        ...composeKindHints(kind, isWatch),
        ...addressGenderHints(input.addressGender),
      ].join("\n"),
      message: [
        `Sender: ${input.actorName || (hasFacts ? "someone" : "מישהו")}`,
        `Recipient: ${input.recipientName || (hasFacts ? "teammate" : "הנמען")}`,
        `Clock label: ${input.itemLabel || "scheduled message"}`,
        `Brief / question to answer now: ${brief || "(follow FACTS)"}`,
        isWatch
          ? "Mode: CONDITIONAL WATCH alert — the watched condition just became true. Open with לבקשתך…, state the update from FACTS, and add one short practical tip when natural (umbrella when rain, etc.). Do not invent numbers."
          : "",
        bundle?.sessionClock?.trim()
          ? `SESSION_CLOCK:\n${bundle.sessionClock.trim()}`
          : "",
        bundle?.windowLabel?.trim()
          ? `Time window: ${bundle.windowLabel.trim()}`
          : "",
        hasFacts
          ? `${bundle?.factsLabel || "FACTS"}:\n${factsBlock}`
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
    if (input.billing) {
      await recordLlmUsage({
        conversationId: input.billing.conversationId,
        employeeId: input.billing.employeeId,
        digitalEmployeeId: input.billing.digitalEmployeeId,
        openaiConversationId,
        model: config.model,
        turn,
        purpose: "reminder_compose",
      });
    }
    const text = turn.reply.trim();
    if (!text) {
      if (isWatch && bundle?.fixedBody?.trim()) {
        return bundle.fixedBody.trim().slice(0, 4096);
      }
      return null;
    }
    recordWhatsAppEvent(
      "reminder_compose_ok",
      `item=${input.itemLabel.slice(0, 40)} chars=${text.length} kind=${kind} watch=${isWatch}`,
    );
    return text.slice(0, 4096);
  } catch (error) {
    recordWhatsAppEvent(
      "reminder_compose_fail",
      error instanceof Error ? error.message : "unknown",
    );
    if (isWatch && bundle?.fixedBody?.trim()) {
      return bundle.fixedBody.trim().slice(0, 4096);
    }
    return null;
  }
}

function addressGenderHints(
  gender: "male" | "female" | null | undefined,
): string[] {
  if (gender === "female") {
    return [
      "Recipient address gender: female — use feminine Hebrew (את, תשכחי, לכי).",
    ];
  }
  if (gender === "male") {
    return [
      "Recipient address gender: male — use masculine Hebrew (אתה, תשכח, לך).",
    ];
  }
  return [
    "Recipient address gender: unknown — prefer neutral / plural when possible (תזכרו, אפשר לקחת).",
  ];
}

/**
 * Live weather ask tip: one short practical tip from FACTS only.
 * Returns null on failure — caller sends facts alone (never invent tip copy in code).
 */
export async function composeWeatherLiveTip(input: {
  factsBody: string;
  addressGender?: "male" | "female" | null;
  /** When set, records LlmUsages with purpose=weather_tip. */
  billing?: ComposeLlmBilling | null;
}): Promise<string | null> {
  const facts = input.factsBody.trim();
  if (!facts) {
    return null;
  }
  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const openaiConversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId: openaiConversationId,
      model: config.model,
      temperature: 0.85,
      instructions: [
        "You write one short personal weather tip for WhatsApp.",
        "Output ONLY the tip sentence(s). No JSON, no quotes, no preamble, no bullet list of forecast numbers.",
        "Language: Hebrew.",
        "Ground the tip ONLY in the FACTS block (e.g. cold → warm clothes, rain → umbrella, heat → water/shade, wind → hold hat).",
        "Do not invent temperatures, wind speeds, or conditions absent from FACTS.",
        "Do not restate the full forecast — tip only, 1–2 short sentences.",
        "Vary your wording every run (freshness token below).",
        ...addressGenderHints(input.addressGender),
      ].join("\n"),
      message: [
        "FACTS (weather already fetched — tip from these only):",
        facts,
        `Freshness token (vary wording): ${freshness}`,
        "Write the tip now.",
      ].join("\n"),
    });
    if (input.billing) {
      await recordLlmUsage({
        conversationId: input.billing.conversationId,
        employeeId: input.billing.employeeId,
        digitalEmployeeId: input.billing.digitalEmployeeId,
        openaiConversationId,
        model: config.model,
        turn,
        purpose: "weather_tip",
      });
    }
    const text = turn.reply.trim();
    if (!text) {
      return null;
    }
    recordWhatsAppEvent(
      "weather_live_tip_ok",
      `chars=${text.length}`,
    );
    return text.slice(0, 500);
  } catch (error) {
    recordWhatsAppEvent(
      "weather_live_tip_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return null;
  }
}

function composeKindHints(
  kind: ComposeFactsBundle["kind"],
  isWatch: boolean,
): string[] {
  const watchExtra = isWatch
    ? [
        "Watch tip: one short actionable tip tied to the FACTS is encouraged; keep the whole message under ~4 short lines.",
      ]
    : [];
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
  if (kind === "weather") {
    return [
      "Weather: use ONLY temperatures/conditions from FACTS; do not invent numbers.",
      ...watchExtra,
    ];
  }
  if (kind === "market") {
    return [
      "Market: use ONLY prices/percents from FACTS; do not invent numbers. Not investment advice.",
      ...watchExtra,
    ];
  }
  if (kind === "mashov") {
    return [
      "Mashov: use ONLY grades/homework/behavior/absences/messages from FACTS; never invent or repeat passwords.",
      ...watchExtra,
    ];
  }
  return [
    "Creative/fixed-brief send: second person when messaging them; for a joke to the speaker, just tell the joke.",
    "Every run must be NEW. Never repeat a previous joke or the same punchline.",
    "If the brief says בדיחה / עדות and does not mention בית משפט / משפט / עד בבית משפט: treat עדות as ethnic communities (אשכנזים, ספרדים, מזרחים, תימנים, etc.) — NOT courtroom testimony.",
    ...watchExtra,
  ];
}
