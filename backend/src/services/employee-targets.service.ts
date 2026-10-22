import {
  emptyLlmMetadata,
  isDigitalEmployee,
  isGuestEmployee,
  isShowListReplyButton,
  llmItemLabel,
  messageHasSchedule,
  REPLY_BUTTON_MAX,
  type LlmFilingAction,
  type LlmListAction,
  type LlmMessageAction,
  type JobUrgency,
  type LlmMessageBook,
  type LlmMetadata,
  type LlmReminderAction,
  type LlmReplyButton,
  type PublicEmployee,
  type Recurrence,
} from "@workee/shared";
import { looksLikePhone, normalizePhoneDigits, phonesMatch } from "../utils/phone.js";
import {
  builtinListHebrew,
  isBuiltinListType,
  SHOW_FILINGS_COMMAND,
  SHOW_REMINDERS_COMMAND,
  showListButtonCommand,
} from "./builtin-lists.js";
import type {
  FilingOwnerRef,
  ItemVisibility,
  ListItemOwnerRef,
} from "./employee-records.service.js";
import { matchContact, type SpeakerContact } from "./contact.service.js";

const ALL_TARGET_TOKENS = /^(all|everyone|\*|כולם|כל אחד|כל העובדים)$/i;

/** Existing custom list the speaker can see / mutate (personal or shared). */
export type SharedListRef = {
  ownerId: string;
  listName: string;
  visibleTo: string[];
  /** Defaults to "shared" when omitted (older call sites / tests). */
  scope?: "personal" | "shared";
};

function listScopeOf(row: SharedListRef): "personal" | "shared" {
  return row.scope === "personal" ? "personal" : "shared";
}

export function employeeDisplayName(employee: PublicEmployee): string {
  return employee.nickname?.trim() || employee.name;
}

/**
 * Same-turn guard: outbound clocks (ping only other people) must not also
 * land a tasks add on the speaker. Self-nudges (ping includes speaker / empty
 * ping) are unchanged. Worker tasks (targets digital) stay.
 */
export function dropSpeakerTaskAddsForOutboundClocks(input: {
  lists: LlmListAction[];
  reminders: LlmReminderAction[];
  actorId: string;
  employees: PublicEmployee[];
  workers?: PublicEmployee[];
}): LlmListAction[] {
  if (
    !reminderAddsPingOthersOnly({
      reminders: input.reminders,
      actorId: input.actorId,
      employees: input.employees,
      workers: input.workers,
    })
  ) {
    return input.lists;
  }

  const kept: LlmListAction[] = [];
  for (const list of input.lists) {
    if (list.action !== "add" || list.listType !== "tasks") {
      kept.push(list);
      continue;
    }
    const targets = resolveActionTargets(
      list.targets,
      input.employees,
      input.actorId,
      input.workers,
    );
    const withoutSpeaker = targets.filter(
      (target) => target.id !== input.actorId,
    );
    if (withoutSpeaker.length === targets.length) {
      kept.push(list);
      continue;
    }
    if (withoutSpeaker.length === 0) {
      continue;
    }
    kept.push({
      ...list,
      targets: withoutSpeaker.map(employeeDisplayName),
    });
  }
  return kept;
}

function reminderAddsPingOthersOnly(input: {
  reminders: LlmReminderAction[];
  actorId: string;
  employees: PublicEmployee[];
  workers?: PublicEmployee[];
}): boolean {
  const pool = [...input.employees, ...(input.workers ?? [])];
  return input.reminders.some((row) => {
    if (row.action !== "add") {
      return false;
    }
    const raw = [...row.ping, ...row.targets]
      .map((name) => name.trim())
      .filter(Boolean);
    // Empty ping falls back to the speaker → self-nudge / own clock, not outbound-only.
    if (raw.length === 0) {
      return false;
    }
    let matchedOther = false;
    for (const token of raw) {
      const employee = matchEmployee(token, pool);
      if (employee) {
        if (employee.id === input.actorId) {
          return false;
        }
        matchedOther = true;
        continue;
      }
      // Contact name, raw phone, or unresolved label — still an outbound destination.
      matchedOther = true;
    }
    return matchedOther;
  });
}

/** Same-turn reminder clocks that ping this employee (by name). */
export function reminderTargetsEmployee(
  reminder: LlmReminderAction,
  employee: PublicEmployee,
): boolean {
  const names = [...reminder.ping, ...reminder.targets]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) {
    return false;
  }
  const candidates = [
    employee.nickname,
    employee.name,
    employeeDisplayName(employee),
  ]
    .map((name) => name?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  return candidates.some((candidate) => names.includes(candidate));
}

function isClockAdd(row: LlmReminderAction): boolean {
  return row.action === "add" || row.action === "update";
}

/** «בעוד שעה» / «ב־2026-10-07 ב־09:00» from the clock the model emitted; empty when unknown. */
function formatReminderWhen(clock: LlmReminderAction): string {
  if (typeof clock.inSeconds === "number" && clock.inSeconds > 0) {
    const seconds = clock.inSeconds;
    if (seconds < 90) {
      return "בעוד דקה";
    }
    if (seconds < 3600) {
      const minutes = Math.max(1, Math.round(seconds / 60));
      return `בעוד ${minutes} דקות`;
    }
    if (seconds === 3600) {
      return "בעוד שעה";
    }
    if (seconds % 3600 === 0) {
      return `בעוד ${seconds / 3600} שעות`;
    }
    return `בעוד ${Math.round(seconds / 60)} דקות`;
  }
  const time = clock.time?.trim() ?? "";
  if (time) {
    const date = clock.date?.trim() ?? "";
    return date ? `ב־${date} ב־${time}` : `ב־${time}`;
  }
  return "";
}

/** Hebrew clause appended to task notifies when a linked clock exists. */
export function formatLinkedReminderHint(
  reminders: LlmReminderAction[],
): string {
  const clock = reminders.find(isClockAdd);
  if (!clock) {
    return "";
  }
  const when = formatReminderWhen(clock);
  return when ? `, ותזכורת ${when}` : ", ותזכורת";
}

export function resolveActionTargets(
  rawTargets: string[],
  employees: PublicEmployee[],
  actorId: string,
  extras: PublicEmployee[] = [],
): PublicEmployee[] {
  const actor = employees.find((employee) => employee.id === actorId);
  const fallback = actor ? [actor] : [];

  if (rawTargets.length === 0) {
    return fallback;
  }

  if (rawTargets.some((target) => ALL_TARGET_TOKENS.test(target.trim()))) {
    return employees;
  }

  const pool = [...employees, ...extras];
  const matched = new Map<string, PublicEmployee>();
  for (const raw of rawTargets) {
    const employee = matchEmployee(raw, pool);
    if (employee) {
      matched.set(employee.id, employee);
    }
  }

  return matched.size > 0 ? [...matched.values()] : fallback;
}

export function resolveSpokenMetadata(
  _message: string,
  metadata: LlmMetadata,
  _employees?: PublicEmployee[],
  _actorId?: string,
): LlmMetadata {
  // Spread first so every parsed field reaches the engine even if it is not defaulted below.
  return {
    ...metadata,
    lists: metadata.lists,
    listOps: metadata.listOps ?? [],
    filing: metadata.filing,
    messages: metadata.messages ?? [],
    reminders: metadata.reminders ?? [],
    directory: metadata.directory ?? [],
    jobs: metadata.jobs ?? [],
    handoff: metadata.handoff ?? null,
    reportSections: metadata.reportSections ?? [],
    confirm: metadata.confirm ?? null,
    targets: metadata.targets ?? [],
  };
}

/**
 * Same-turn guard: shopping/tasks add with empty targets while messages name
 * recipients → attach those recipients (plus optional speaker label) as targets.
 */
export function alignListTargetsWithMessageRecipients(input: {
  lists: LlmListAction[];
  messages: LlmMessageAction[];
  speakerName?: string;
}): LlmListAction[] {
  const recipients = [
    ...new Set(
      input.messages.flatMap((row) =>
        row.targets.map((name) => name.trim()).filter(Boolean),
      ),
    ),
  ];
  if (recipients.length === 0 || input.lists.length === 0) {
    return input.lists;
  }
  const speaker = input.speakerName?.trim() ?? "";
  let changed = false;
  const next = input.lists.map((row) => {
    if (row.action !== "add" && row.action !== "update") {
      return row;
    }
    if (row.listType !== "shopping" && row.listType !== "tasks") {
      return row;
    }
    if (row.targets.length > 0) {
      return row;
    }
    changed = true;
    const targets = speaker
      ? [...new Set([speaker, ...recipients])]
      : recipients;
    return { ...row, targets };
  });
  return changed ? next : input.lists;
}

export function resolveRelayMessages(
  actions: LlmMessageAction[],
): LlmMessageAction[] {
  return actions.filter(
    (action) => action.text.trim().length > 0 && action.targets.length > 0,
  );
}

export function formatMissingSendTextNotice(
  actions: LlmMessageAction[],
): string {
  const dests = actions
    .filter((action) => action.targets.length > 0 && !action.text.trim())
    .flatMap((action) => action.targets.map((target) => target.trim()))
    .filter(Boolean);
  if (dests.length === 0) {
    return "";
  }
  return dests.length === 1
    ? `מה לשלוח ל«${dests[0]}»? אפשר גם שלום.`
    : `מה לשלוח? אפשר גם שלום.`;
}

export function planRelayDeliveries(input: {
  actor: PublicEmployee;
  sender: PublicEmployee;
  employees: PublicEmployee[];
  messages: LlmMessageAction[];
}): Array<{
  employeeId: string;
  digitalEmployeeId: string;
  target: PublicEmployee;
  text: string;
  expectsReply?: boolean;
  askSummary?: string;
  urgency?: JobUrgency;
  book?: LlmMessageBook;
}> {
  const deliveries: Array<{
    employeeId: string;
    digitalEmployeeId: string;
    target: PublicEmployee;
    text: string;
    expectsReply?: boolean;
    askSummary?: string;
    urgency?: JobUrgency;
    book?: LlmMessageBook;
  }> = [];
  const seen = new Set<string>();

  for (const action of input.messages) {
    // Deferred check-with: no WhatsApp until the clock fires.
    if (messageHasSchedule(action) && action.expectsReply !== false) {
      continue;
    }
    const targets = resolveNamedRelayTargets(
      action.targets,
      input.employees,
    ).filter(
      (target) =>
        target.id !== input.actor.id && target.id !== input.sender.id,
    );

    for (const target of targets) {
      const employeeId = isDigitalEmployee(target)
        ? input.actor.id
        : target.id;
      const digitalEmployeeId = isDigitalEmployee(target)
        ? target.id
        : input.sender.id;
      const key = `${employeeId}:${digitalEmployeeId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deliveries.push({
        employeeId,
        digitalEmployeeId,
        target,
        text: action.text,
        ...(action.expectsReply !== undefined
          ? { expectsReply: action.expectsReply }
          : {}),
        ...(action.askSummary ? { askSummary: action.askSummary } : {}),
        ...(action.urgency ? { urgency: action.urgency } : {}),
        ...(action.book ? { book: action.book } : {}),
      });
    }
  }

  return deliveries;
}

/**
 * «תבדקי איתי…» — messages that target the speaker with expects_reply open a
 * self-job on the worker (no chat/WhatsApp relay; the ask lives in response).
 * Deferred (clock on the messages entry) is handled by planScheduledJobDeliveries.
 */
export function planSelfJobDeliveries(input: {
  actor: PublicEmployee;
  employees: PublicEmployee[];
  messages: LlmMessageAction[];
}): Array<{
  subjectId: string;
  subjectName: string;
  text: string;
  ask: string;
  urgency?: JobUrgency;
  book?: LlmMessageBook;
}> {
  const deliveries: Array<{
    subjectId: string;
    subjectName: string;
    text: string;
    ask: string;
    urgency?: JobUrgency;
    book?: LlmMessageBook;
  }> = [];
  const seen = new Set<string>();

  for (const action of input.messages) {
    if (action.expectsReply === false) {
      continue;
    }
    if (messageHasSchedule(action)) {
      continue;
    }
    const selfTargets = resolveNamedRelayTargets(
      action.targets,
      input.employees,
    ).filter((target) => target.id === input.actor.id);
    for (const target of selfTargets) {
      if (seen.has(target.id)) {
        continue;
      }
      seen.add(target.id);
      deliveries.push({
        subjectId: target.id,
        subjectName: employeeDisplayName(target),
        text: action.text,
        ask: action.askSummary ?? "",
        ...(action.urgency ? { urgency: action.urgency } : {}),
        ...(action.book ? { book: action.book } : {}),
      });
    }
  }

  return deliveries;
}

export type ScheduledJobDelivery = {
  subjectId: string;
  subjectName: string;
  text: string;
  ask: string;
  urgency?: JobUrgency;
  book?: LlmMessageBook;
  inSeconds?: number | null;
  date?: string;
  time?: string;
  recurrence?: Recurrence;
};

/**
 * Deferred check-with: expects_reply messages that carry in / date+time / recurrence.
 * Covers self-check and third-party; no immediate WhatsApp.
 */
export function planScheduledJobDeliveries(input: {
  actor: PublicEmployee;
  sender: PublicEmployee;
  employees: PublicEmployee[];
  messages: LlmMessageAction[];
}): ScheduledJobDelivery[] {
  const deliveries: ScheduledJobDelivery[] = [];
  const seen = new Set<string>();

  for (const action of input.messages) {
    if (action.expectsReply === false || !messageHasSchedule(action)) {
      continue;
    }
    const schedule = {
      ...(action.inSeconds ? { inSeconds: action.inSeconds } : {}),
      ...(action.date ? { date: action.date } : {}),
      ...(action.time ? { time: action.time } : {}),
      ...(action.recurrence ? { recurrence: action.recurrence } : {}),
    };
    const named = resolveNamedRelayTargets(action.targets, input.employees);
    const subjects = named.filter(
      (target) =>
        target.id === input.actor.id ||
        (target.id !== input.sender.id && !isDigitalEmployee(target)),
    );
    for (const target of subjects) {
      if (seen.has(target.id)) {
        continue;
      }
      seen.add(target.id);
      deliveries.push({
        subjectId: target.id,
        subjectName: employeeDisplayName(target),
        text: action.text,
        ask: action.askSummary ?? "",
        ...(action.urgency ? { urgency: action.urgency } : {}),
        ...(action.book ? { book: action.book } : {}),
        ...schedule,
      });
    }
  }

  return deliveries;
}

export function planPhoneRelays(
  messages: LlmMessageAction[],
  employees: PublicEmployee[],
  actorId?: string,
  contacts: SpeakerContact[] = [],
): Array<{ phone: string; text: string; label: string }> {
  const deliveries: Array<{ phone: string; text: string; label: string }> = [];
  const seen = new Set<string>();

  for (const action of messages) {
    if (!action.text.trim()) {
      continue;
    }
    for (const raw of action.targets) {
      let phone = "";
      let label = raw.trim();
      if (looksLikePhone(raw)) {
        const matched = matchEmployee(raw, employees);
        if (matched && matched.id !== actorId) {
          continue;
        }
        phone = normalizePhoneDigits(raw);
        label = phone;
      } else {
        // Named employees are delivered via relay WhatsApp — do not also
        // send through the contacts book when the same person appears there.
        if (matchEmployee(raw, employees)) {
          continue;
        }
        const contact = matchContact(raw, contacts);
        if (!contact) {
          continue;
        }
        phone = normalizePhoneDigits(contact.phone);
        label = contact.name;
      }
      if (!phone || seen.has(phone)) {
        continue;
      }
      // Same phone as a workspace human already covered by relay delivery.
      const employeeWithPhone = employees.find(
        (employee) =>
          employee.id !== actorId &&
          employee.phone &&
          phonesMatch(employee.phone, phone),
      );
      if (employeeWithPhone) {
        continue;
      }
      seen.add(phone);
      deliveries.push({ phone, text: action.text, label });
    }
  }

  return deliveries;
}

function resolveNamedRelayTargets(
  rawTargets: string[],
  employees: PublicEmployee[],
): PublicEmployee[] {
  if (rawTargets.length === 0) {
    return [];
  }

  if (rawTargets.some((target) => ALL_TARGET_TOKENS.test(target.trim()))) {
    return employees;
  }

  const matched = new Map<string, PublicEmployee>();
  for (const raw of rawTargets) {
    const employee = matchEmployee(raw, employees);
    if (employee) {
      matched.set(employee.id, employee);
    }
  }

  return [...matched.values()];
}

/** Live list row addressed by an ACTION item_id: which employee's list holds it. */
export type { ListItemOwnerRef };

function actionItemId(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["item_id", "itemId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/** Collect every item_id the ACTION addresses on update/remove (for owner lookup). */
export function listActionItemIds(lists: LlmListAction[]): string[] {
  const ids = new Set<string>();
  for (const list of lists) {
    if (list.action !== "update" && list.action !== "remove") {
      continue;
    }
    for (const raw of list.items) {
      const id = actionItemId(raw);
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Collect filing_id values on remove/update for owner lookup. */
export function filingActionIds(filing: LlmFilingAction[]): string[] {
  const ids = new Set<string>();
  for (const row of filing) {
    if (row.action !== "remove_filing" && row.action !== "update_filing") {
      continue;
    }
    const id = row.filingId.trim();
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

const UNSHARE_KEYS = ["unshare_with", "unshareWith"] as const;

/** Names the model asked to stop sharing this item with (lists.update). */
function itemUnshareNames(item: Record<string, unknown>): string[] {
  for (const key of UNSHARE_KEYS) {
    const value = item[key];
    if (Array.isArray(value)) {
      return value
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function withoutUnshareField(
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (!UNSHARE_KEYS.some((key) => key in item)) {
    return item;
  }
  const rest = { ...item };
  for (const key of UNSHARE_KEYS) {
    delete rest[key];
  }
  return rest;
}

function isOwnShoppingOrTasks(listType: string): boolean {
  return listType === "shopping" || listType === "tasks";
}

/** Route item_id mutates to the row owner (shopping/tasks/contacts). */
function isBuiltinItemIdRoute(listType: string): boolean {
  return (
    listType === "shopping" ||
    listType === "tasks" ||
    listType === "contacts"
  );
}

/** Contacts (and later directory): share-only — never assign onto someone else's book. */
function isShareOnlyListType(listType: string): boolean {
  return listType === "contacts";
}

/**
 * A partner reaches this custom-list row only through the item's own visible_to
 * (not as a partner on the list) — their edit/remove must land on the owner's row.
 */
function isCustomItemSharedOnlyWithActor(
  ref: ListItemOwnerRef,
  actorId: string,
): boolean {
  return (
    ref.listType === "custom" &&
    ref.ownerId !== actorId &&
    ref.itemVisibleTo.includes(actorId) &&
    !(ref.listScope === "shared" && ref.listVisibleTo.includes(actorId))
  );
}

/**
 * Custom-list row update that changes who sees that one item: unshare_with, or
 * targets naming someone who does not already see it (list or item audience).
 * A plain field edit stays on the named-list path (DB audience, list notifies).
 */
function isCustomItemShareChange(
  ref: ListItemOwnerRef,
  raw: Record<string, unknown>,
  named: PublicEmployee[],
  actorId: string,
): boolean {
  if (ref.listType !== "custom") {
    return false;
  }
  if (itemUnshareNames(raw).length > 0) {
    return true;
  }
  const audience = new Set([
    ref.ownerId,
    actorId,
    ...ref.itemVisibleTo,
    ...(ref.listScope === "shared" ? ref.listVisibleTo : []),
  ]);
  return named.some((target) => !audience.has(target.id));
}

export function planTargetedActions(input: {
  actor: PublicEmployee;
  employees: PublicEmployee[];
  workers?: PublicEmployee[];
  metadata: LlmMetadata;
  /** Shared custom lists visible to the actor (owned by anyone on the account). */
  sharedLists?: SharedListRef[];
  /** Owner of each live shopping/tasks/contacts row addressed by item_id this turn. */
  itemOwners?: Map<string, ListItemOwnerRef>;
  /** Owner of each live filing addressed by filing_id this turn. */
  filingOwners?: Map<string, FilingOwnerRef>;
}): {
  applications: Array<{
    employeeId: string;
    metadata: LlmMetadata;
    visibility: ItemVisibility;
  }>;
  notifications: Array<{
    employee: PublicEmployee;
    metadata: LlmMetadata;
    partnerNames: string[];
  }>;
  /** Guest speakers may view shared data but cannot mutate lists/filings. */
  guestMutationBlocked: boolean;
} {
  const applications: Array<{
    employeeId: string;
    metadata: LlmMetadata;
    visibility: ItemVisibility;
  }> = [];
  const notificationBuckets = new Map<
    string,
    { metadata: LlmMetadata; partnerNames: string[] }
  >();

  const wantsMutation =
    input.metadata.lists.length > 0 || input.metadata.filing.length > 0;
  if (wantsMutation && isGuestEmployee(input.actor)) {
    return {
      applications: [],
      notifications: [],
      guestMutationBlocked: true,
    };
  }

  /** Co-partners for a notify, excluding the actor and the recipient (never «לך ומיכל» to מיכל). */
  const partnerLabel = (targets: PublicEmployee[], recipientId: string) =>
    targets
      .filter(
        (target) =>
          target.id !== input.actor.id && target.id !== recipientId,
      )
      .map(employeeDisplayName);

  const partnerLabelFromIds = (ids: string[], recipientId: string) =>
    ids
      .filter((id) => id !== input.actor.id && id !== recipientId)
      .map((id) => {
        const employee = input.employees.find((row) => row.id === id);
        return employee ? employeeDisplayName(employee) : "";
      })
      .filter(Boolean);

  const addNotification = (
    employeeId: string,
    metadata: LlmMetadata,
    partners: string[],
  ) => {
    if (employeeId === input.actor.id) {
      return;
    }
    const current = notificationBuckets.get(employeeId) ?? {
      metadata: emptyLlmMetadata(),
      partnerNames: [],
    };
    current.metadata.lists.push(...metadata.lists);
    current.metadata.filing.push(...metadata.filing);
    current.partnerNames = [
      ...new Set([...current.partnerNames, ...partners]),
    ];
    notificationBuckets.set(employeeId, current);
  };

  const lists = dropSpeakerTaskAddsForOutboundClocks({
    lists: input.metadata.lists,
    reminders: input.metadata.reminders ?? [],
    actorId: input.actor.id,
    employees: input.employees,
    workers: input.workers,
  });

  const humanOwnerIds = new Set(
    input.employees
      .filter((employee) => !isDigitalEmployee(employee))
      .map((employee) => employee.id),
  );

  for (const rawList of lists) {
    let list = rawList;
    if (
      (list.action === "update" || list.action === "remove") &&
      input.itemOwners &&
      input.itemOwners.size > 0
    ) {
      // A shared shopping/tasks row lives once on its owner's list — mutate it there.
      // A custom-list row being shared/unshared by item_id is the same item-level share.
      const named = resolveNamedRelayTargets(list.targets, input.employees).filter(
        (target) => !isDigitalEmployee(target) && !isGuestEmployee(target),
      );
      const byOwner = new Map<
        string,
        {
          ownerId: string;
          listType: LlmListAction["listType"];
          listName: string;
          items: LlmListAction["items"];
        }
      >();
      const rest: LlmListAction["items"] = [];
      for (const raw of list.items) {
        const ref = input.itemOwners.get(actionItemId(raw));
        if (
          !ref ||
          !humanOwnerIds.has(ref.ownerId) ||
          !(
            isBuiltinItemIdRoute(ref.listType) ||
            isCustomItemSharedOnlyWithActor(ref, input.actor.id) ||
            (list.action === "update" &&
              isCustomItemShareChange(ref, raw, named, input.actor.id))
          )
        ) {
          rest.push(raw);
          continue;
        }
        const listName = ref.listType === "custom" ? ref.listName : "";
        const key = `${ref.ownerId}\u0000${ref.listType}\u0000${listName}`;
        const bucket = byOwner.get(key) ?? {
          ownerId: ref.ownerId,
          listType: ref.listType as LlmListAction["listType"],
          listName,
          items: [],
        };
        bucket.items.push(raw);
        byOwner.set(key, bucket);
      }
      if (byOwner.size > 0) {
        for (const bucket of byOwner.values()) {
          const ownerId = bucket.ownerId;
          const unshareNames = bucket.items.flatMap(itemUnshareNames);
          const removeIds =
            list.action === "update"
              ? resolveNamedRelayTargets(unshareNames, input.employees)
                  .map((target) => target.id)
                  .filter((id) => id !== ownerId)
              : [];
          const partners = named.filter(
            (target) =>
              target.id !== ownerId &&
              target.id !== input.actor.id &&
              !removeIds.includes(target.id),
          );
          const share = list.action === "update" && partners.length > 0;
          applications.push({
            employeeId: ownerId,
            metadata: {
              lists: [
                {
                  ...list,
                  listType: bucket.listType,
                  listName: bucket.listName,
                  items: bucket.items.map(withoutUnshareField),
                  targets: [],
                },
              ],
              filing: [],
            },
            visibility: {
              scope: share ? "shared" : "personal",
              addedById: input.actor.id,
              visibleTo: share
                ? uniqueIds([ownerId, input.actor.id, ...partners.map((p) => p.id)])
                : [ownerId],
              ...(removeIds.length > 0 ? { removeIds } : {}),
              itemOnly: true,
            },
          });
        }
        if (rest.length === 0) {
          continue;
        }
        list = { ...list, items: rest };
      }
    }
    // unshare_with is an instruction, never row data.
    list = { ...list, items: list.items.map(withoutUnshareField) };
    const normalizedList = normalizeSharedCustomList(list);
    const existingListMatches = findExistingCustomListsForActor(
      normalizedList,
      input.actor.id,
      input.sharedLists ?? [],
    );
    if (existingListMatches.length > 0) {
      // Removes/updates must hit every duplicate shared list with that name
      // (legacy bugs created one copy per partner). Adds go to one canonical owner.
      // Audience is always from DB scope/visibleTo — never from this turn's LLM targets.
      const mutationTargets =
        normalizedList.action === "remove" ||
        normalizedList.action === "update"
          ? existingListMatches
          : [preferSharedList(existingListMatches)!];
      const notifyMetadata = {
        lists: [
          {
            ...normalizedList,
            listName: mutationTargets[0]!.listName,
            targets: [],
          },
        ],
        filing: [],
      };
      for (const existingList of mutationTargets) {
        const scope = listScopeOf(existingList);
        const visibleTo =
          scope === "shared"
            ? uniqueIds([
                existingList.ownerId,
                input.actor.id,
                ...existingList.visibleTo,
              ])
            : uniqueIds([existingList.ownerId]);
        applications.push({
          employeeId: existingList.ownerId,
          metadata: {
            lists: [
              {
                ...normalizedList,
                listName: existingList.listName,
                targets: [],
              },
            ],
            filing: [],
          },
          visibility: {
            scope,
            addedById: input.actor.id,
            visibleTo,
          },
        });
      }
      // Re-sharing / touching an existing list with no rows is a no-op for partners.
      // Only notify real shared-list partners from DB (not personal lists, not LLM targets).
      if (normalizedList.items.length > 0 || normalizedList.action !== "add") {
        const notifyIds = uniqueIds(
          mutationTargets
            .filter((row) => listScopeOf(row) === "shared")
            .flatMap((row) => [row.ownerId, ...row.visibleTo]),
        );
        for (const partnerId of notifyIds) {
          addNotification(
            partnerId,
            notifyMetadata,
            partnerLabelFromIds(notifyIds, partnerId),
          );
        }
      }
      continue;
    }

    const targets = resolveActionTargets(
      normalizedList.targets,
      input.employees,
      input.actor.id,
      input.workers,
    );
    const others = targets.filter((target) => target.id !== input.actor.id);
    const sharedCollection = isSharedCollectionAction(
      "list",
      normalizedList,
      targets,
      input.actor.id,
      normalizedList.targets,
    );
    // A digital worker is not a sharing partner: its tasks reach people through involvement.
    const humanOthers = others.filter((target) => !isDigitalEmployee(target));
    const visibility = visibilityFor(
      input.actor.id,
      targets,
      sharedCollection ||
        humanOthers.length > 0 ||
        isAllTarget(normalizedList.targets),
    );
    const metadata = { lists: [{ ...normalizedList, targets: [] }], filing: [] };

    if (sharedCollection) {
      // One shared list owned by the speaker; all partners see every item.
      applications.push({
        employeeId: input.actor.id,
        metadata,
        visibility,
      });
      for (const target of others) {
        addNotification(target.id, metadata, partnerLabel(targets, target.id));
      }
      continue;
    }

    const mutateTargets = targets.filter((target) => !isGuestEmployee(target));
    const humanTargets = mutateTargets.filter(
      (target) => !isDigitalEmployee(target),
    );
    const humanPartnerTargets = humanTargets.filter(
      (target) => target.id !== input.actor.id,
    );
    // Shopping/tasks: co-share only when speaker is in targets (else = assign).
    // Contacts: always speaker-owned co-share when partners present (share-only).
    const sharedSingleRow =
      normalizedList.action === "add" &&
      ((isOwnShoppingOrTasks(normalizedList.listType) &&
        humanTargets.some((target) => target.id === input.actor.id) &&
        humanPartnerTargets.length > 0) ||
        (isShareOnlyListType(normalizedList.listType) &&
          (humanPartnerTargets.length > 0 ||
            isAllTarget(normalizedList.targets))));
    if (sharedSingleRow) {
      // One row on the speaker's list; partners see it through visible_to.
      const shareVisibility = visibilityFor(
        input.actor.id,
        targets,
        true,
      );
      applications.push({
        employeeId: input.actor.id,
        metadata,
        visibility: shareVisibility,
      });
      for (const target of mutateTargets) {
        if (target.id === input.actor.id) {
          continue;
        }
        if (isDigitalEmployee(target)) {
          applications.push({
            employeeId: target.id,
            metadata,
            visibility: shareVisibility,
          });
        } else {
          addNotification(
            target.id,
            metadata,
            partnerLabel(targets, target.id),
          );
        }
      }
      continue;
    }
    for (const target of mutateTargets) {
      applications.push({ employeeId: target.id, metadata, visibility });
      if (!isDigitalEmployee(target)) {
        addNotification(target.id, metadata, partnerLabel(targets, target.id));
      }
    }
  }

  for (const filing of input.metadata.filing) {
    // Partner/owner mutate by filing_id — apply on the owner's book.
    if (
      (filing.action === "remove_filing" || filing.action === "update_filing") &&
      filing.filingId.trim() &&
      input.filingOwners &&
      input.filingOwners.size > 0
    ) {
      const ref = input.filingOwners.get(filing.filingId.trim());
      if (ref && humanOwnerIds.has(ref.ownerId)) {
        const unshareNames = filing.unshareWith ?? [];
        const removeIds = resolveNamedRelayTargets(
          unshareNames,
          input.employees,
        )
          .map((target) => target.id)
          .filter((id) => id !== ref.ownerId);
        const named = resolveNamedRelayTargets(
          filing.targets,
          input.employees,
        ).filter(
          (target) =>
            !isDigitalEmployee(target) && !isGuestEmployee(target),
        );
        const partners = named.filter(
          (target) =>
            target.id !== ref.ownerId &&
            target.id !== input.actor.id &&
            !removeIds.includes(target.id),
        );
        const share = filing.action === "update_filing" && partners.length > 0;
        const { unshareWith: _drop, ...filingRest } = filing;
        const metadata = {
          lists: [],
          filing: [{ ...filingRest, targets: [] }],
        };
        applications.push({
          employeeId: ref.ownerId,
          metadata,
          visibility: {
            scope: share || ref.scope === "shared" ? "shared" : "personal",
            addedById: input.actor.id,
            visibleTo: share
              ? uniqueIds([
                  ref.ownerId,
                  input.actor.id,
                  ...ref.visibleTo,
                  ...partners.map((target) => target.id),
                ])
              : uniqueIds([ref.ownerId, ...ref.visibleTo]),
            ...(removeIds.length > 0 ? { removeIds } : {}),
            itemOnly: true,
          },
        });
        if (share) {
          for (const partner of partners) {
            addNotification(
              partner.id,
              metadata,
              partnerLabelFromIds(
                [ref.ownerId, input.actor.id, ...partners.map((row) => row.id)],
                partner.id,
              ),
            );
          }
        }
        continue;
      }
    }

    const targets = resolveActionTargets(
      filing.targets,
      input.employees,
      input.actor.id,
      input.workers,
    );
    const others = targets.filter((target) => target.id !== input.actor.id);
    const humanOthers = others.filter((target) => !isDigitalEmployee(target));
    // Share-only: any human partner → one filing on the speaker (never assignee fan-out).
    const coshare =
      humanOthers.length > 0 ||
      isAllTarget(filing.targets) ||
      isSharedCollectionAction(
        "filing",
        null,
        targets,
        input.actor.id,
        filing.targets,
      );
    const visibility = visibilityFor(input.actor.id, targets, coshare);
    const metadata = { lists: [], filing: [{ ...filing, targets: [] }] };

    if (coshare) {
      applications.push({
        employeeId: input.actor.id,
        metadata,
        visibility,
      });
      for (const target of others) {
        if (isGuestEmployee(target)) {
          continue;
        }
        addNotification(target.id, metadata, partnerLabel(targets, target.id));
      }
      continue;
    }

    const mutateTargets = targets.filter((target) => !isGuestEmployee(target));
    for (const target of mutateTargets) {
      applications.push({ employeeId: target.id, metadata, visibility });
      if (!isDigitalEmployee(target)) {
        addNotification(target.id, metadata, partnerLabel(targets, target.id));
      }
    }
  }

  return {
    applications,
    notifications: [...notificationBuckets.entries()].flatMap(
      ([employeeId, bucket]) => {
        const employee = input.employees.find((item) => item.id === employeeId);
        if (!employee) {
          return [];
        }
        const linkedReminders = (input.metadata.reminders ?? []).filter(
          (reminder) =>
            (reminder.action === "add" || reminder.action === "update") &&
            reminderTargetsEmployee(reminder, employee),
        );
        return [
          {
            employee,
            metadata: {
              ...bucket.metadata,
              reminders: [
                ...(bucket.metadata.reminders ?? []),
                ...linkedReminders,
              ],
            },
            partnerNames: bucket.partnerNames,
          },
        ];
      },
    ),
    guestMutationBlocked: false,
  };
}

/** Named shared list / shared filing only — does not replace item-level targets sharing. */
export function isSharedCollectionAction(
  kind: "list" | "filing",
  list: Pick<LlmListAction, "listType" | "listName" | "items"> | null,
  targets: PublicEmployee[],
  actorId: string,
  rawTargets: string[],
): boolean {
  const hasActor = targets.some((target) => target.id === actorId);
  const hasOther = targets.some((target) => target.id !== actorId);
  if (!hasActor || (!hasOther && !isAllTarget(rawTargets))) {
    return false;
  }
  if (kind === "filing") {
    return true;
  }
  // Keep shopping/tasks/item-level sharing and meetings on the existing per-target path.
  // Shared *list* objects are named custom lists co-owned with partners.
  return Boolean(list && list.listType === "custom" && customListNameOf(list));
}

function customListNameOf(
  list: Pick<LlmListAction, "listName" | "items">,
): string {
  const direct = list.listName?.trim() ?? "";
  if (direct) {
    return direct;
  }
  for (const raw of list.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    for (const key of ["list_name", "listName", "רשימה"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().slice(0, 100);
      }
    }
  }
  return "";
}

/**
 * When the model puts the new list title in items (and leaves list_name empty),
 * treat that as opening a named custom list — not as a row named like the list.
 * Only collapse when the sole item looks like a list title, not a real row
 * (e.g. { "תיאור": "…" } must still be saved).
 */
function normalizeSharedCustomList(list: LlmListAction): LlmListAction {
  if (list.listType !== "custom") {
    return list;
  }
  let listName = list.listName?.trim() || customListNameOf(list);
  if (
    !listName &&
    list.items.length === 1 &&
    looksLikeListTitleOnly(list.items[0])
  ) {
    const label = llmItemLabel(list.items[0]).trim();
    if (label) {
      return { ...list, listName: label.slice(0, 100), items: [] };
    }
  }
  if (listName && list.items.length === 1) {
    const label = llmItemLabel(list.items[0]).trim();
    if (label && normalizeLoose(label) === normalizeLoose(listName)) {
      // Real add: item carries a distinct list_name (e.g. בעיות) while the model
      // also copied the row text into the top-level list_name.
      const fromItem = customListNameOf({ listName: "", items: list.items });
      if (fromItem && normalizeLoose(fromItem) !== normalizeLoose(label)) {
        return { ...list, listName: fromItem };
      }
      // Title-only / phantom echo of the list title → open named list shell.
      return { ...list, listName, items: [] };
    }
  }
  if (listName && list.listName?.trim() !== listName) {
    return { ...list, listName };
  }
  return list;
}

function looksLikeListTitleOnly(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as Record<string, unknown>;
  const metaKeys = new Set([
    "list_name",
    "listName",
    "רשימה",
    "list_type",
    "listType",
    "targets",
    "attachment_ids",
    "detach_attachment_ids",
    "linked_list_ids",
    "linked_lists",
    "unlink_list_ids",
  ]);
  const titleKeys = new Set([
    "name",
    "item_name",
    "שם פריט",
    "שם",
    "title",
    "שם רשימה",
    "list_title",
  ]);
  const filled = Object.entries(record).filter(([key, value]) => {
    if (metaKeys.has(key)) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim() !== "";
    }
    return value != null;
  });
  if (filled.length === 0) {
    return true;
  }
  if (filled.length !== 1) {
    return false;
  }
  return titleKeys.has(filled[0][0]);
}

/** Explicit list title, or a sole title-only item used as the new list name. */
function customListDerivedName(list: LlmListAction): string {
  const explicit = list.listName?.trim() || customListNameOf(list);
  if (explicit) {
    return explicit;
  }
  if (
    list.listType === "custom" &&
    list.items.length === 1 &&
    looksLikeListTitleOnly(list.items[0])
  ) {
    return llmItemLabel(list.items[0]).trim();
  }
  return "";
}

/**
 * Empty / title-only custom add = opening a named list shell.
 * A real row must never count as "opening" just because its label was used as
 * a fallback title when list_name was missing.
 */
function isOpeningCustomList(list: LlmListAction): boolean {
  if (list.action !== "add") {
    return false;
  }
  const explicit = list.listName?.trim() || customListNameOf(list);
  if (list.items.length === 0) {
    return Boolean(explicit);
  }
  if (list.items.length !== 1) {
    return false;
  }
  const label = llmItemLabel(list.items[0]).trim();
  if (!label || !looksLikeListTitleOnly(list.items[0])) {
    return false;
  }
  const derived = explicit || label;
  return Boolean(derived) && normalizeLoose(label) === normalizeLoose(derived);
}

/** Prefer a real item mutation over an empty "opened shared list" sibling. */
function pickPrimaryList(lists: LlmListAction[]): LlmListAction | undefined {
  if (lists.length === 0) {
    return undefined;
  }
  const withRealItems = lists.find(
    (row) => row.items.length > 0 && !isOpeningCustomList(row),
  );
  return withRealItems ?? lists[0];
}

function visibilityFor(
  actorId: string,
  targets: PublicEmployee[],
  shared: boolean,
): ItemVisibility {
  const visibleTo = [...new Set([actorId, ...targets.map((target) => target.id)])];
  return {
    scope: shared ? "shared" : "personal",
    addedById: actorId,
    visibleTo,
  };
}

const SHOW_REMINDERS_BUTTON: LlmReplyButton = {
  label: "הצג",
  command: SHOW_REMINDERS_COMMAND,
};

function reminderMutates(metadata: LlmMetadata): boolean {
  return (metadata.reminders ?? []).some(
    (row) =>
      row.action === "add" ||
      row.action === "remove" ||
      row.action === "update",
  );
}

/** Conditional watch clock (compose_condition) — worker task + ping clock. */
function isWatchClockTurn(metadata: LlmMetadata): boolean {
  return (metadata.reminders ?? []).some(
    (row) =>
      (row.action === "add" || row.action === "update") &&
      row.composeCondition != null,
  );
}

/**
 * Engine fallback for the speaker: after list / filing / reminder mutates,
 * if the model omitted the matching «הצג» button(s), append them (same
 * product commands as partner notifies). Keeps any existing model buttons.
 */
export function ensureSpeakerShowButtons(
  metadata: LlmMetadata,
  existing: LlmReplyButton[] = [],
): LlmReplyButton[] {
  // Watch: Lucy worker task + compose clock → only «הצג תזכורות» (not also
  // «הצג רשימת מטלות», which looks like a duplicate «הצג» on the chat bubble).
  if (isWatchClockTurn(metadata) && reminderMutates(metadata)) {
    const buttons = existing
      .filter(
        (button) =>
          !isShowListReplyButton(button) ||
          button.command === SHOW_REMINDERS_COMMAND,
      )
      .slice(0, REPLY_BUTTON_MAX);
    const seen = new Set(buttons.map((button) => button.command));
    if (
      buttons.length < REPLY_BUTTON_MAX &&
      !seen.has(SHOW_REMINDERS_COMMAND)
    ) {
      buttons.push(SHOW_REMINDERS_BUTTON);
    }
    return buttons;
  }

  const buttons = existing.slice(0, REPLY_BUTTON_MAX);
  const seen = new Set(buttons.map((button) => button.command));
  const append = (button: LlmReplyButton): void => {
    if (buttons.length >= REPLY_BUTTON_MAX || seen.has(button.command)) {
      return;
    }
    seen.add(button.command);
    buttons.push(button);
  };
  for (const button of showButtonsForNotify(metadata)) {
    append(button);
  }
  // Partner notify skips תזכורות when a list button already exists; speaker
  // still gets both after a self-nudge (task + clock) if the model omitted them.
  if (reminderMutates(metadata)) {
    append(SHOW_REMINDERS_BUTTON);
  }
  return buttons;
}

/**
 * Engine-built «הצג» buttons for partner notifies (add/remove/update lists).
 * Same product names as the speaker SHOW BUTTON rule — not LLM-emitted.
 */
export function showButtonsForNotify(metadata: LlmMetadata): LlmReplyButton[] {
  const buttons: LlmReplyButton[] = [];
  const seen = new Set<string>();

  const listMutates = metadata.lists.filter(
    (row) =>
      row.action === "add" ||
      row.action === "remove" ||
      row.action === "update",
  );
  for (const list of listMutates) {
    const name = showListCommandName(list);
    if (!name) {
      continue;
    }
    const command = showListButtonCommand(name);
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);
    buttons.push({ label: "הצג", command });
    if (buttons.length >= REPLY_BUTTON_MAX) {
      return buttons;
    }
  }

  if (
    buttons.length < REPLY_BUTTON_MAX &&
    (metadata.filing ?? []).some(
      (row) =>
        row.action === "add_filing" ||
        row.action === "remove_filing" ||
        row.action === "update_filing",
    )
  ) {
    const command = SHOW_FILINGS_COMMAND;
    if (!seen.has(command)) {
      seen.add(command);
      buttons.push({ label: "הצג", command });
    }
  }

  if (buttons.length === 0 && reminderMutates(metadata)) {
    buttons.push(SHOW_REMINDERS_BUTTON);
  }
  return buttons;
}

function showListCommandName(list: LlmListAction): string {
  if (isBuiltinListType(list.listType)) {
    return builtinListHebrew(list.listType);
  }
  return customListDerivedName(list).trim();
}

export function fallbackNotificationText(
  actor: PublicEmployee,
  metadata: LlmMetadata,
  options?: {
    completed?: boolean;
    purchased?: boolean;
    /** Recipient was just added to the item's visible_to (share, not edit). */
    shared?: boolean;
    /** Recipient was just removed from the item's visible_to. */
    unshared?: boolean;
    recipientIsOwner?: boolean;
    /** Recipient co-owns the shared item (not its owner, not who assigned it). */
    recipientIsPartner?: boolean;
    ownerName?: string;
    partnerNames?: string[];
  },
): string {
  const actorName = employeeDisplayName(actor);
  const clocks = (metadata.reminders ?? []).filter(isClockAdd);
  const realLists = metadata.lists.filter(
    (row) => row.items.length > 0 && !isOpeningCustomList(row),
  );
  const reportedLists = realLists.length > 0 ? realLists : metadata.lists.slice(0, 1);
  const singleTaskAdd =
    reportedLists.length === 1 &&
    reportedLists[0].listType === "tasks" &&
    reportedLists[0].action === "add";
  // One task + its clock keeps the one-line «…, ותזכורת בעוד שעה». Anything more gets
  // one line per action so no item is dropped and no clock is glued to the wrong task.
  if (
    reportedLists.length + metadata.filing.length > 1 ||
    clocks.length > 1 ||
    (clocks.length === 1 && !singleTaskAdd)
  ) {
    const strip = (sentence: string) =>
      sentence.startsWith(`${actorName} `)
        ? sentence.slice(actorName.length + 1)
        : sentence;
    const lines = [
      ...reportedLists.map((list) =>
        strip(
          fallbackNotificationText(
            actor,
            { ...metadata, lists: [list], filing: [], reminders: [] },
            options,
          ),
        ),
      ),
      ...metadata.filing.map((filing) =>
        strip(
          fallbackNotificationText(
            actor,
            { ...metadata, lists: [], filing: [filing], reminders: [] },
            options,
          ),
        ),
      ),
      ...clocks.map((clock) => {
        const when = formatReminderWhen(clock);
        const item = clock.item?.trim() ?? "";
        return `תזכורת אליך${when ? ` ${when}` : ""}${item ? `: ${item}` : ""}`;
      }),
    ];
    if (lines.length === 1) {
      return `${actorName} קבע לך ${lines[0].replace(/^תזכורת אליך/, "תזכורת")}`;
    }
    return `עדכונים מ${actorName}:\n${lines.map((line) => `• ${line}`).join("\n")}`;
  }
  const list = pickPrimaryList(metadata.lists);
  const items = collectItemLabels(
    list ? { ...metadata, lists: [list] } : metadata,
  );
  const itemText = items.join(" ו") || "פריט";
  const yours = options?.recipientIsOwner !== false;
  // A shared partner sees the item in their own list — never «של <owner>».
  const ownerList = yours
    ? "שלך"
    : options?.recipientIsPartner
      ? ""
      : options?.ownerName
        ? `של ${options.ownerName}`
        : "";

  if (options?.unshared && list?.action === "update") {
    if (list.listType === "tasks") {
      return `${actorName} הפסיק לשתף איתך מטלה: ${itemText}`;
    }
    if (list.listType === "shopping") {
      return `${actorName} הפסיק לשתף איתך ${itemText} מרשימת הקניות`;
    }
    const title = customListDerivedName(list) || "רשימה";
    return `${actorName} הפסיק לשתף איתך ${formatQuotedItems(items)} מרשימת «${title}»`;
  }

  if (options?.shared && list?.action === "update") {
    if (list.listType === "shopping") {
      return `${actorName} שיתף איתך ${itemText} ברשימת הקניות`;
    }
    if (list.listType === "tasks") {
      return `${actorName} שיתף איתך מטלה: ${itemText}`;
    }
    const title = customListDerivedName(list) || "רשימה";
    return `${actorName} שיתף איתך ${formatQuotedItems(items)} מרשימת «${title}»`;
  }
  const partners = (options?.partnerNames ?? []).filter(Boolean);
  const sharedWithRecipient =
    options?.partnerNames !== undefined || partners.length > 0;
  /** Empty other-partners → «איתך»; never «לך ו<recipient>». */
  const partnerPhrase =
    partners.length === 0
      ? "איתך"
      : partners.length === 1
        ? `לך ול${partners[0]}`
        : `לך ל${partners.slice(0, -1).join(", ")} ו${partners[partners.length - 1]}`;

  if (list) {
    const derivedName = customListDerivedName(list);
    const listTitle =
      derivedName ||
      (list.listType === "shopping"
        ? "קניות"
        : list.listType === "tasks"
          ? "מטלות"
          : "רשימה");
    const openingSharedList =
      list.listType === "custom" && isOpeningCustomList(list);
    // Opening an empty / title-only shared custom list.
    if (sharedWithRecipient && openingSharedList) {
      return `${actorName} הוסיף רשימה משותפת ${partnerPhrase}: «${listTitle}»`;
    }
    if (list.listType === "custom" && derivedName && !openingSharedList) {
      if (list.action === "remove") {
        return `${actorName} מחק ${formatQuotedItems(items)} מרשימת «${listTitle}»`;
      }
      if (list.action === "update") {
        return `${actorName} עדכן ${formatQuotedItems(items)} ברשימת «${listTitle}»`;
      }
      return `${actorName} הוסיף ${formatNewItemPhrase(items)} לרשימת «${listTitle}»`;
    }
    if (sharedWithRecipient && derivedName) {
      if (list.action === "remove") {
        return `${actorName} מחק ${itemText} מהרשימה המשותפת «${listTitle}»`;
      }
      if (list.action === "update") {
        return `${actorName} עדכן ${itemText} ברשימה המשותפת «${listTitle}»`;
      }
      if (list.action === "add") {
        return `${actorName} הוסיף ${itemText} לרשימה המשותפת «${listTitle}»`;
      }
    }
  }

  if (list?.listType === "shopping") {
    if (list.action === "remove") {
      return `${actorName} מחק ${formatQuotedItems(items)} מרשימת «קניות»`;
    }
    if (list.action === "update") {
      return `${actorName} עדכן ${itemText} ברשימת הקניות ${ownerList}`.trim();
    }
    return `${actorName} הוסיף ${itemText} לרשימת הקניות ${ownerList}`.trim();
  }

  if (list?.listType === "tasks") {
    if (list.action === "remove") {
      return `${actorName} הסיר מטלה: ${itemText}`;
    }
    if (list.action === "update") {
      return `${actorName} עדכן מטלה: ${itemText}`;
    }
    const reminderHint = formatLinkedReminderHint(metadata.reminders ?? []);
    return yours
      ? `${actorName} הוסיף לך מטלה: ${itemText}${reminderHint}`
      : `${[actorName, "הוסיף מטלה", ownerList].filter(Boolean).join(" ")}: ${itemText}${reminderHint}`;
  }

  if (list?.listType === "custom" || (list?.listName && list.listName.trim())) {
    const derivedName = customListDerivedName(list);
    const listTitle = derivedName || "רשימה";
    const openingList = isOpeningCustomList(list);
    if (openingList) {
      return sharedWithRecipient
        ? `${actorName} הוסיף רשימה משותפת ${partnerPhrase}: «${listTitle}»`
        : `${actorName} פתח רשימה חדשה «${listTitle}»`;
    }
    if (list.action === "remove") {
      return `${actorName} מחק ${formatQuotedItems(items)} מרשימת «${listTitle}»`;
    }
    if (list.action === "update") {
      return `${actorName} עדכן ${formatQuotedItems(items)} ברשימת «${listTitle}»`;
    }
    return `${actorName} הוסיף ${formatNewItemPhrase(items)} לרשימת «${listTitle}»`;
  }

  if (metadata.filing.length > 0) {
    const filing = metadata.filing[0];
    if (sharedWithRecipient) {
      const verb =
        filing.action === "remove_filing"
          ? "מחק"
          : filing.action === "update_filing"
            ? "עדכן"
            : "הוסיף";
      if (filing.action === "add_filing") {
        return `${actorName} ${verb} תיוק משותף ${partnerPhrase}: «${filing.itemName}»`;
      }
      return `${actorName} ${verb} פריט בתיוק המשותף «${filing.itemName}»${
        filing.itemInfo?.trim() ? `: ${filing.itemInfo.trim()}` : ""
      }`;
    }
    const verb =
      filing.action === "remove_filing"
        ? "הסיר תיוק"
        : filing.action === "update_filing"
          ? "עדכן תיוק"
          : "הוסיף תיוק";
    return yours
      ? `${actorName} ${verb} אצלך: ${filing.itemName}`
      : `${actorName} ${verb} אצל ${options?.ownerName ?? "עובד אחר"}: ${filing.itemName}`;
  }

  const directory = metadata.directory ?? [];
  if (directory.length > 0) {
    const contact = directory[0];
    const label = contact.name.trim() || "איש קשר";
    if (sharedWithRecipient) {
      return `${actorName} שיתף ${partnerPhrase} איש קשר מספר הטלפונים: «${label}»`;
    }
    return `${actorName} עדכן איש קשר בספר הטלפונים: «${label}»`;
  }

  return `${actorName} עדכן מידע אצלך: ${itemText}`;
}

function isAllTarget(rawTargets: string[]): boolean {
  return rawTargets.some((target) => ALL_TARGET_TOKENS.test(target.trim()));
}

export function matchEmployee(
  raw: string,
  employees: PublicEmployee[],
): PublicEmployee | undefined {
  const needle = normalizeName(raw);
  const byName = employees.find((employee) => {
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname}`,
      employeeDisplayName(employee),
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map(normalizeName);

    return aliases.includes(needle);
  });
  if (byName) {
    return byName;
  }
  if (!looksLikePhone(raw)) {
    return undefined;
  }
  return employees.find(
    (employee) => employee.phone && phonesMatch(employee.phone, raw),
  );
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function collectItemLabels(metadata: LlmMetadata): string[] {
  const listName = metadata.lists[0]?.listName?.trim() ?? "";
  const fromLists = metadata.lists.flatMap((list) =>
    list.items
      .map((item) => llmItemLabel(item))
      .map((label) => label.trim())
      .filter((label) => label && normalizeLoose(label) !== normalizeLoose(listName)),
  );
  const fromFiling = metadata.filing
    .map((filing) => filing.itemName)
    .filter(Boolean);
  return [...fromLists, ...fromFiling];
}

function formatNewItemPhrase(items: string[]): string {
  if (items.length === 0) {
    return "פריט חדש";
  }
  if (items.length === 1) {
    return `פריט חדש «${items[0]}»`;
  }
  return `פריטים חדשים «${items.join("» ו«")}»`;
}

function formatQuotedItems(items: string[]): string {
  if (items.length === 0) {
    return "פריט";
  }
  if (items.length === 1) {
    return `«${items[0]}»`;
  }
  return `«${items.join("» ו«")}»`;
}

function normalizeLoose(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Exact name match only — substring matching caused wrong-partner notifies. */
function findExistingCustomListsForActor(
  list: Pick<LlmListAction, "listType" | "listName" | "items">,
  actorId: string,
  knownLists: SharedListRef[],
): SharedListRef[] {
  if (list.listType !== "custom" || knownLists.length === 0) {
    return [];
  }
  const needle =
    list.listName?.trim() ||
    customListNameOf(list) ||
    (list.items.length === 1 && looksLikeListTitleOnly(list.items[0])
      ? llmItemLabel(list.items[0]).trim()
      : "");
  if (!needle) {
    return [];
  }
  const normalizedNeedle = normalizeLoose(needle);
  const matches = knownLists.filter((row) => {
    const canSee =
      row.ownerId === actorId || row.visibleTo.includes(actorId);
    if (!canSee) {
      return false;
    }
    return normalizeLoose(row.listName) === normalizedNeedle;
  });
  matches.sort((a, b) => {
    const scopeRank = (row: SharedListRef) =>
      listScopeOf(row) === "shared" ? 0 : 1;
    if (scopeRank(a) !== scopeRank(b)) {
      return scopeRank(a) - scopeRank(b);
    }
    return a.ownerId.localeCompare(b.ownerId);
  });
  return matches;
}

function preferSharedList(matches: SharedListRef[]): SharedListRef | null {
  if (matches.length === 0) {
    return null;
  }
  // Prefer shared over personal, then widest visibleTo, then stable owner id.
  const ranked = [...matches].sort((a, b) => {
    const aShared = listScopeOf(a) === "shared" ? 0 : 1;
    const bShared = listScopeOf(b) === "shared" ? 0 : 1;
    if (aShared !== bShared) {
      return aShared - bShared;
    }
    if (b.visibleTo.length !== a.visibleTo.length) {
      return b.visibleTo.length - a.visibleTo.length;
    }
    return a.ownerId.localeCompare(b.ownerId);
  });
  return ranked[0] ?? null;
}

function findSharedListForActor(
  list: Pick<LlmListAction, "listType" | "listName" | "items">,
  actorId: string,
  sharedLists: SharedListRef[],
): SharedListRef | null {
  return preferSharedList(
    findExistingCustomListsForActor(list, actorId, sharedLists),
  );
}
