/**
 * Capability Catalog (P1) — Engine-backed capabilities for tip Offer filtering.
 *
 * Distinct from {@link capabilities.registry.ts} (prompt-only «מה את יודעת לעשות»).
 * Only capabilities with a verified Engine path + durable evidence belong here.
 * Live-only domains without per-user evidence are intentionally omitted.
 */

/** Declarative matcher against a normalized {@link CapabilityEvidenceEvent}. */
export type CapabilityEvidenceMatcher = {
  /** Stable matcher id for tests / diagnostics. */
  id: string;
  /** Event kind that may prove this capability. */
  kind: CapabilityEvidenceKind;
  /**
   * Required attribute equality. Missing attr on the event → no match.
   * Booleans must match exactly (one-shot must not match recurring).
   */
  require?: Partial<CapabilityEvidenceAttrs>;
  /** If any of these attrs is true on the event → reject (near-miss guard). */
  rejectIf?: Partial<CapabilityEvidenceAttrs>;
};

export type CapabilityEvidenceKind =
  | "list.item_mutated"
  | "list.shared"
  | "filing.mutated"
  | "filing.media_linked"
  | "reminder.clock"
  | "directory.contact"
  | "directory.book_shared";

export type CapabilityEvidenceAttrs = {
  /** shopping | tasks | custom */
  listType?: string;
  /** add | update | remove */
  op?: string;
  /** Task / shopping item has data.__recurrence. */
  standing?: boolean;
  /** Tasks row looks like a timed meeting (date+time and/or שעת סיום). */
  meeting?: boolean;
  /** Reminder: structured or legacy recurrence (not once). */
  recurring?: boolean;
  /** Reminder: composeCondition present (Watch / UWM). */
  watch?: boolean;
  /** Reminder: composeAtFire digest / live compose source. */
  digest?: boolean;
  /** Reminder status active — for using via active state. */
  active?: boolean;
  /** visibleTo non-empty or scope !== personal. */
  shared?: boolean;
  /** AttachmentLink.filingId set. */
  hasMedia?: boolean;
};

export type CapabilityDef = {
  id: string;
  /** Verified Engine entry (service / function). */
  enginePath: string;
  /** Tip keys that discover or teach this capability. */
  tipKeys: readonly string[];
  /** Human-readable gates (documentation; not runtime-enforced in P1). */
  preconditions: readonly string[];
  /** When Offer is appropriate (documentation; Quiet rules enforced via familiarity). */
  whenToOffer: string;
  evidenceMatchers: readonly CapabilityEvidenceMatcher[];
  /**
   * Optional active-state matcher ids: a single matching active event
   * counts as `using` even without ≥2 historical matches.
   */
  activeUsingMatcherIds?: readonly string[];
};

/** Window for counting distinct evidence toward `using`. */
export const CAPABILITY_USING_WINDOW_DAYS = 90;

/** Distinct matching evidence events required for `using` (unless active state). */
export const CAPABILITY_USING_MIN_MATCHES = 2;

/**
 * Verified Engine capabilities only.
 * Soft-try tips (general / prospect / model) for a capability are suppressed
 * when familiarity is tried|using; action tips when using.
 */
export const CAPABILITY_CATALOG: readonly CapabilityDef[] = [
  {
    id: "shopping_list",
    enginePath: "employee-records.applyEmployeeRecords → ListItemMutation listType=shopping",
    tipKeys: [
      "shopping_basic_add",
      "shopping_basic_show",
      "shopping_mid_bought",
      "shopping_mid_qty",
      "shopping_mid_edit",
      "shopping_mid_delete",
      "prospect_onboard_shopping",
    ],
    preconditions: ["member or prospect speaker", "shopping list book"],
    whenToOffer: "After unrelated Act, or Prospect turn — not when tried/using shopping_list",
    evidenceMatchers: [
      {
        id: "shopping_item_mutated",
        kind: "list.item_mutated",
        require: { listType: "shopping" },
      },
    ],
  },
  {
    id: "tasks_list",
    enginePath: "employee-records.applyEmployeeRecords → ListItemMutation listType=tasks",
    tipKeys: [
      "tasks_basic_add",
      "tasks_basic_show",
      "tasks_mid_done",
      "tasks_mid_when",
      "tasks_mid_edit",
      "tasks_mid_delete",
      "prospect_onboard_tasks",
    ],
    preconditions: ["human-owned tasks list (not digital worker book alone)"],
    whenToOffer: "Soft-try when tasks_list not tried; action ladder until using",
    evidenceMatchers: [
      {
        id: "tasks_item_mutated",
        kind: "list.item_mutated",
        require: { listType: "tasks" },
        rejectIf: { standing: true, meeting: true },
      },
    ],
  },
  {
    id: "standing_tasks",
    enginePath: "list-recurrence → EmployeeListItem.data.__recurrence on tasks",
    tipKeys: ["tasks_adv_standing"],
    preconditions: ["tasks list", "recurrence rule on item"],
    whenToOffer: "After one-off task Act if standing_tasks not tried",
    evidenceMatchers: [
      {
        id: "tasks_standing",
        kind: "list.item_mutated",
        require: { listType: "tasks", standing: true },
      },
    ],
  },
  {
    id: "meetings_calendar",
    enginePath: "employee-records ListItemMutation tasks + meeting fields (שעה/שעת סיום)",
    tipKeys: [
      "meetings_basic_slot",
      "meetings_basic_ask",
      "meetings_mid_duration",
      "meetings_mid_allday",
      "meetings_adv_series",
      "meetings_mid_edit",
      "meetings_mid_occurrence",
      "meetings_mid_delete",
    ],
    preconditions: ["tasks row with date+time and/or שעת סיום"],
    whenToOffer: "After task Act when meetings_calendar not using",
    evidenceMatchers: [
      {
        id: "meeting_item",
        kind: "list.item_mutated",
        require: { listType: "tasks", meeting: true },
      },
    ],
  },
  {
    id: "custom_list",
    enginePath: "employee-records.applyEmployeeRecords → ListItemMutation listType=custom",
    tipKeys: [
      "custom_basic_named",
      "custom_basic_show",
      "custom_mid_more",
      "custom_mid_edit",
      "custom_mid_delete",
      "custom_adv_event",
    ],
    preconditions: ["named custom list"],
    whenToOffer: "When custom_list not tried",
    evidenceMatchers: [
      {
        id: "custom_item_mutated",
        kind: "list.item_mutated",
        require: { listType: "custom" },
      },
    ],
  },
  {
    id: "list_share",
    enginePath: "list_ops / shareOutcome / EmployeeList|Item.visibleTo",
    tipKeys: [
      "shopping_adv_share",
      "custom_mid_share",
      "filing_adv_share_nav",
    ],
    preconditions: ["shareable list/filing", "known peer target"],
    whenToOffer: "After personal list Act when list_share not tried",
    evidenceMatchers: [
      {
        id: "list_or_item_shared",
        kind: "list.shared",
        require: { shared: true },
      },
      {
        id: "filing_shared",
        kind: "filing.mutated",
        require: { shared: true },
      },
    ],
  },
  {
    id: "filing_store",
    enginePath: "employee-records.applyEmployeeRecords → FilingMutation",
    tipKeys: [
      "filing_basic_what",
      "filing_basic_ask",
      "filing_mid_update",
      "filing_mid_edit_op",
      "filing_mid_delete",
    ],
    preconditions: ["member speaker"],
    whenToOffer: "When filing_store not tried",
    evidenceMatchers: [
      {
        id: "filing_mutated",
        kind: "filing.mutated",
      },
    ],
  },
  {
    id: "filing_media",
    enginePath: "attachment.service → AttachmentLink.filingId",
    tipKeys: ["filing_mid_media", "general_filing_media_ask"],
    preconditions: ["attachment linked to EmployeeFiling"],
    whenToOffer: "Soft-try when filing_media not tried",
    evidenceMatchers: [
      {
        id: "filing_has_media",
        kind: "filing.media_linked",
        require: { hasMedia: true },
      },
    ],
  },
  {
    id: "reminder_one_shot",
    enginePath: "reminder.service.applyReminders → Reminder once (no recurrence/watch)",
    tipKeys: [
      "reminders_basic_store",
      "reminders_basic_ask",
      "reminders_mid_relative",
      "reminders_mid_exact",
      "reminders_mid_edit",
      "reminders_mid_delete",
      "prospect_onboard_reminders",
    ],
    preconditions: ["clock request with fireAt"],
    whenToOffer: "Soft-try when reminder_one_shot not tried; never claim recurring from this",
    evidenceMatchers: [
      {
        id: "reminder_once",
        kind: "reminder.clock",
        require: { recurring: false, watch: false, digest: false },
      },
    ],
  },
  {
    id: "reminder_recurring",
    enginePath: "reminder.service → Reminder.recurrence / repeat≠once (non-watch)",
    tipKeys: ["reminders_adv_repeat"],
    preconditions: ["recurrence rule or legacy repeat≠once", "not composeCondition watch"],
    whenToOffer: "After one-shot Act when reminder_recurring not tried",
    evidenceMatchers: [
      {
        id: "reminder_repeat",
        kind: "reminder.clock",
        require: { recurring: true, watch: false, digest: false },
      },
    ],
    activeUsingMatcherIds: ["reminder_repeat"],
  },
  {
    id: "reminder_watch",
    enginePath: "reminder.service / watch-trigger → Reminder.composeCondition",
    tipKeys: ["general_watch"],
    preconditions: ["composeCondition.type set (market_price, weather_*, …)"],
    whenToOffer: "Soft-try when reminder_watch not tried",
    evidenceMatchers: [
      {
        id: "reminder_has_watch",
        kind: "reminder.clock",
        require: { watch: true },
      },
    ],
    activeUsingMatcherIds: ["reminder_has_watch"],
  },
  {
    id: "directory_contacts",
    enginePath: "contact.service.applyDirectoryActions → Contact",
    tipKeys: [
      "directory_basic_add",
      "directory_basic_show",
      "directory_mid_update",
      "directory_mid_edit_op",
      "directory_mid_delete",
    ],
    preconditions: ["member speaker", "Contact book"],
    whenToOffer: "When directory_contacts not tried",
    evidenceMatchers: [
      {
        id: "contact_saved",
        kind: "directory.contact",
      },
    ],
  },
  {
    id: "directory_share",
    enginePath: "contact.service share_book → ContactBook.visibleTo / Contact.visibleTo",
    tipKeys: ["directory_adv_share"],
    preconditions: ["directory_contacts exists", "peer target"],
    whenToOffer: "After directory Act when directory_share not tried",
    evidenceMatchers: [
      {
        id: "contact_row_shared",
        kind: "directory.contact",
        require: { shared: true },
      },
      {
        id: "contact_book_shared",
        kind: "directory.book_shared",
        require: { shared: true },
      },
    ],
  },
] as const;

export type CapabilityId = (typeof CAPABILITY_CATALOG)[number]["id"];

const BY_ID = new Map(CAPABILITY_CATALOG.map((row) => [row.id, row]));

const TIP_KEY_TO_CAPABILITY_IDS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const cap of CAPABILITY_CATALOG) {
    for (const key of cap.tipKeys) {
      const list = map.get(key) ?? [];
      list.push(cap.id);
      map.set(key, list);
    }
  }
  return map;
})();

export function getCapability(id: string): CapabilityDef | undefined {
  return BY_ID.get(id);
}

export function capabilityIdsForTipKey(tipKey: string): string[] {
  return TIP_KEY_TO_CAPABILITY_IDS.get(tipKey) ?? [];
}

/** Tip keys that soft-try a capability already tried/using should be suppressed. */
export function isSoftTryTriggerKind(
  triggerKind: string | null | undefined,
): boolean {
  return triggerKind === "general" || triggerKind === "model";
}

/**
 * Tip keys intentionally left outside the catalog (no durable Engine evidence
 * or not a capability). Documented for P1 report — not filtered by familiarity.
 */
export const UNMAPPED_TIP_KEYS = [
  "guest_terms",
  "web_lookup_followup",
  "general_weather",
  "general_market",
  "general_places",
  "general_routes",
  "general_parking",
  "general_location_waze",
  "general_mashov",
  "general_smartschool",
  "directory_mid_send",
] as const;

/**
 * Capabilities that exist in prompt registry / product language but have no
 * durable per-user Engine evidence for tried/using in P1.
 */
export const UNVERIFIED_CAPABILITY_IDS = [
  "weather_live",
  "market_live",
  "places_live",
  "routes_live",
  "flights_live",
  "mashov_live",
  "smartschool_live",
  "web_lookup",
  "jewish_live",
  "waze_nav",
  "messages_send",
  "missions",
  "handoff",
  "uwm_web_monitor",
  "scheduled_digest",
] as const;
