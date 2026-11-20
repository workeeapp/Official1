/**
 * Slice 1 — thin Prospect goals brief for First Interaction.
 * Goals + boundaries only. Not an Opening playbook or capability catalog.
 */

/** Soft budget: keep the brief short (goals, not scripts). */
export const PROSPECT_GOALS_BRIEF_MAX_CHARS = 2200;

export const PROSPECT_GOALS_MARKER = "PROSPECT_GOALS";

const PLAYBOOK_MARKERS_RE =
  /First reply|Turn\s*1|You must greet|numbered dialogue|Step\s*1:/i;

/**
 * Inject for Prospects only. Members never get this block.
 * Invite Opening (if any) is a separate facts block — this brief stays generic.
 */
export function shouldInjectProspectGoalsBrief(input: {
  isProspect: boolean;
}): boolean {
  return input.isProspect === true;
}

/**
 * Fixed goals brief — conversational north star for the model, not turn choreography.
 */
export function formatProspectGoalsBrief(): string {
  return [
    `${PROSPECT_GOALS_MARKER} (speaker consent still pending — conversational goals, not a script):`,
    "- Help them discover real value in natural chat across what you can actually do: organize (lists incl. fitting custom ones, tasks, reminders, plans); save & retrieve personal info/files when supported; watch/alert on relevant changes when supported; and personalize help from context — without turning this into a feature catalog.",
    "- On a bare greeting or open start with no ask yet: warm brief reply that already hints at real help with one concrete example and a natural question — not a one-word hi and not a brochure.",
    "- Notice unspoken needs when the conversation implies them; offer a fitting capability only when it would truly help and is available now; never push generic lists or unsupported save/watch/retrieve.",
    "- If they are unsure what to ask, clarify with a short concrete example and a natural question; adapt; guide toward one real action when they are ready.",
    "- You may chat, answer, and use capabilities that do not require durable personal saves.",
    "- FORBIDDEN: asking them to join/register/approve terms; claiming personal data was saved when it was not; promising monitoring, filing, or retrieval you cannot perform for them; dumping a long brochure.",
    "- When they ask for a durable personal save, proceed with normal action metadata; the engine handles consent/Join — do not narrate a signup wall.",
  ].join("\n");
}

/** Test / guard helpers — fail closed if the brief drifts into a playbook. */
export function prospectGoalsBriefViolatesBudget(text: string): boolean {
  return text.length > PROSPECT_GOALS_BRIEF_MAX_CHARS;
}

export function prospectGoalsBriefLooksLikePlaybook(text: string): boolean {
  return PLAYBOOK_MARKERS_RE.test(text);
}
