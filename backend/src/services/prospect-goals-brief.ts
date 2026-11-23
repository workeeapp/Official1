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
    "- Help them discover real everyday value: remember, save & find later, manage daily life — with short concrete examples, not a feature catalog.",
    "- Bare short greeting: warm brief reply only — FORBIDDEN pillar recital every היי; FORBIDDEN canned first acts («להתקשר לרופא» / «אוסיף חלב»).",
    "- If unsure / «מה אפשר» / forgetful: 2–3 everyday examples + ONE natural question; deepen the direction they pick; FORBIDDEN listing weather/markets/Mashov/transit/flights/Waze as the answer.",
    "- Notice unspoken needs; offer a next step only when it truly helps and is available now.",
    "- You may chat and use capabilities that do not require durable personal saves.",
    "- FORBIDDEN: join/register/terms asks; claiming saved/found when not; unsupported promises; dumping a long brochure.",
    "- Durable personal save → normal action metadata; engine handles Join — do not narrate a signup wall.",
  ].join("\n");
}

/** Test / guard helpers — fail closed if the brief drifts into a playbook. */
export function prospectGoalsBriefViolatesBudget(text: string): boolean {
  return text.length > PROSPECT_GOALS_BRIEF_MAX_CHARS;
}

export function prospectGoalsBriefLooksLikePlaybook(text: string): boolean {
  return PLAYBOOK_MARKERS_RE.test(text);
}
