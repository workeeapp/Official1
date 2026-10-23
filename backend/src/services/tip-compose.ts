import { loadLlmConfig } from "../config/llm.js";
import { getLlmClient } from "./llm-client.js";
import {
  recordLlmUsage,
  type ComposeLlmBilling,
} from "./llm-usage.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export type TipComposeFacts = {
  list_type?: string | null;
  op?: string | null;
  item_label?: string | null;
  item_key?: string | null;
  /** Alias list of item labels from this turn (first = primary). */
  items?: string[];
};

const STATIC_TIP_TOKENS = [
  "item_label",
  "item_key",
  "list_type",
  "op",
  "items",
] as const;

type StaticTipToken = (typeof STATIC_TIP_TOKENS)[number];

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
    "Recipient address gender: unknown — prefer neutral / plural when possible (תזכרו, אפשר).",
  ];
}

/** Format turn FACTS for the constrained tip compose prompt. */
export function formatTipComposeFacts(facts: TipComposeFacts): string {
  const lines: string[] = [];
  if (facts.list_type?.trim()) {
    lines.push(`list_type: ${facts.list_type.trim()}`);
  }
  if (facts.op?.trim()) {
    lines.push(`op: ${facts.op.trim()}`);
  }
  const items = (facts.items ?? [])
    .map((row) => row.trim())
    .filter(Boolean);
  const label = facts.item_label?.trim() || items[0] || "";
  const key = facts.item_key?.trim() || label;
  if (label) {
    lines.push(`item_label: ${label}`);
  }
  if (key) {
    lines.push(`item_key: ${key}`);
  }
  if (items.length > 0) {
    lines.push(`items: ${items.join(", ")}`);
  } else if (label) {
    lines.push(`items: ${label}`);
  }
  return lines.join("\n");
}

function tokenValues(facts: TipComposeFacts): Record<StaticTipToken, string> {
  const items = (facts.items ?? [])
    .map((row) => row.trim())
    .filter(Boolean);
  const label = facts.item_label?.trim() || items[0] || "";
  const key = facts.item_key?.trim() || label;
  return {
    item_label: label,
    item_key: key,
    list_type: facts.list_type?.trim() || "",
    op: facts.op?.trim() || "",
    items: items.length > 0 ? items.join(", ") : label,
  };
}

/**
 * Static tip template: replace known `{token}`s from FACTS (no LLM).
 * Returns null if a known token in the template has an empty value.
 * Unknown `{foo}` left unchanged.
 */
export function renderStaticTipText(
  template: string,
  facts: TipComposeFacts,
): string | null {
  const text = template.trim();
  if (!text) {
    return null;
  }
  const values = tokenValues(facts);
  const known = new Set<string>(STATIC_TIP_TOKENS);
  const used = new Set<StaticTipToken>();
  for (const match of text.matchAll(/\{([a-z_]+)\}/g)) {
    const token = match[1];
    if (token && known.has(token)) {
      used.add(token as StaticTipToken);
    }
  }
  for (const token of used) {
    if (!values[token]) {
      return null;
    }
  }
  return text.replace(/\{([a-z_]+)\}/g, (full, token: string) => {
    if (!known.has(token)) {
      return full;
    }
    return values[token as StaticTipToken] || full;
  });
}

/**
 * Constrained catalog tip render: tip.text = author instructions; FACTS from apply.
 * Fresh OpenAI conversation — no Lucy prompt / chat history.
 * Returns null on failure or empty model output (caller skips tip, no TipProgress).
 * When billing is set, always records LlmUsages (purpose=catalog_tip) if tokens exist.
 */
export async function composeCatalogTip(input: {
  instructions: string;
  facts: TipComposeFacts;
  addressGender?: "male" | "female" | null;
  billing?: ComposeLlmBilling | null;
}): Promise<string | null> {
  const instructions = input.instructions.trim();
  if (!instructions) {
    return null;
  }
  const factsBlock = formatTipComposeFacts(input.facts).trim();
  try {
    const client = getLlmClient();
    const config = loadLlmConfig();
    const openaiConversationId = await client.createConversation();
    const freshness = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const turn = await client.createResponse({
      conversationId: openaiConversationId,
      model: config.model,
      temperature: 0.55,
      instructions: [
        "You write one short product tip for WhatsApp in Hebrew.",
        "Output ONLY the tip sentence(s), or an empty string if the AUTHOR INSTRUCTIONS say to skip / return empty.",
        "No JSON, no quotes wrapper, no preamble, no bullet list.",
        "Follow AUTHOR INSTRUCTIONS exactly. Ground names and details ONLY in the FACTS block.",
        "Do not invent product capabilities beyond what AUTHOR INSTRUCTIONS allow.",
        "Do not invent item names absent from FACTS.",
        "Prefer 1–2 short sentences.",
        ...addressGenderHints(input.addressGender),
      ].join("\n"),
      message: [
        "AUTHOR INSTRUCTIONS:",
        instructions,
        "",
        "FACTS (from this turn's applied actions — use only these):",
        factsBlock || "(none)",
        "",
        `Freshness token (vary wording when repeating the same idea): ${freshness}`,
        "Write the tip now (or empty if instructions say to skip).",
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
        purpose: "catalog_tip",
      });
    }
    const text = turn.reply.trim();
    if (!text) {
      return null;
    }
    recordWhatsAppEvent("catalog_tip_compose_ok", `chars=${text.length}`);
    return text.slice(0, 500);
  } catch (error) {
    recordWhatsAppEvent(
      "catalog_tip_compose_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return null;
  }
}
