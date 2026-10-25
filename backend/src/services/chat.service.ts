import { randomUUID } from "node:crypto";
import { Prisma, type ChatMessage as ChatMessageRow } from "@prisma/client";
import {
  digitalEmployees,
  emptyLlmMetadata,
  humanEmployees,
  isDigitalEmployee,
  isGuestEmployee,
  isGuestLucy,
  isSubHourlyRecurrence,
  JOB_URGENCY_POLICY,
  parseChatAttachmentRefs,
  parseLlmReply,
  parseReplyMetadata,
  redactMetadataSecrets,
  redactRegisterSecrets,
  SEND_ATTACHMENTS_MAX,
  showDumpNames,
  showDumpIdList,
  isShowDumpIdsRequested,
  applyShowButtonsToBubbles,
  clearBubbleButtons,
  toReplyButtons,
  type ChatAttachmentRef,
  type ChatHistoryResponse,
  type ChatThreadMessage,
  type ChatThreadNotification,
  type ChatTurnMessageIds,
  type LlmListAction,
  type LlmMetadata,
  type LlmReplyButton,
  type LlmSpokenBubble,
  type PublicEmployee,
  type ReasoningEffort,
} from "@workee/shared";
import { loadLlmConfig, type LlmConfig, type LlmJsonSchemaFormat } from "../config/llm.js";
import { ValidationError } from "../utils/errors.js";
import { prisma } from "../database/prisma.js";
import {
  isContextTooLargeError,
  isUniqueConstraintError,
  missingTableName,
  ServiceUnavailableError,
} from "../utils/errors.js";
import {
  alignListTypeInReply,
  applyEmployeeRecords,
  correctAttachmentClaimReply,
  correctListMutationClaimReply,
  correctShareClaimReply,
  EMPTY_REPLY_RETRY,
  LIST_FIND_MISS,
  formatAppliedMutationFallback,
  formatEmployeeContext,
  formatTeamSchedules,
  getEmployeeRecordSnapshot,
  getTeamSchedules,
  loadFilingOwners,
  loadListItemOwners,
  readItemId,
  removeVisibleCustomItems,
  type EmployeeRecordSnapshot,
  type FilingMutation,
  type ListItemMutation,
  type ShareApplyMiss,
  type SharedItemEvent,
} from "./employee-records.service.js";
import { getEmployeeForUser, listEmployeesForUser } from "./employee.service.js";
import {
  applyListOps,
  formatListOpFallback,
  formatListOpRefusals,
} from "./list-ops.service.js";
import {
  alignListTargetsWithMessageRecipients,
  employeeDisplayName,
  fallbackNotificationText,
  formatMissingSendTextNotice,
  filingActionIds,
  listActionItemIds,
  matchEmployee,
  planPhoneRelays,
  planRelayDeliveries,
  planScheduledJobDeliveries,
  planSelfJobDeliveries,
  planTargetedActions,
  resolveRelayMessages,
  resolveSpokenMetadata,
  buildCollabByListKey,
  ensureSpeakerShowButtons,
  listNavKeyFromMutation,
  showButtonsForNotify,
  type SharedListRef,
} from "./employee-targets.service.js";
import { phonesMatch } from "../utils/phone.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import { formatSpeakerAddressContext } from "./speaker-address.js";
import {
  answerOpenJobForPair,
  applyJobActions,
  correctMisaddressedJobReply,
  createJobsFromRelays,
  createScheduledJobsFromRelays,
  formatOpenJobsContext,
  formatOpenJobsWaitingDump,
  listOpenJobsForViewer,
  meetingListsForAnswers,
  sweepJobNudgesForRemovedItems,
} from "./jobs.service.js";
import { publishChatEvent } from "./chat-events.service.js";
import {
  getLlmClient,
  rememberInModelConversation,
  toPlainJson,
  toResponsesCreateBody,
} from "./llm-client.js";
import { recordLlmUsage } from "./llm-usage.service.js";
import {
  applyReminders,
  formatReminderApplyNotice,
  formatReminderDeleteFallback,
  itemsFromListMutationsForSoftLink,
  linkRemindersToItems,
  linkRemindersToWorkerTasks,
  listLiveHumanItemsForReminderLink,
  reminderRepeatsSubHourly,
  SUB_HOURLY_REFUSAL,
  unionSoftLinkItemCandidates,
  type ReminderChange,
  type WorkerTaskRef,
} from "./reminder.service.js";
import {
  formatRecentOutboundContext,
  listRecentReminderOutbounds,
} from "./recent-outbound.service.js";
import {
  applyDirectoryActions,
  formatSpeakerContacts,
  getContactBookShare,
  listContactsForEmployee,
} from "./contact.service.js";
import { registerGuestMember } from "./guest-register.service.js";
import {
  collectAppliedTipOps,
  formatAvailableTipsContext,
  resolveAndRecordTipsForTurn,
} from "./tips.service.js";
import {
  appendEngineNotice,
  composeAssistantReply,
  deliverWhatsAppPhones,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
  applyLiveDomainReply,
  setEngineButtons,
  setEngineNavigateAddress,
  setEngineResponse,
  setEngineSpokenBubbles,
  type WhatsAppDeliverySkip,
} from "./whatsapp-send.js";
import { singleTaskShowButtons } from "./outbound-text.js";
import {
  composeTasksDumpWithWaiting,
  emptyListDumpSentence,
  excludeItemIdsFromSnapshot,
  filterSnapshotForAboutPerson,
  formatLastNumberedDumpContext,
  formatShowDumpWithLineMap,
  isTasksShowDumpKind,
  dumpFilterNames,
  mapShowButtonCommandToDumpTarget,
  navigateAddressFromFilingsDump,
  resolveShowDumpKind,
  type LastNumberedDumpLine,
} from "./show-button-dump.js";
import { resolveWeatherMessages } from "./weather.js";
import { composeWeatherLiveTip } from "./reminder-compose.js";
import { resolveMarketReply } from "./market.js";
import { resolveMashovReply } from "./mashov.js";
import { resolvePlacesReply } from "./places.js";
import { resolveJewishReply } from "./jewish.js";
import { resolveRoutesReply } from "./routes.js";
import { resolveFlightsReply } from "./flights.js";
import {
  clearPendingLocation,
  formatPendingLocationContext,
  getPendingLocation,
} from "./pending-location.js";
import {
  clearMutatingMetadata,
  stripShowTurnMutates,
} from "./show-turn-guard.js";
import { stripWhatsAppReplyPrefix } from "./whatsapp-outbound-memory.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { planOutboundSends } from "./outbound-hold.js";
import { formatAttributedOutbound } from "./outbound-text.js";
import {
  emptyAttachmentOutcome,
  formatNewAttachmentsBlock,
  formatPendingAttachmentsContext,
  listPendingAttachments,
  mergeAttachmentOutcomes,
  resolveUsableAttachments,
  toChatAttachmentRef,
  collectAttachmentIdsForDumpRows,
  withAttachmentRefs,
  type TurnAttachments,
} from "./attachment.service.js";
import { withLinkedListRefs } from "./list-item-list-link.service.js";

function speakerName(employee: {
  name: string;
  nickname: string | null;
}): string {
  return employee.nickname?.trim() || employee.name;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) {
    return Prisma.JsonNull;
  }

  return toPlainJson(value) as Prisma.InputJsonValue;
}

export const CONVERSATION_IDLE_MS = 40 * 60 * 1000;

function emptyHistory(
  employeeId: string,
  conversationId: string | null,
  startedAt: Date | string | null = null,
  digitalEmployeeId?: string,
): ChatHistoryResponse {
  return {
    employeeId,
    digitalEmployeeId,
    conversationId,
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
    messages: [],
    raw: null,
    request: null,
    isNew: true,
  };
}

function toHistoryResponse(
  employeeId: string,
  conversation: {
    digitalEmployeeId?: string;
    openaiConversationId: string;
    updatedAt: Date;
    messages: ChatMessageRow[];
  },
): ChatHistoryResponse {
  const lastAssistant = [...conversation.messages]
    .reverse()
    .find((message) => message.author === "assistant" && message.raw != null);

  return {
    employeeId,
    digitalEmployeeId: conversation.digitalEmployeeId,
    conversationId: conversation.openaiConversationId,
    startedAt: conversation.updatedAt.toISOString(),
    messages: conversation.messages.map(toThreadMessage),
    raw: unpackStoredLlmRaw(lastAssistant?.raw).response,
    request: unpackStoredLlmRaw(lastAssistant?.raw).request,
    isNew: conversation.messages.length === 0,
  };
}

const STORED_LLM_REQUEST = "workeeOpenAiRequest";
const STORED_LLM_RESPONSE = "workeeOpenAiResponse";
const STORED_LAST_NUMBERED_DUMP = "lastNumberedDump";

function buildOpenAiRequest(input: {
  conversationId: string;
  message: string;
  model: string;
  temperature: number;
  reasoningEffort?: ReasoningEffort;
  instructions: string;
  textFormat?: LlmJsonSchemaFormat;
}): Record<string, unknown> {
  return toResponsesCreateBody(input);
}

function packStoredLlmRaw(
  request: unknown,
  response: unknown,
  lastNumberedDump?: LastNumberedDumpLine[],
): unknown {
  return {
    [STORED_LLM_REQUEST]: request,
    [STORED_LLM_RESPONSE]: response,
    ...(lastNumberedDump && lastNumberedDump.length > 0
      ? { [STORED_LAST_NUMBERED_DUMP]: lastNumberedDump }
      : {}),
  };
}

function unpackStoredLlmRaw(raw: unknown): {
  request: unknown;
  response: unknown;
  lastNumberedDump: LastNumberedDumpLine[];
} {
  if (
    raw &&
    typeof raw === "object" &&
    STORED_LLM_REQUEST in raw &&
    STORED_LLM_RESPONSE in raw
  ) {
    const packed = raw as Record<string, unknown>;
    return {
      request: packed[STORED_LLM_REQUEST] ?? null,
      response: packed[STORED_LLM_RESPONSE] ?? null,
      lastNumberedDump: parseLastNumberedDump(packed[STORED_LAST_NUMBERED_DUMP]),
    };
  }
  return {
    request: null,
    response: raw ?? null,
    lastNumberedDump: [],
  };
}

function parseLastNumberedDump(value: unknown): LastNumberedDumpLine[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: LastNumberedDumpLine[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const n = typeof rec.n === "number" && Number.isFinite(rec.n) ? rec.n : 0;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const kind = typeof rec.kind === "string" ? rec.kind.trim() : "";
    const title_stem =
      typeof rec.title_stem === "string" ? rec.title_stem.trim() : "";
    if (!n || !id || !kind) {
      continue;
    }
    const section =
      typeof rec.section === "string" && rec.section.trim()
        ? rec.section.trim()
        : undefined;
    out.push({
      n,
      id,
      kind,
      title_stem: title_stem || id,
      ...(section ? { section } : {}),
    });
  }
  return out;
}

async function loadLastNumberedDumpForConversation(
  conversationId: string,
): Promise<LastNumberedDumpLine[]> {
  // Dump map is stored on the first assistant row of a show_dump turn. Later
  // raise/extra rows in the same turn have no raw map ? scan newest-first.
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { raw: true },
  });
  for (const row of recent) {
    const lines = unpackStoredLlmRaw(row.raw).lastNumberedDump;
    if (lines.length > 0) {
      return lines;
    }
  }
  return [];
}

function toThreadMessage(row: ChatMessageRow): ChatThreadMessage {
  const actions = Array.isArray(row.actions)
    ? row.actions.filter((action): action is string => typeof action === "string")
    : [];
  const buttons = toReplyButtons({ buttons: row.buttons });
  const attachments = parseChatAttachmentRefs(row.attachments);

  return {
    id: row.id,
    author: row.author === "assistant" ? "assistant" : "you",
    speaker: row.speaker,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    ...(actions.length > 0 ? { actions } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
    ...(row.navigateAddress ? { navigateAddress: row.navigateAddress } : {}),
    ...(row.showIcon ? { showIcon: row.showIcon } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** Per-worker prompt/model from DB; shared action schema from LLM.action.json. */
function llmConfigForDigital(digital: PublicEmployee): LlmConfig {
  const base = loadLlmConfig();
  const systemMessage = digital.instructions?.trim() || base.systemMessage;
  const model = digital.model?.trim() || base.model;
  const temperature =
    typeof digital.temperature === "number" && Number.isFinite(digital.temperature)
      ? digital.temperature
      : base.temperature;
  return {
    model,
    temperature,
    reasoningEffort: digital.reasoningEffort ?? base.reasoningEffort,
    systemMessage,
    ...(base.responseFormat ? { responseFormat: base.responseFormat } : {}),
  };
}

function promptsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  return a.length > 0 && a === b;
}

/**
 * Lucy's full runtime engine (targeting / capabilities) is only attached when this
 * worker is Lucy, or their saved prompt matches Lucy's / the file base (Inherit).
 * A custom prompt must run alone ? never diluted by Lucy's catalog.
 */
export function shouldAttachLucyRuntimeEngine(
  digital: PublicEmployee,
  employees: PublicEmployee[],
  fileSystemMessage: string,
): boolean {
  if (digital.protected) {
    return true;
  }
  const own = digital.instructions?.trim() ?? "";
  if (!own) {
    return true;
  }
  const lucy =
    employees.find((row) => row.kind === "digital" && row.protected) ??
    employees.find(
      (row) =>
        row.kind === "digital" &&
        (row.nickname === "????" || row.name === "????"),
    );
  if (lucy && promptsEqual(own, lucy.instructions)) {
    return true;
  }
  return promptsEqual(own, fileSystemMessage);
}

/**
 * Jobs you hold for one person about another: open on expects_reply, answered or
 * closed through metadata.jobs, reported back to the asker by the server.
 * Shipped here (not in the seeded prompt) so Lucy and every worker that inherits
 * her prompt get the same rules without a stored-prompt edit.
 */
/**
 * Jobs are bookkeeping around a turn that already happened ? the reply is
 * written and the relay is out. A job problem must never fail the turn.
 */
const ATTACHMENTS_RULE =
  "ATTACHMENTS: files arrive as new_attachments under [קבצים שהתקבלו בהודעה זו] (you also see images); PENDING_ATTACHMENTS = recent files not attached yet; saved rows carry attachments; has_attachments is true ONLY when the list itself has files (list_attachment_ids / list attachments) — never because an item inside has files. ATTACH via items[].attachment_ids / filing|reminders attachment_ids / lists alter_list add_attachments / lists[].list_attachment_ids. DESTINATION LADDER (full recipe in system DECISION & FOCUS / ATTACHMENTS): תייקי|תשמרי|תצרפי are equivalent save verbs — NOT always filings. (A) filings — only לתיוקים / תחת… / כ… new title + attachment_ids; (B) list SHELL — alter_list add_attachments ONLY when לרשימה עצמה / ברמת הרשימה; (C) list ITEM — default when ל-X uniquely matches a custom list_name: update/add item_id + attachment_ids (identify item from wording / active USER topic / LAST_NUMBERED_DUMP / live rows — FORBIDDEN last-mentioned latch; item unclear → ask which item; never ask list-vs-item). ל-X person → assign. No save intent in this or prior USER turns → empty mutates on bare file/forward (FORBIDDEN invent filing). Deferred file after USER named a target → complete with PENDING/new_attachments despite intervening Lucy messages. BY LINE attach (לפריטים 1-3) → update×N dump item_ids + same attachment_ids; stale/missing dump → ASK. STABLE REFS: pronouns (זה/אותו) and ordinals (הראשון/השני) → active USER topic + LAST_NUMBERED_DUMP id (+ live match); FORBIDDEN last-mentioned latch alone; unclear → ASK. Document/image filing when create-filing is clear: short item_name + attachment_ids; item_info = optional SHORT summary only; item_description = find-helper only when useful — FORBIDDEN full OCR into item_info/description. Reminder with files → same ids on task and reminder. PAPERCLIP / LINK ICON / send_attachments / DEICTIC SHOW: same as system ATTACHMENTS. Never speak ids; never invent video/document content.";

async function withAttachmentRefsSafe(
  snapshot: EmployeeRecordSnapshot,
): Promise<EmployeeRecordSnapshot> {
  const withAtt =
    (await withoutFailingTurn("attachments_refs_failed", () =>
      withAttachmentRefs(snapshot),
    )) ?? snapshot;
  return (
    (await withoutFailingTurn("linked_list_refs_failed", () =>
      withLinkedListRefs(withAtt),
    )) ?? withAtt
  );
}

function findTaskItemInSnapshot(
  snapshot: EmployeeRecordSnapshot,
  itemId: string,
): Record<string, unknown> | null {
  const needle = itemId.trim();
  if (!needle) {
    return null;
  }
  for (const list of snapshot.lists) {
    if (list.list_type !== "tasks") {
      continue;
    }
    for (const item of list.items) {
      if (String(item.item_id ?? "").trim() === needle) {
        return item;
      }
    }
  }
  return null;
}

function taskTitleFromSnapshot(
  snapshot: EmployeeRecordSnapshot,
  itemId: string,
): string {
  const item = findTaskItemInSnapshot(snapshot, itemId);
  if (!item) {
    return "";
  }
  for (const key of ["?? ????", "name", "task", "item_name"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function taskHasLinkedReminder(
  snapshot: EmployeeRecordSnapshot,
  itemId: string,
): boolean {
  const item = findTaskItemInSnapshot(snapshot, itemId);
  if (!item) {
    return false;
  }
  const reminder = item.reminder;
  if (reminder && typeof reminder === "object" && !Array.isArray(reminder)) {
    const id = (reminder as { reminder_id?: unknown }).reminder_id;
    if (typeof id === "string" && id.trim()) {
      return true;
    }
  }
  for (const key of ["reminder_id", "linked_reminder_id"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }
  return false;
}

async function withoutFailingTurn<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    recordWhatsAppEvent(label, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

function englishDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  return `${Math.round(seconds / 60)} minutes`;
}

const URGENCY_RULE = (() => {
  const urgent = JOB_URGENCY_POLICY.urgent;
  const veryUrgent = JOB_URGENCY_POLICY.very_urgent;
  return [
    "URGENCY (every messages entry): urgency = normal | urgent | very_urgent, judged by the MEANING of how the speaker asked ? never ask them how urgent it is.",
    "normal by default. urgent when they stress it (???? / ????? / ???? ????? ???). very_urgent when they stress it hard (??? ???? / ???? ???? / ??? / ?????).",
    "The text to the recipient carries it: urgent ? ????? ???? ???????: ?? ???????; very_urgent ? ????? ???? ? ???? ???? ????? ?????: ?? ???????.",
    `On a job (expects_reply true) the server follows up with the recipient on its own: urgent ? ${urgent.autoNudges} more times, every ${englishDuration(urgent.intervalSeconds)}; very_urgent ? ${veryUrgent.autoNudges} more times, every ${englishDuration(veryUrgent.intervalSeconds)}; normal ? none (you only raise it when they write). After the last follow-up the server tells the asker.`,
    "Never emit reminders, jobs.snooze or lists for those follow-ups. Response to the asker quotes the EXACT messages.text: ?????? ???? ??????? ?? ?????? ????? ???? ???????: ?? ???????, ?????? ?? ??? ?? ?? ????.?",
    "URGENCY FOLLOW-UP (critical): the same ask repeated more urgently (????? ??? / ?????? / ??? ????? / ???? ????? right after you scheduled or opened that check) ? prefer metadata.jobs [{ action:\"escalate\", job_id from OPEN_JOBS, urgency:\"urgent\"|\"very_urgent\" }] (asker only ? subject cannot change urgency). Or ONE messages entry with the higher urgency (same targets/ask); the server escalates that one open job when it is the only asker?subject row ? never a second check. Never lists add reminders.",
    "FORBIDDEN: a second messages entry with a new clock, a second deferred check, lists add list_type reminders, or lists.add for the same check.",
    "Example: ?????? ???? ???? 10 ???? ?? ????? ?????? then ??? ????? ? messages [{ targets:[speaker], text:\"???? ??????\", expects_reply:true, ask_summary:\"?? ???? ??????\", urgency:\"urgent\", in:600 }], no reminders clock, lists:[]; response short ack that it is urgent.",
  ].join(" ");
})();

/** Every phrasing that asks the worker for its own inventory; keep all INVENTORY rules on this list. */
const WORKER_INVENTORY_ASKS =
  "?? ??/? ????/? ????? / ????, ?? ?? ??, ?? ?? ?? ?????, ?? ???? ????, ?? ?? ??/? ????/?, ?????? ???";

/** Speaker ping-clock asks (any ????????? wording, including ?????) ? active_reminders, never WORKER. */
const SPEAKER_CLOCK_ASKS =
  "??? ???????, ????? ?? ???????? ???, ?? ???????? ???, ???? ??????? ?? ??, ???? ??????? ??????, ??? ?? ??????";

const STATUS_ADDRESSEE_RULE =
  "WHO A STATUS QUESTION IS ABOUT ? read the person the speaker used: second person to YOU (?? / ?? / ??? / ??? / ???? ? ??? ?? ???, ??? ???? ?????) = YOUR work ? metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED; server dump + ???????). show_dump=tasks alone = the SPEAKER's book ? FORBIDDEN for second-person inventory. First person (?? / ??? / ??? ? ??? ?? ???) = the speaker's own rows (show_dump without about, or full). A name (??? ?? ????) = that person's rows via show_dump_about. FORBIDDEN free-writing ???? ?? ?????? / ???? ?? ????? while WORKER_SAVED_DATA or OPEN_JOBS has a row ? emit the dump ACTION.";

/** Shared with eval thin-custom envelope; Chat custom-prompt branch uses the same text. */
export const RESPONSES_RULE =
  "OUTPUT: your spoken reply is the top-level \"responses\" array (not a single \"response\" string). Each entry is an object {text, buttons?, navigate_address?} sent as its own message, in order. Put tap buttons and Waze on the bubble they belong to (POST-MUTATE SHOW / LIST/collab nav on confirm; ??/?? on the soft-reminder offer; navigate_address on the address line). After applied list/filing mutate YOU emit the matching LIST / collab nav on the confirm bubble (engine validates vs apply; may add one plain LIST safety-net if you omitted it; never invents collab). FORBIDDEN list/collab nav on soft-offer ??/?? or tips. After add|update, when the title uniquely opens that row ? you MAY emit an item-show button ONLY for tasks|filing (reliable open commands); shopping/contacts/custom ? no item-open from you. ITEM DUMP: show specific row(s) ? show_dump + show_dump_ids (server replaces; FORBIDDEN writing the body; empty/mismatch ids ? no-match, never full list). After remove ? engine list nav only. New tasks add WITHOUT explicit ??????? ??? ? TWO responses entries (confirm with optional item-open; engine adds list nav; then soft reminder offer with ??/??). New tasks add WITH explicit reminder schedule same turn ? ONE confirm (task+reminder under APPLY FEEDBACK) + optional item-open; FORBIDDEN soft-offer ??/??. Usually one entry otherwise; use several only for independent messages (e.g. the answer, then a raise of an open job). Wherever these instructions say \"response\", they mean these entries' text. After an item MOVE (lists.remove + lists.add) ? engine dest list-show only (never source+dest). metadata.show_icon (one emoji or null) attaches to the speaker's message and is sent/shown before spoken replies.";

const OPEN_JOBS_RULES = [
  "OPEN JOBS ? expects_reply IS MANDATORY (critical): every message you send to another human for the speaker where the speaker is waiting for something back MUST carry expects_reply:true and ask_summary. That covers a question (?? ????? / ?? ???? ???), a check (????? ?? ????), AND a request to do or arrange something (????? ????? ?? ??? / ????? ???? ????? ?? ????? / ????? ???? ?????). If the other person has to answer, agree, or act ? expects_reply:true. Use false ONLY for pure information with nothing coming back (???? ??? / ?????? ????? / ????).",
  "SELF-CHECK (?????? ?????? / check with me): when the speaker asks YOU to check with THEM (????? ???? ?? ????? ???? / check with me if I bought?), emit messages targeting the SPEAKER with expects_reply:true + ask_summary + urgency, lists:[]. text, ask_summary, and response MUST address the speaker in second person ? convert their first person (????? / ????? / ?????) to second (???? / ???? / ????). Example: ???? ???? ?????? ???? ?? ????? ????? ? messages: [{ \"targets\": [\"????\"], \"text\": \"???? ?????\", \"expects_reply\": true, \"ask_summary\": \"?? ???? ?????\", \"urgency\": \"normal\" }], lists: [], response: short ack + ask NOW (????? ? ???? ??????). FORBIDDEN when asker===subject: keeping first person in those fields, ?<name> ???? ???????, or third-party framing. ?????? ???? ?????? / ???? ????? ? same shape with urgency urgent / very_urgent; response notes the urgency like any other job. The server opens a self-job on you (????? ?? ????: ?) ? never lists.add it. Do NOT claim you relayed a message to someone else; the ask lives in response. Urgency follow-ups run like any other OPEN_JOB. Later turns: OPEN_JOBS shows viewer_is=subject ? raise/answer like any other job. On answer leave report_text empty (no third party). Never say ????? ???? ?????? when asker===subject ? phrase as their own check, as a separate raise entry: ????, ????? ?????? ?? ???? ??????",
  "DEFERRED CHECK (?????/????? ? ???? X / ??? ??? / ?? ??? ??? / ?? 1 ?????): same expects_reply messages entry PLUS in (seconds) OR date+time OR recurrence (same shape as reminders[].recurrence). lists:[]. response = when + EXACT OUTBOUND QUOTE of messages.text (?????? ?? ?? ??? ??20:00 ?? ?????? ????? ???? ?? ??? ????? ?? ????????) ? do NOT ask or WhatsApp now; do NOT emit list_type reminders for this (the server schedules your ????? task with ?????/??? + clock). At fire the server clears the dates, sends the ask, and urgency follow-ups run like any open job. OPEN_JOBS may list scheduled=true / raisable=false until then ? wait, do not raise early. Immediate check (no future clock on the messages entry) stays ask-now. URGENCY FOLLOW-UP after a deferred check: bare ?????? / ??? ????? / ???? ????? ? escalate that ONE job (URGENCY FOLLOW-UP) ? never a second deferred check or lists add reminders.",
  "ask_summary = what the speaker wants from them, in the speaker's own words, WITHOUT the recipient's name: ????? ????? ????? ???? ?????? / ??? ???? ????? ? not ????? ????? ?? ????.",
  URGENCY_RULE,
  "Example: ???? ???? ?????? ????? ????? ?? ??? ???? ????? ???? 10? ? messages: [{ \"targets\": [\"???\"], \"text\": \"???? ???? ???? ???? ????? ????? ???? ????? ?-10:00. ????? ?? ??? ?? ??? ??????\", \"expects_reply\": true, \"ask_summary\": \"???? ????? ????? ???? ????? ?-10:00\", \"urgency\": \"normal\", \"book\": { \"title\": \"????? ?????\", \"date\": \"<that Tuesday YYYY-MM-DD>\", \"time\": \"10:00\" } }], lists: []. The text states the slot AND ends with a yes/no question (????? ???? / ??? ?? ??? ???). A statement alone is not enough. The server opens the job task on you ? never add a lists task for it yourself. This is the only exception to ?a tell/send never becomes a task? besides scheduled sends.",
  "book (on that messages entry): set it whenever the ask is to set up something the two of them will do together at a slot ? ?????, ????, ???? ?????, ???, ?????. title = the speaker's own words for it (???? ?????), date = YYYY-MM-DD from SESSION_CLOCK, time = HH:mm. On a yes the server saves that item on BOTH people's tasks. Omit book for a plain question or a request that is not a shared slot (?? ????? / ???? ?? ?????).",
  "MEETING SLOT FIRST: ????? ????? ?? X needs a date+time (or all-day) BEFORE you message X. Speaker omitted them ? ask the speaker in response, messages=[], lists=[]. Never ping X with ?????? ????? ???? ??? ???? while you still lack the slot, and never ask X for a time the speaker already gave. Follow-up ???? ?-10? when no job is open yet ? now message X WITH that slot (expects_reply true, ask_summary includes ??? ?-10:00). A new different request to the same person (????? ?? ????? while a meeting job is already open) is another job ? expects_reply + ask_summary, do not emit jobs.progress on the old row. Updating the SAME open job (new slot for that meeting) ? jobs.progress on that job_id AND the update message; the server keeps that one row.",
  "OPEN_JOBS (injected when present) lists the jobs you still owe for THIS speaker: job_id, asker, subject, ask, task, viewer_is, state, raisable. Only those exist ? never invent one. Several rows can be open at once. EVERY metadata.jobs entry MUST copy job_id from OPEN_JOBS ? never omit it (missing job_id when several jobs are owed makes the server ask ??? ???? ??????? and drop the action, including counter). Two possible rows ? ASK which OPEN_JOBS ask briefly, then on their pick emit the jobs action WITH that job_id. If OPEN_JOBS has rows you DO have work: say so even when WORKER_SAVED_DATA is empty; FORBIDDEN ???? ?? ?????? / ???? ?? ????? ? inventory ? show_dump=tasks + show_dump_about=YOUR display name (both REQUIRED).",
  "PHRASING per viewer ? a job row also appears in WORKER_SAVED_DATA as ?????? ?? X: ??; never read that label out loud as-is. viewer_is=subject (you are talking TO the person being asked) ? second person and name the asker: ????? ???? ???? ???? ???? ????? ????? ???? ?????? / ???? ????? ????? ?? ????? (????? ?????)?. Self-job (asker===subject===this speaker) ? second person about THEIR own check, never name them as a third party: ????? ?????? ???? ?? ???? ???? ? ??????. FORBIDDEN on self-job raise: ?<name> ???? ???????, first-person ask copy (????? / ?????), or ????? ????? about this speaker. viewer_is=asker ? third person about the subject: ???? ????? ????? ?? ??? ???? ????? ????? ???? ????? (??????)?. Never say ?????? ?? ???? to ??? himself.",
  "ANSWER: a short reply from the subject (?? / ?? / ??? ???? ???? / ????? ?? ??) answers the job whose ask it matches ? metadata.jobs [{ action:\"answer\", job_id, answer_text: their words, report_text: your sentence for the asker }]. ??? / ?? / ???? = that job's asker; ??? / ?? ??? = that job's ask. Two possible jobs ? ASK which. Do NOT emit messages for the report ? the server delivers report_text. report_text speaks about the subject in third person and quotes the ask, e.g. ???? ???? ??? ????, ???? ? ???? ????? ?????? ???? ????? ???? ??? ????????. report_text is NEVER for the current speaker: if you are talking to the asker, leave it empty and use messages to reach the subject. If you are talking to the subject, report_text goes to the asker. Self-job answer ? report_text empty; ack in response only.",
  "ANSWER BEATS DICTATED SEND (critical): when OPEN_JOBS has a matching subject job (viewer_is=subject / the raised check they are answering) and they say ?????? ???? / ?????? ??/?? ??? / ?????? ??X ??? / ?????? ????? ???? meaning close that check ? emit ONLY jobs.answer (+ report_text). FORBIDDEN treating it as DICTATED SEND / messages to the asker with body ???? (that leaves the job open). Bare ????/???? after a raise = answer that job. Dictated send (?????? ??? ???????) stays messages ONLY when no matching open check applies.",
  "WHO HEARS WHAT: response is only for the person in front of you. After you message someone else, response confirms to the asker with EXACT OUTBOUND QUOTE ? ?????? ???? ?? ?????? ????? ???? ?? ???? ?????? (character-for-character messages.text / reminders.text). FORBIDDEN: making the whole response the recipient-facing line alone (not bare ????, ???? ?????? as the only content). REQUIRED: include that exact text inside ?? ?????? ???. After the subject answers, response to THEM is only a short ack ? ?????? ?? ????.? The report sentence exists only in report_text; never copy it into response.",
  "COUNTER: the subject names a DIFFERENT slot than the one in ask (????? ?? 15:00 / ???? ??21:00 instead of 11:00) ? SAME TURN metadata.jobs [{ action:\"counter\", job_id from OPEN_JOBS, answer_text: the new slot in their words, date: YYYY-MM-DD from SESSION_CLOCK, time: \"21:00\", report_text: ??? ???? ????? ?? ???? ?????? ???? ????? ???? 21:00. ??? ?????? }], messages=[], lists=[]. job_id + date + time are required. If exactly one open schedule/coordinate job fits (???? / ?????), counter immediately ? do not ask ??? ???? ??????? or list unrelated chores. If you already asked ??????? ?? ?????? and they say ??, emit that full counter with the previously spoken new slot AND that job_id ? ?? is not jobs.answer approving the old time. The server keeps ONE job, flips who must answer, and delivers report_text. Do not book yet. ?? / ???? / ????? on a book_on_yes job ? answer AND lists add the meeting (????? ??????=book_date, ??? ??????=book_time, ??? ????=book_end_time when present, targets=both people). ??? ????? is snooze, not counter. A full refusal ? decline.",
  "RANGE BOOKINGS: OPEN_JOBS book_end_time = the end of the asked slot; book_window=true = the range is a window to pick a time in, false/absent = the meeting's own length. Agree to the whole slot on a duration booking ? answer, and the meeting adds ??? ????=book_end_time. Subject names one time (?????? ??11:00?) inside a window, or different from book_time ? COUNTER with time \"11:00\"; end_time only if they said an end, or a duration booking moved as a whole (keep its length: 10:00?12:00 ? 11:00?13:00); otherwise end_time empty. Example: ask ????? ????? ???? ????? ??? 10:00 ??12:00?, ?? ?????? ??11:00? ? jobs [{action:\"counter\", job_id, answer_text:\"????? ??11:00\", date:<Wed>, time:\"11:00\", end_time:\"\", report_text:\"?? ???? ???? ????? ??11:00. ?????\"}]; the asker's ?? ? answer + the meeting at 11:00 on both.",
  "BOOK A MEETING when the job's ask is to schedule/coordinate anything shared at a slot (???? ????? / ???? / ???? ????? / ?????) AND the subject agrees (????? ????? / ?? ??? ???? / ???): SAME TURN emit jobs.answer as above AND lists add list_type=tasks, targets=[asker name, subject name] (never YOU / ????), one item = the meeting itself ? ?? ???? MUST include all participants in parentheses matching targets (e.g. ????? ????? ????? ????? (????, ??) or ????? ????? (????, ???) ? not ????? ??? and not a topic-only title). ????? ?????? = YYYY-MM-DD from SESSION_CLOCK for that weekday, ??? ?????? = HH:mm when a time was named, ??? ???=false. Do NOT offer a shared save; they already agreed. messages=[]. Example: ??? ?????? ????? ?? ??????? on ask ????? ????? ????? ???? ????? ???? 10? ? jobs:[{action:\"answer\", job_id, answer_text:\"????? ????? ?? ??????\", report_text:\"??? ???? ? ????? ????? ????? ???? ????? ?-10:00\"}], lists:[{action:\"add\", list_type:\"tasks\", targets:[\"????\",\"???\"], items:[{ \"?? ????\":\"????? ????? (????, ???)\", \"????? ??????\":\"<that Tuesday YYYY-MM-DD>\", \"??? ??????\":\"10:00\", \"??? ???\":false }]}]. Time or all-day not agreed yet ? jobs progress, ask the hour, lists=[]. A check/question job (?? ????? / ?? ???? ???) stays answer-only ? no lists.",
  "DECLINE (?? ????? / ?? ???????) ? action decline + report_text, job closes. ??? ????? / ???? ??? with no hour is NOT a decline.",
  "PROGRESS (???? ???? ??? / ?? ???? with no hour) ? action progress or snooze with no time. report_text empty. The asker is not told. The job stays open and stays raisable. A different clock time is COUNTER only ? never progress.",
  `RAISING (mandatory when raisable=true and viewer_is=subject): after you answer what they just asked, raise one such job. Also raise it when they open (??? / ?? ????) or switch to a new topic. A raise is ALWAYS its own entry in responses ? never inside the answer entry. The answer entry is written as if no job were open (greeting ???? ? ???, ??? ???? ???????); a normal raise is the NEXT entry and starts with ????,?. Example: ???? ???? with a raisable self-check ??? ???? ????? ? responses: ["??, ??? ???? ??????", "???, ????? ?????? ?? ???? ????"]. A meeting raise entry is the question: ????, ???? ???? ???? ???? ????? ???? ????? ?-12:00. ????? ?? ??? ?? ??? ??????? Do not stop at ???? ????? ???? ?????. Skip the raise while your own question is still unanswered ? including an open DELETE CLARIFY (which item/list/scope to delete): that turn is ONE responses entry only; FORBIDDEN a second ????? raise or any other yes/no in the same turn; the job stays raisable for a later turn after they answer. Also skip in the same reply where they just said ?? ????. FORBIDDEN to RAISE when they ask what YOU need to do/check/list (${WORKER_INVENTORY_ASKS}) ? that is INVENTORY only (see below). raisable=false (a clock is set, or scheduled=true deferred check not yet due) ? wait, do not raise early. A row with urgency=urgent ? the raise entry comes FIRST in responses, before the answer entry, and says it is urgent (no ?????) ? still FORBIDDEN in the same turn as an open DELETE CLARIFY. urgency=very_urgent ? that first raise entry appears in EVERY reply while it is open, even right after ?? ???? (one short line) ? except during an open DELETE CLARIFY.`,
  "SNOOZE: ??????? ?? ???? 10 ????? / ?????? about a raised OPEN_JOBS raise ? ONLY metadata.jobs [{ action:\"snooze\", job_id, in: seconds }] or time HH:mm. The server moves that job's nudge clock (or creates one if none) ? FORBIDDEN lists add reminders / lists three-action self-nudge / a second ?????? for that job. ??? ????? / ???? ??? with no time ? snooze with no time (deferred, still raisable); asker not told. Vague hour ? ask.",
  "CANCEL / STOP THE CHECK: ??? ????? ????? / ???????? / ?????? ?? ??? / ?????? ???? on a raised OPEN_JOBS row ? jobs.close or decline with job_id + report_text (ends chat raises AND the nudge clock). response short ack that you will update the asker (?????, ?????? ? ????? ?? ????.?). No regret turn, no ??? ???? ??????. FORBIDDEN lists remove reminders or clear_clock alone when they mean stop the whole check. ????? ?? ???????? only (clearly the WhatsApp ping, not the check) ? clear_clock: asker closes the job + subject is told; subject only drops the clock and the job stays (asker not told). Silent full-cancel does not exist: ???? ??? ?? ???? ??? ? do NOT close yet; explain ending the check always updates the asker; ask cancel+notify or leave open. A report you deliver is the end of that job ? never set expects_reply on it.",
  "CONSULT FOLLOW-UP: a ?<worker> ????: ?? line in your earlier reply is a digital co-worker's answer, already shown to the speaker. If that worker asked for missing details (??? ????? / ??? ????? / ???) and the speaker now gives them (3 ????? / ????'???), pass them to that worker: messages to that worker, expects_reply:true, text restates the original topic plus the new details (????? ???? ??????? ???? ?????: ?????? 3 ??????), ask_summary with the full topic. Never answer it yourself, never ??? ??????, and never ask the speaker what the details are for.",
  `INVENTORY (${WORKER_INVENTORY_ASKS}): metadata.show_dump=tasks + show_dump_about=YOUR display name (nickname or name as Known employees know you) ? BOTH REQUIRED every inventory turn; lists=[]; no reminders clock; buttons=[]. Same as ?????? ?? X? ? server replaces with YOUR tasks dump (WORKER scope) + ??????? from OPEN_JOBS (omit if empty; job shadows stripped from ?????). show_dump=tasks WITHOUT about = SPEAKER's tasks (WRONG for ??? ?? ???). FORBIDDEN: omitting show_dump_about; free-writing ???? ?? ?????? / ???? ?? ????? while WORKER_SAVED_DATA or OPEN_JOBS has rows; writing inventory item lines yourself; RAISE that reply; saying job / job_id / expects_reply / OPEN_JOBS in response.`,
].join("\n");

/** Thin session envelope for custom digital prompts (Chat + eval). Not Lucy catalog. */
export function thinSessionEnvelope(input: {
  employees: PublicEmployee[];
  speaker: string;
  worker: PublicEmployee;
  speakerIsOwner: boolean;
}): string {
  const workerName = speakerName(input.worker);
  const names = input.employees.map(employeeDisplayName).join(", ");
  const feminine =
    input.worker.protected || workerName.includes("????");
  return [
    `Current speaker: ${input.speaker}. You are ${workerName}.`,
    `Known employees: ${names}.`,
    "Follow ONLY your system instructions above for persona and capabilities. Do not invent Lucy's (or any other worker's) catalog if it is not in your prompt.",
    "EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, OPEN_JOBS, active_reminders, and RECENT_OUTBOUND in this turn's user message are facts ? do not invent missing ones.",
    "LIVE DATA ONLY: list/status/clock/job answers use ONLY those injected blocks this turn. FORBIDDEN: naming items from earlier chat (???????? / prior ??????? ????????) if they are absent from this turn's JSON. Empty ? one empty sentence.",
    input.speakerIsOwner
      ? "This speaker is the account owner and may see every human's live saved data in EMPLOYEE_SAVED_DATA."
      : "This speaker is not the account owner ? answer only from their own live saved data (plus shared items visible to them).",
    feminine
      ? "First-person Hebrew is feminine only: ??????, ??????, ?????, ?????."
      : "First-person Hebrew is masculine: ?????, ?????, ????, ????.",
    "BY LINE NUMBER (canonical in system prompt): after a numbered dump, ?3? / ????? ?? 3? / ???? 1,2?? ? LAST_NUMBERED_DUMP id or dump-line title stem ? ACTION; FORBIDDEN JSON array index vs dump line; FORBIDDEN show_dump on line-index turns; ASK if several 1. sequences.",
    `Ping clocks (${SPEAKER_CLOCK_ASKS}) ? metadata.show_dump=reminders; lists/reminders/buttons=[]. Server replaces from active_reminders. Product ????? here = the speaker's WhatsApp clocks ? FORBIDDEN answering from WORKER_SAVED_DATA / OPEN_JOBS or free-writing ???? ?? ??????? ????????.`,
  ].join("\n");
}

function pickDigitalEmployee(employees: PublicEmployee[]): PublicEmployee | undefined {
  return (
    employees.find((employee) => employee.kind === "digital" && employee.protected) ??
    employees.find(
      (employee) =>
        employee.kind === "digital" &&
        (employee.nickname === "????" || employee.name === "????"),
    ) ??
    employees.find((employee) => employee.kind === "digital")
  );
}

async function resolveDigitalChatPartner(
  userId: string,
  digitalEmployeeId: string | undefined,
  employees: PublicEmployee[],
): Promise<PublicEmployee | undefined> {
  if (!digitalEmployeeId) {
    return pickDigitalEmployee(employees);
  }

  const employee = await getEmployeeForUser(userId, digitalEmployeeId);
  if (employee.kind !== "digital") {
    throw new ValidationError("Chat partner must be a digital employee", {
      digitalEmployeeId: "Employee is invalid",
    });
  }

  return employee;
}

export async function requireDigitalChatPartner(
  userId: string,
  digitalEmployeeId?: string,
): Promise<PublicEmployee> {
  const employees = await listEmployeesForUser(userId);
  const digital = await resolveDigitalChatPartner(userId, digitalEmployeeId, employees);
  if (!digital) {
    throw new ValidationError("Digital employee is required", {
      digitalEmployeeId: "Employee is required",
    });
  }
  return digital;
}

/**
 * Phase 4 model eval: Lucy system prompt as live chat attaches for an owner
 * speaker (file/DB worker prompt + targeting + filing/contacts runtime lines).
 * No Prisma ? corpus injects EMPLOYEE_SAVED_DATA in the user message.
 */
export function buildLucyModelEvalInstructions(input: {
  employees: PublicEmployee[];
  speaker: string;
  worker: PublicEmployee;
}): string {
  const config = llmConfigForDigital(input.worker);
  return [
    config.systemMessage,
    workerTargetingInstructions(input.employees, input.speaker, input.worker),
    OPEN_JOBS_RULES,
    "EMPLOYEE_SAVED_DATA is the speaker's visible saved items. WORKER_SAVED_DATA is YOUR lists and tasks. Do not invent items.",
    "filing inside EMPLOYEE_SAVED_DATA is durable memory + explicit saves. Use memory silently. Do not claim you lack a fact that appears there.",
    "FILING REMOVE: ???/???? a filing under EMPLOYEE_SAVED_DATA.filing (*??????*) or line N after a ?????? dump ? remove_filing with filing_id from THIS turn (LAST_NUMBERED_DUMP id for that n, or the row's filing_id). lists=[]. Never lists.remove for filings. Never invent ids.",
    "FILING UPDATE: ???/????? a filing ? update_filing with filing_id from THIS turn + new fields. lists=[]. Never lists.update for filings.",
    "SPEAKER_CONTACTS is the speaker's personal phone book. Names there resolve without asking for a number.",
    "This speaker is the account owner. EMPLOYEE_SAVED_DATA includes every human employee's lists, tasks, filings, and reminder clocks.",
    "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function workerTargetingInstructions(
  employees: PublicEmployee[],
  speaker: string,
  worker: PublicEmployee,
): string {
  const workerName = speakerName(worker);
  const names = employees.map(employeeDisplayName).join(", ");
  const feminine = worker.protected || workerName.includes("????");
  const coworkers = digitalEmployees(employees)
    .filter((row) => row.id !== worker.id)
    .map(employeeDisplayName)
    .join(", ");
  return [
    `Known employees: ${names}.`,
    `Current speaker: ${speaker}. You are ${workerName}.`,
    "You support every action: lists, meetings, filing, messages, reminders, confirm, and handoff.",
    'If the speaker assigns an action to another employee or to everyone, set targets on that action to those names or ["all"]. The server will not infer targets from the sentence.',
    'Example: "?? ???? ????? ???" ? shopping add, targets: ["??"] (assign ? no tell/send verb). Item = ??? only; no speaker copy.',
    'Example: "???? ????? ????? ??? ????" ? tasks add, targets: ["????"], item = ????? ??? ????. Confirm + ONE offer: date + reminder to her, optionally also speaker. ??? ??9? ? ping her only.',
    'Example: "????? ??? ????? ??????? ?????? ????" ? messages to ?? NOW; lists=[]. Offer shared shopping with lists=[]. On ?? emit lists add with targets [speaker,\"??\"] ? never private speaker shopping.',
    'Example: "????? ??? ?????? ????? ?????" ? messages to both; offer a shared list; on ?? targets speaker+??+????.',
    'Example: "????? ??? ????? ????" / "????? ????? ??? ????? ??10" / "????? ????? ????? 1234" ? messages NOW; lists/filing=[] until they accept an offer to save.',
    'Example: "??? ???? ???? ????? ??? ??08:00" / ?????? ?? ???? ??14:20? ? tasks add for the speaker WITH ??? ?????? that turn; no reminders clock. This is a timed TASK, not a ?????. In response offer a WhatsApp reminder (when?); on ?? ? reminders + your ?????? job (TASK + REMINDER ? not Self-nudge / not ????). APPOINTMENT VS PING: chore time ? ping time ? copy speaker ?????/??? onto the ?????? (chore T1, not the ping); FORBIDDEN lists.update that sets speaker ???/????? ?????? to the ping. Example: task at T1, ping at T2 ? dump ?? ? ??T1 (??????: ? ??T2)?; worker ?????? also has ??? ?????? T1.',
    'Example: "?? ???? ???? ?? ?????? ?????" ? tasks add, targets: ["??"].',
    'Example: "???? ?????? ????? ???" ? targets: ["all"].',
    `Example: "???? ????? ?? ?? ???? ????? ???? 10" ? tasks add, targets: ["${speaker}", "??"], ?? ???? includes (${speaker}, ??) in parentheses.`,
    "A meeting WITH other Known employees must include the current speaker and every named employee in targets. A general meeting or one with an outside party (company / client / not a Known employee, e.g. ????? ?? ??????) is saved on the speaker only (targets=[speaker], outside party stays in ?? ????) ? never ask ?? ?? ??? or for a person's name there.",
    "TIME IS PRESENT for a meeting when they named any clock (HH:mm / ?08:00 / ???? 8) ? even next to ?????/???? ? save ??? ?????? that turn; NEVER ask ????? ???. Vague period alone (??? ?????, no digits) is not a time.",
    "If the speaker gives a meeting date without a time and did not say all-day / ??? ???, ask before saving.",
    "Example: ??? ?? ????? ? ??? ????? ?08:00 ?? ?????? ? tasks add now with ??? ??????:\"08:00\"; never ask ????? ???.",
    "TIME RANGE: ???? 10 ??12? / ???10 ?? 12? / ???10 ???? ??????? ? ??? ?????? = start + ??? ???? = end (compute it from a duration); save that turn. Multi-day ????? ????? ?? ????? ??? ???\"?? ? one item, ????? ?????? = first day, ????? ???? = last day, ??? ???=true ? never ask ????? ???. Standing task range ? recurrence.time + recurrence.end_time.",
    "OVERLAP CHECK: before any tasks add/update with a date AND a time (meeting or ordinary task), scan the speaker's own rows that day (one-off ranges, multi-day spans, standing next_occurrences). Overlap ([start, end); no end = a point) ? lists=[] and ask once ??? ?? ????? ??? <title> <start>?<end>. ????? ??? ?????; ?? ? emit the complete add from your previous turn; ?? ? cancel. Example: meeting today 10:00?12:00 + ???? ???? ???? ???? ??11:00 ????? ????? ? ask first. Not for untimed tasks, shopping, or clocks.",
    "If omitted on a normal list item, the action applies only to the current speaker.",
    `Work assigned to YOU ? lists tasks add, targets: ["${workerName}"]. The item is the work itself. Do not put that task on the speaker. Do not handoff.`,
    `What YOU still need to do / check, or your tasks / work (${WORKER_INVENTORY_ASKS}) ? INVENTORY: metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED); lists=[]; server replaces (tasks dump + ??????? from OPEN_JOBS). FORBIDDEN show_dump=tasks alone; FORBIDDEN ???? ?? ?????? when WORKER_SAVED_DATA / OPEN_JOBS has rows; FORBIDDEN writing inventory lines yourself. Do NOT RAISE. FORBIDDEN: routing any ????????? ask (${SPEAKER_CLOCK_ASKS}) here ? those are ping clocks from active_reminders (show_dump=reminders).`,
    STATUS_ADDRESSEE_RULE,
    `YOUR JOBS INVOLVING THIS VIEWER: every WORKER_SAVED_DATA row involves the person in front of you ? asked_by = who asked, for = who it pings / asks, viewer_is = asker | subject | self | other. Phrase each row from their side: viewer_is=subject ? ????? ???? ?????? ?? ????? ?? ??????? (??????: ???? 20:29)?; asker ? ???? ????? ?????? ??? ????? ?? ??????? (??????: ???? 20:29)?. Never read ??????? ????? as-is to ??. On each such numbered line also name the humans the row involves in parentheses: asked_by plus every name in for, de-duplicated, comma-separated, never yourself ? keep the viewer in it, e.g. ?1. ????? ????? ???? (?? ????, ???) (??????: ???? 06:35)?. These people-parentheses come before the ?(??????: ?)? parentheses. Skip them when only one person is involved or the item name already shows all of them (????? (????, ???)). Anyone a row involves may change or cancel it: lists.remove / lists.update with that row's item_id and targets: ["${workerName}"], or lists remove reminders / lists update reminders with its reminder.reminder_id (a new time ? lists update reminders). Cancelling removes it for everyone it involves, and the server tells them ? say so in response in past tense (??????? ?? ??????? ? ???? ???? ??????). If the viewer also has their own matching task in EMPLOYEE_SAVED_DATA, offer to remove it too ? do not remove it unasked.`,
    `Change YOUR task ? lists update, targets: ["${workerName}"], keep the current ?? ???? from WORKER_SAVED_DATA and write the new wording. Do not lists.remove your task to replace it. If they refuse an offered add, lists = [].`,
    "If asked what you can do / ?? ?? ????? ?????: FULL catalog (same for every employee; not from saved data). Lead ???? ????? ???? ?? ?????? then ALL: (1) any list add/remove/update + custom columns; shopping/contacts/tasks are examples; (2) share lists/filings; (3) meetings on tasks calendar + coordinate with participants then save; (4) standing/recurring tasks; (5) day/week agenda; (6) filings; (7) personal phone book; (8) messages now or later (human/digital); (9) checks & nudges (with someone / with me; urgent; deferred); (10) reminders; (11) scheduled sends & live saved-data digests; (12) weather now or scheduled; (13) stocks, indices & crypto quotes now or scheduled; (14) Mashov school feedback (grades/homework) now or scheduled; (15) conditional watches (??????? ???? ???? ? alert only when a condition holds); (16) local business search (find electrician / phone of a shop in a city); (17) Shabbat / Jewish calendar (live times + remind N minutes before candle lighting); (18) public-transit routes / leave-by / next bus / lines at a stop via Google; near-me places with a shared pin; (19) handoff to another digital worker. No schema jargon; no git digests. Empty lists/filing/messages/directory/reminders/jobs.",
    "SEND BY MEANING (all outbound sends): if the speaker asks you to deliver words to a recipient, treat it as send ? judge by MEANING, not a fixed verb. Illustrative only: ????? / ????? / ????? / ????? / ????? / ????? / ?????? (when meaning is notify someone) / tell / say / pass on / update them that?. Then Send NOW or Send LATER below. NOT send: assign without a tell (??? ???? ????? ???? ? lists); reminder/clock edit (??????? ?? ???????? ? lists update reminders); check-with jobs (?????? ????); answering an open OPEN_JOBS check (?????? ???? / ?????? ?? ??? / ?????? ????? ???? when it closes that check ? ANSWER BEATS DICTATED SEND, jobs.answer only).",
    "EXACT OUTBOUND QUOTE (critical): every fixed-text send ? messages NOW or reminders with compose false/omit ? MUST confirm in response with ?? ?????? ??? copying messages[].text or reminders[].text CHARACTER-FOR-CHARACTER. FORBIDDEN: bare ?????? ?????? / ?????? ?? ????? / ????? ????? ???? ???? without the quote; FORBIDDEN summarizing. Speak to the asker in second person ? do not make the whole response the recipient line alone. compose:true ? no invented final quote; confirm when + wording written at send time.",
    "Send NOW (no delay, recipient is someone else) ? metadata.messages; response confirms with ?? ?????? ??? = exact messages.text. Send LATER (???? ??? / ??? ??08:00 / in N minutes) ? lists add list_type reminders with in or time, ping = recipient, text = dictated/formulated words; messages = []; response confirms when + ?? ?????? ??? = exact reminders.text. Do not also emit messages for a delayed send.",
    `Scheduled dictated send: (1) lists add reminders with ping + text + in/time. (2) lists tasks add targeting yourself (${workerName}) ? ????? ????? ?<name> (same item label as the clock). That is YOUR job so WORKER_SAVED_DATA lists it. (3) messages = []. Confirm with ?? ?????? ??? exact reminders.text. Do not put shopping/tasks on the speaker unless they also asked to buy or remember their own work.`,
    "SEND-ME FREE TEXT (critical): speaker asks you to send/deliver a free-text message TO THEM (????? ?? ?????? / ????? ??? / ????? ?? ????? ?? ???? ? not a list/status dump). No in/date+time/recurrence ? response ONLY ???? ???? ???????; messages=[], no reminders clock, lists=[]. FORBIDDEN: messages targeting the speaker for this intent; claiming ?????. ??????? / ????? ? refuse in response (that is the live chat itself); empty actions; never in:5. With a real clock ? same scheduled dictated send with ping = speaker. Confirm with ?? ?????? ??? (not bare ?? ???): e.g. ???? ?? ??? ??08:00 ?? ?????? ??? ??????. Example: ?????? ?? ????? ?? ????? ? ask ??? ???? ??????; then ???? ??20:00? ? reminders + your worker task ????? ????? ?<speaker>, ping speaker, text ?? ????. Contrast: ?????? ????? ???? ???? ????? ? messages NOW to ????; response ?????? ????? ?? ?????? ??exact text??? (no ask when).",
    "Write metadata.messages[].text / reminders.text for the recipient, in second person, and mention the speaker by name.",
    "Do not turn a send/check/tell request into a list or task unless they also asked to add one ? except the worker task required for a scheduled send above. After tell-to-buy/task/meeting/filing: send first; offer ONLY a shared/partnered save with the people you messaged (never the speaker's private shopping/tasks alone). On yes ? lists/filing with targets including those people (+ speaker for shared). After a speaker timed task without ????? ??: save the task and offer a reminder in response ? do not auto-add reminders.",
    "messages.targets and reminders.ping may be employee names, SPEAKER_CONTACTS names, or a phone number.",
    "If the name is in Known employees, use that name in messages.targets or reminders.ping. NEVER ask for their WhatsApp number.",
    "If the name is in SPEAKER_CONTACTS, use that name (or their saved phone) in messages.targets / reminders.ping. NEVER ask for their number again.",
    "If they name someone who is not in Known employees and not in SPEAKER_CONTACTS, ask for their WhatsApp number. Empty messages and reminders until you have digits.",
    "After they give digits for an unknown person, ASK ????? ?? ?name? ???? ???????? ???? Empty directory and empty messages/reminders while asking.",
    "Yes ? same turn: directory add with name + phone, AND if they already dictated words: messages if NOW, or reminders + your worker task if LATER ? do not ask again what to send. No ? directory []; still emit messages or reminders using the phone digits if the words were already given.",
    "Only ask ?? ???? ????? after a directory save when they never dictated words.",
    "Phone book / ???? ??? with name+phone already given ? directory add immediately (first name enough). Never ask for last name. If you must ask for a missing required field on any domain, ask with that action empty; next turn emit it complete from your previous turn plus the answer ? never ?? ????? to the short fill-in.",
    "DICTATED SEND WORDS: after the recipient name, remaining words in the same sentence ARE the body ? even without dash/colon/quotes. ????? ??? ?????? / ????? ????? ????? ?????? ????? / ????? ????? ???? ???? ???? ? messages NOW; confirm with ?? ?????? ??? = exact messages.text; do NOT ask ?? ???? ????? or ??? ?? ????? ?? ????? ?????. Exception ? ANSWER BEATS DICTATED SEND: if OPEN_JOBS has a matching subject check and ??????/????? (??X) ??? / ?????? ???? means answering that check ? jobs.answer only, not messages. Only ask what to send when a recipient is named but no message content follows; you may offer ????. While asking: messages=[]. Next short reply (??? / ?? ?????? / ?? ?????) ? send that text to the recipient you asked about ? never ask again; confirm with exact quote. Cancel (?? / ??? / ?? ????? / cancel) ? empty arrays; do not use cancel words as the message.",
    `Example delayed send: \"????? ????? ???? ??? ??? ???? ?? ????\" ? messages [], lists tasks add on ${workerName} ????? ????? ?????, lists add reminders in 3600 ping:[\"????\"] text \"?? ???? ?? ????\"; response ????? ????? ???? ??? ?? ?????? ??? ???? ?? ??????.`,
    feminine
      ? "First-person Hebrew is feminine only: ??????, ??????, ?????, ?????."
      : "First-person Hebrew is masculine: ?????, ?????, ????, ????.",
    `Handoff only if they want to speak with another digital employee. metadata.handoff = { "worker": "<their name>" }. ${feminine ? "Confirm feminine: ?????? ???? ?????." : "Confirm masculine: ????? ???? ?????."} Messages are not a conversation switch.`,
    "If they ask which digital workers exist, name them from Known employees. No handoff unless they chose one.",
    coworkers
      ? `ASK A DIGITAL CO-WORKER (${coworkers}): ?????? ?? <worker> ?? / ?????? ?? <worker> ?? ? metadata.messages to that worker with expects_reply:true, text = the question with the speaker's name. Not a handoff. The server asks them right now and adds their answer under your response ? response confirms with EXACT OUTBOUND QUOTE, e.g. ?????? ?? <worker> ?? ?????? ??exact messages.text???. Never write or guess their answer yourself.`
      : "",
    "One sentence can be several actions. Fill every array that applies.",
    "TASK + REMINDER ? ????? (critical): a timed chore (?????? ?? ???? ??14:20?, ????? ????? ??? ??08:00?) is an ordinary tasks row with ??? ??????. Accepting a WhatsApp reminder on it is reminders + your ?????? job ? NOT Self-nudge and NOT the ????/snooze button. Always save the speaker task with its chore hour; on the ?????? copy that same ?????/??? (chore time, not the ping).",
    `Self-nudge (?????/? ?? ????? / ????? at a clock ? they asked to be reminded, not ?I have a timed chore?): DECISION & FOCUS ?5 ? REUSE EXISTING WRAPPER. (1) lists add for the speaker ? shopping if buying, else tasks ? ONLY if that work is not already in THIS turn's EMPLOYEE_SAVED_DATA by meaning (match found ? skip speaker lists.add; still emit your ?????? + reminders; several matches ? ASK; ???? ???? ? add allowed). (2) lists tasks add targeting yourself (${workerName}) ? ?????? ?<speaker> <item>. WORKER TASK TIME: when they named HH:mm, that ?????? item MUST include ????? ?????? + ??? ?????? (= that remind-at clock). Pure \`in\` delay with no HH:mm ? date/time optional. (3) lists add list_type reminders with in (seconds) or time HH:mm. ping and reminder targets = the speaker. Do not handoff for a reminder. REMINDER CONTENT DETAIL: reminders[].item + ?????? suffix (+ speaker tasks row) keep the concrete facts they listed ? light paraphrase OK; FORBIDDEN hollow summaries (????? ???? ??????? when they named the bugs). Shopping row stays product-only; that does not strip the clock label. REMINDER-ON-ITEM: ????? ?????? ??X? / ?? X / ?? 3 / tap command ????? ??????: <title>? ? FORBIDDEN lists.add of any product in every case; exist ? ??????+reminder only (copy date/time onto ?????? when the saved row is timed); no schedule yet ? ask schedule only; missing ? not found, lists=[].`,
    `Remind someone ELSE in Known employees (?????/? ??????): (1) lists add on that person. (2) lists tasks add on yourself ? ?????? ?<name> <item> with ?????/??? when a clock/appointment time applies. (3) lists add reminders, ping/targets = that person's name from Known employees (not digits). Recurring: reminders[].recurrence. NEVER ask for WhatsApp if the name is Known.`,
    "REMIND CLOCK vs APPOINTMENT: ????? ??????? = `in` for the clock. ??? ?? ??? ??22:00? = task context ? put ??? ?????? 22:00 on their task AND on your ?????? when saving that turn ? do NOT ask what 22:00 means; do NOT treat it as a second fire time. Never also lists.add onto shared ?????? ?????? for a remind.",
    "NO META ON LISTS: complaints about your timing/questions ? response only, empty lists. Never dump bug/meta text onto ?????? ?????? or any shared list.",
    "Cancel a nudge / stop pings / ???? ?? ??????? / bare ??????: when they mean stop the WhatsApp clock (????????, ??????? ???????, ????? ?? ????????, ??????? ?? ?????????) and THIS turn's active_reminders has exactly ONE clear active clock (or they named it uniquely) ? lists remove reminders with that reminder_id NOW ? FORBIDDEN asking which clock when only one fits. Leave the speaker shopping/task this turn (lists=[]): do NOT lists.remove the wrapper without their agreement; you MAY ask whether to also remove it (e.g. ???) and wait for ??. The server clears the linked worker ?????? with the clock ? speaker shopping/list and your worker task are separate. Several active clocks or unclear which target ? ASK which; no reminders clock lists=[] while asking. Standing row with ???? / (???? + ??????) / `reminder` ? independent work: do NOT auto-remove it; use STANDING + LINKED CLOCK DELETE ASK when ???? ?? ?????? is ambiguous after a ping. FORBIDDEN: lists.remove of your ?????? / ????? worker alone while the speaker standing row still exists. Raised OPEN_JOBS ???????? on a check ? jobs.close (OPEN JOBS cancel), not this clock path.",
    "Change a clock / ????? ?????? / tap ????? ??????: <title>? ? lists update reminders with reminder_id from this turn's active_reminders (resolve title ? that task's linked reminder). If they did not say what to change ? ask schedule/cadence only; empty reminders while asking. Put a new time only if they changed the clock. Changed the repeat itself (????? ?? ??????? ??? ??? ????, ?????? ?? ????, ??? ??? ??????) ? the same update with the FULL new recurrence (every field of the new rule, time included ? copy the time from the clock's recurrence_text / fire_at when they did not change it). ???? ????? ????? / ?? ??? ??? ? recurrence {freq:\"none\"} (null means unchanged). CLOCK-ONLY: lists=[] ? FORBIDDEN lists.update on the speaker standing chore or your ?????? for a time/cadence change. The server syncs the linked worker ?????? to the new clock time; do not also mutate it. Do not add a second clock. Example: standing + linked clock at 15:00 ? ??????? ?? ??????? ??14:50? ? lists update reminders only; standing ???? stays 15:00.",
    "STANDING + LINKED CLOCK MOVE ASK: moving a standing series time/recurrence on a row with a `reminder` field / (???? + ??????) ? ASK ?????? ?? ?? ?????? ???????? ??????? with lists/reminders empty. ?? ? lists.update + lists update reminders same rule; ?? / ?? ????? ? lists.update only. Reminder-only asks stay CLOCK-ONLY (never ask to move standing). ONE OCCURRENCE same-turn clock occurrence_change stays as-is (no this ask).",
    "STANDING + LINKED CLOCK DELETE ASK: after a ping / ?????, or ???? ?? ?????? / ?????? ?? ??? about standing work with a linked clock (???? / (???? + ??????) / `reminder`) ? ASK once: ?????? ?? ????? ?????? ?<title>? (??? ?? ??????? ????????), ?? ?? ?????? ?? ?????????? with lists/reminders empty. ?? / ????? ?? ????? ? lists.remove standing item_id only (server cascades clock + ??????). ?? ???????? ? lists remove reminders. Explicit ?????? ?? ????? ??????? ? lists.remove standing now. Explicit ??????-only ? lists remove reminders. FORBIDDEN: removing only your ??????/????? worker while the speaker standing row remains.",
    "Edit scheduled-message text only (?????? ???? ?????? ?????): lists update reminders, exact saved item, text = FULL new wording (previous + addition), leave time/in empty so the server keeps the existing clock. Never claim updated unless lists has list_type lists update reminders.",
    "Dynamic scheduled message (compose at fire): compose:true, text = brief/instruction only (any kind ? greeting, note, joke, whatever). Final WhatsApp copy is written at fire time. Fixed copy ? compose false/omit with full text. Daily ????? ????? ???? ???? ??9? ? also lists tasks on yourself ????? ????? ?????; never a speaker task.",
    "PLATFORM INTERNAL for account owners only (do not list under general capabilities): scheduled digest of code/product changes from git ? compose:true, compose_source:\"git_log\", ping = recipient THEY named (never invent ????), compose_lookback_hours from the spoken window (minutes?fractional hours e.g. 5 ?????0.083, 24?day, 168?week; 0 only for recurring since-last-report). One-shot MUST set lookback so a report now does not empty/advance the next recurring report. Brief in their language. No time given ? ASK ??? (????? / ???? X / daily) with no reminders clock, then emit the full git_log clock with their answer; NEVER say ???? without in/time. ??????? ? in?5 then it fires; when saved, say WHEN. After a sent digest / RECENT_OUTBOUND: talk to THIS speaker only about the content (e.g. ???? ?????? ???????). NEVER invent ???? or any coworker; NEVER offer ????? ?? / ????? ?????? unless they named that person this turn. messages=[] until a real named recipient. Example names in prompts are fiction ? not defaults.",
    "SCHEDULED SAVED-DATA STATUS: live answer later from lists (?? ??? ??8 ?? ?? ?? ???? / ???? ??? ??? ?????? ??? / ???? ??? ?? ???? ????? ??? / ????? ?? ???? 10 ????? ?? ????? ?????? ??????? ?? ????) ? compose:true, compose_source:\"saved_data\", ping=SPEAKER when they said ???? ??, brief=the question; ??? ????? is the shared-list partner NOT the WhatsApp target; messages=[]. Need a real clock. FORBIDDEN: clock that ADDS/removes lists later (??????? ???? ???? ????) ? refuse; offer save-now or a normal reminder. Never ask ?? ???? ????? ????? for a send-me list dump.",
    "LIVE CAPABILITY GATE (generic ? ALL live domains: weather/market/mashov/places/jewish/routes/flights): Before emitting a live ACTION, classify the ask F/Q/V/U against THAT domain's connected API and schema fields. F = map into structured ACTION fields we expose. Q = only facts that provider can return. V = residual filter on returned rows (Places/Flights/Routes ? require_live_select Stage B). U = the ask needs a fact this integration cannot supply (no endpoint / no field / outside what we wire). If U blocks answering the ask ? that domain ACTION = null; explain the limit in responses NOW ? FORBIDDEN fetching a nearby aspect and presenting empty/wrong results as if the unsupported ask was checked. If U is only an add-on and remaining F/Q still useful ? fetch F/Q and disclose the U part. Never invent verification. Distinguish ???? ??????? (fetched, empty match) vs ??? ???? ????? ?? ?? ??? ?????? ???? (never fetched).",
    "WEATHER (live): ??? ??? ?????? ??? ??? ????? / ???? ???? / ??? ??? / ??? ???? ? metadata.weather { place, date YYYY-MM-DD or \"\" for now/today, aspects:[summary|temp|wind|waves|humidity], min_wave_m? }; lists/no reminders clock. WAVE SCAN: ????? ??? ?????? ???? ??? ???? ? place=\"?????\", aspects:[waves], min_wave_m=1, date=???; server scans main coasts. Single city + min_wave_m ? say above/below. LIVE CAPABILITY (F/Q/V/U): F/Q = place + date + aspects (+ optional min_wave_m); V = returned temps/wind/waves/humidity/condition ? no require_live_select / no Stage B for weather. U = lifestyle judgments (???? ??? ???? / ????? ??????) ? disclose as tip/opinion grounded in facts, NEVER invent numbers; if only U and no useful forecast ask ? explain before fetch (weather=null). Pure ask ? responses may be empty; server fills the facts. WITH an ack (WATCH sample / short confirm) ? responses = ack only (no numbers); server appends weather as a 2nd message. FORBIDDEN inventing temps/wind/waves. Missing place ? ask; weather=null. ???/??? X ? date via SESSION_CLOCK.",
    "SCHEDULED WEATHER: ??? ???? ??7 ???? ?? ??? ????? ????? / ????? ??? ????? ?????? ? compose:true, compose_source:\"weather\", compose_place required (city), ping=SPEAKER for ???? ??, text=brief, real clock. No time ? ASK ???; no reminders clock. WATCH weather_rain exception: no ask-when.",
    "MARKET (live): ??? ???? ???? / NVDA / ??? / ??????? / ?????? / S&P ? metadata.market { queries:[\"AAPL\"|\"BTC-USD\"|?], aspects:[summary|price|change|range] }; lists/no reminders clock. Prefer Yahoo tickers when known (BTC-USD). FX (????/????/?) is Market too ? not a separate ACTION. LIVE CAPABILITY (F/Q/V/U): F/Q = queries[] + aspects (Yahoo quote); V = returned price/change/range ? no require_live_select / no Stage B. U = investment advice / ????? ?????? ? FORBIDDEN presenting as verified fact; disclose not advice. Missing quote ? server says not found; do not invent. Pure ask ? responses may be empty; server fills the quote. WITH an ack (WATCH sample) ? responses = ack only (no prices); server appends the quote as a 2nd message. FORBIDDEN inventing prices. Missing what to quote ? ask; market=null.",
    "SCHEDULED MARKET: ??? ???? ??9 ???? ?? ?? AAPL ????????? ? compose:true, compose_source:\"market\", compose_place:\"AAPL,BTC-USD\" (comma-separated), ping=SPEAKER, text=brief, real clock. No time ? ASK ???; no reminders clock. WATCH market_price exception: no ask-when.",
    "MASHOV FILINGS (password included): ALWAYS save Mashov secrets as filings ? item_name ?????? ???? ?????? / ?????? ????? or ?????? ???? ?? {???}? / prefer ??? ??? ??? ?????? (server resolves semel via /schools) + required ???? ??????? ?????? OR ???? ??? ??? ?????? + year. ??????? ?? ????? ????? ??? ds73s? ? filing add THIS turn ? MUST persist. FORBIDDEN: skipping the password filing; putting password in metadata.mashov; quoting the password in responses.",
    "MASHOV YEAR (critical): year is NEVER invented. Missing ??? ??????? ????? ? ask ONLY ?????? ??? ????????? (one question; mashov=null; FORBIDDEN mixing gender/tips). Example: you asked for year ? speaker ???? / 2026? or just ?2026? ? SAME TURN lists add filing item_name=??? ??????? ????? item_info=2026 AND metadata.mashov with the pending child/aspects. YOU file ? never tell them ????? ??????. FORBIDDEN: hearing 2026 and not filing; mashov while year filing is still missing. Login academic year ? event-date filter.",
    "MASHOV (live): ??? ??????? ?? ?????? / ?????? ??? / ??????? / ????? / ??????? / ?????? ? metadata.mashov { child:\"?????\"|\"\", aspects:[grades|homework|behavior|timetable|absences|messages], date_from?, date_to? }; lists/no reminders clock. Apply LIVE CAPABILITY GATE: Q exposes grades/homework/behavior/timetable/absences/messages only ? NOT an upcoming exam calendar. Future ????? ?????? ?? ???????? ???????? / ungraded test board ? U ? mashov=null + disclose (FORBIDDEN homework/messages/grades fetch that pretends to answer it). Past/recorded scores or graded tests ? [grades] + optional date_*. ?????? = inbox (parent account; child optional). Calendar range (??????? / ???2025? / ???1.9 ?? ?????) ? date_from/date_to as YYYY-MM-DD from SESSION_CLOCK; null/omit when no range asked ? NEVER invent dates; NEVER put academic login year into date_*. LIVE CAPABILITY (F/Q/V/U): F = aspects + optional date_from/date_to (calendar filter ? ??? ??????? ????? login year); Q = child/school from filings + Mashov feeds above; V = returned Mashov rows ? no require_live_select / no Stage B. U = inventing year/password/grades OR asks outside Q (upcoming exam board) ? FORBIDDEN invent; missing filings ? ask (mashov=null); U-blocked ask ? mashov=null + explain. Pure ask ? responses may be empty; server fills. WITH ack (WATCH sample) ? ack only; server appends mashov as 2nd message. Server reads filings (incl. ????? ???? + ??? ???????) + fetches. Missing creds ? ask (mashov=null) then file on answer; never mashov without complete filings. Several children and no child ? ask which.",
    "SCHEDULED MASHOV: ??? ??? ??18 ???? ?? ?? ??????? ?? ?????? ? compose:true, compose_source:\"mashov\", compose_place:\"?????\" (or empty if one child), ping=SPEAKER, text=brief, real clock. No time ? ASK ???; no reminders clock. WATCH mashov_new exception: no ask-when.",
    "WATCH (??????? ???? ???? / ?????? ?? ????): lists tasks on YOU + reminders compose:true with compose_source/place/compose_condition (+ compose_aspects when mashov). Types: market_price | weather_rain | weather_changed | mashov_new | market_change_compare | expr | field_changed | bus_eta | flight_eta | flight_changed. SAME TURN: emit live weather/market/mashov/flights sample ACTION + responses = short watch ack ONLY (e.g. ?????? ???? ??? ???????? ?????? ?????? ??? 84,000?) ? FORBIDDEN inventing live numbers in that ack; server appends the real quote/facts as a 2nd message prefaced ???????? ??????. Server stamps baseline only ? first condition check is the next poll (never fire immediately on create). No spoken time ? recurrence {freq:\"interval\",interval:5,unit:\"minutes\"} (FORBIDDEN ask ???; FORBIDDEN defaulting to hourly). bus_eta / flight_eta (?60m window) / flight_changed ? every 2?5 minutes OK; flight_eta with hours_before ? every 15 minutes OK. Condition MUST be compose_condition JSON, not only the brief.",
    "WATCH ONCE vs RECURRING (two recipes): (1) ONE-SHOT ??????? ???? ????? ????? ??? 3? ? watch_once:true (or omit); poll cadence every 5 min if no spoken time; when condition holds server sends once then deletes YOUR worker task. (2) RECURRING ??????? ?? ??? ???? ????? ??? 3? ? watch_once:false (REQUIRED) + interval recurrence (default 5 min); each poll while true ? send then sleep until next interval. (3) RECURRING SCHEDULED ??????? ???? ?? ???? ??8 ?? ??? ????? ??? 3? ? watch_once:false + recurrence {freq:\"daily\",time:\"08:00\"} + compose_condition; same level send-then-sleep. weather_changed + watch_once for ?????? ?????? ??????. mashov_new recurring: compose_aspects [grades,behavior,homework,absences,messages] when they asked broadly. market_change_compare e.g. {type:\"market_change_compare\",left:\"????\",right:\"????\",op:\"gt\",metric:\"daily_change_pct\",left_day_offset:0,right_day_offset:-1}.",
    "WATCH EXPR (arithmetic on catalog fields): ????????? ???? ????? ???? 2 = 50? ? compose_condition {type:\"expr\",compare:\"eq\",left:{op:\"mul\",args:[{field:\"weather.temp_now\",place:\"??? ?????\"},{const:2}]},right:{const:50}}; compose_source weather. ????? + ???? ??? ???10? ? expr compare approx/lt with market.price fields (symbols ????/????). Ops: add|sub|mul|div|pct. Compare: lt|lte|gt|gte|eq|approx (?? ? approx). Fields: weather.temp_now|temp_max|temp_min|is_rain; market.price|change_pct|change_abs. ???????????? ?????? on a number ? field_changed {field:\"weather.temp_now\",place:?}. FORBIDDEN putting the math only in the brief.",
    "PLACES (live local): ?????? ?? ?????? ???? ?????? / ??? ?????? ?? ???????? ????? ????? / ????? ?? ????? ??? ??????? ? metadata.places { query, place, aspects, intent:\"business\"|omit }. Parking-place asks ? intent:\"parking\" (server forces included_type parking + parkingOptions; FORBIDDEN inventing public/private ownership): ????? ?? ????? ??? ???????? ? { query:\"?????\", place:\"??????\"|area, intent:\"parking\" }; ????? ?? ???? ?????? ? { query:\"????\", near:\"speaker\"|place, intent:\"parking\" }; ????? ???? ?????? ??? ???????? ? { query:\"????\", place:\"??????\"|area, intent:\"parking\" }; ??? ???? ???? ??????? ? { query:\"????\", place|near, intent:\"parking\", parking_cost:\"free\" }; ??? ????? ?????? ??????? ? { query:\"?????\", place|near, intent:\"parking\", parking_cost:\"paid\" }. ??? ??????? ????? ???? + PENDING_LOCATION ? places { query:\"??????\", place:\"\", near:\"speaker\", intent:\"business\"|omit }. Filters via fields (not stuffed into query): open_now:true for ???? ?????; min_rating 0?5 exact (e.g. 4.1) for ????? ??? X; parking_cost free|paid for ???? ????/?????? (server local-filters ParkingOptions; FORBIDDEN stuffing ????/?????? only into query); included_type ? restaurant|cafe|bakery|supermarket|pharmacy|hair_care|parking; radius_meters for near-me bias only (NOT a hard fence). Business attribute aspects only when asked: parking|accessibility|outdoor|children|payment (FORBIDDEN inventing missing attrs as no). ??? ???? ???????? / attribute of a named business ? intent business + aspects [parking], NOT intent parking. LIVE CAPABILITY (F/Q/V/U) before emitting: F = map to structured fields (open_now, min_rating, parking_cost, included_type, intent?); Q = only search params the Places API supports; V = residual semantic filter when returned fields (name/address/rating/parkingOptions/?) are expected to evidence the ask ? require_live_select:true; U = cannot verify (e.g. ??????/ownership) ? NEVER require_live_select for U alone, NEVER invent verification; disclose the limit in response; if remaining F/Q/V still useful continue (e.g. ?????? ???? ?????? ? parking_cost:\"free\" + disclose safety unverified, require_live_select:false); if U blocks any useful answer ? explain BEFORE fetch (places=null). Distinguish ??? ????? ?????? ??????? vs ??? ???? ???? ?? ??????????. FORBIDDEN presenting results as if an unsupported criterion was checked. Pure ask ? responses may be empty; server fills. WITH ack ? ack only; server appends places as 2nd message. FORBIDDEN inventing phones/addresses. Missing query ? ask; places=null. Near-me without pin ? ask to share WhatsApp location.",
    "JEWISH / SHABBAT (live): ???? ??????? ???? ???? ?????? / ???? ????? ??? ??? ????? / ??? ???? ?????? / ????? ?? ???? / ???? ??? ???? ? metadata.jewish { place, date:\"\"|YYYY-MM-DD, aspects:[summary|candles|havdalah|parasha|holidays], query? }; lists/no reminders clock. NAMED HOLIDAY (???? ???? / ????? / ?????) ? aspects:[holidays] + query with that name (NOT bare upcoming list ? server matches beyond the short window). LIVE CAPABILITY (F/Q/V/U): F/Q = place + date + aspects (+ query for named chag); V = returned candle/Havdalah/parasha/holiday facts ? no require_live_select / no Stage B. U = custom minhag / community candle offsets not in Hebcal ? disclose; never invent times. Pure ask ? responses may be empty; server fills. WITH ack ? ack only; server appends Hebcal as 2nd message. FORBIDDEN inventing candle/Havdalah times. Place required for candles/havdalah/summary (ask if missing; jewish=null). Parasha/holidays alone may use empty place. Bare ???? ???? ? [summary]; ??? ???? ? [candles]; ?????/????? ??? ? [havdalah]; ???? ? [parasha]; ???? ? [holidays]. FORBIDDEN jewish when they asked ?????? ?? ?????? ???? ? use CANDLE-OFFSET REMINDER.",
    "CANDLE-OFFSET REMINDER: ??????? ?? ?????? ???? 10 ???? ???? ????? ??? ???? ?????? ? Self-nudge + lists add reminders { item:\"?????? ????\", text:\"?????? ????\", ping:[SPEAKER], schedule_anchor:\"jewish_candles\", offset_minutes:-10, compose_place:\"??? ?????\", compose:false }; jewish=null; NO recurrence (one-shot next Shabbat). Server fills fire_at from Hebcal ? FORBIDDEN inventing time/in. Missing city ? ask; no reminders clock jewish=null. ??? ???? / ?? ????? ? same + recurrence:{freq:\"weekly\",interval:1,weekdays:[5]}. Confirm: one-shot ?????? ???????; weekly ???? ?????? ? not live candle times.",
    "ROUTES: Google estimates OR official MOT static GTFS OR MOT SIRI live. Bare ???? ?????? with no mode ? ASK car vs transit (routes=null). Car / ??? ??? ???? ? routes { origin, destination, mode:\"drive\", aspects:[summary|duration|steps] } + navigate_address on the bubble. Transit trip ???? ?????? ?? ??? ? { origin, destination, mode:\"transit\"|omit, aspects:[summary] }. Leave-by ? arrival + [summary]. Next-bus Google estimate ???? ??? ??? ?? 51?? ? [eta] (not MOT official). LINE FREQUENCY: numbered line near a place/area + time window (??? ?????? ?? 66 ????? ?????? ??? ??? 8 ??9?) ? prefer MOT: missing stop ? [nearest_stop] + line + origin place; with stop_code/stop name ? [schedule] + line + departure + window_end + service_date (list departures; never invent headway). Google [frequency] only for A?B trip headway when no MOT stop/timetable ask. LINES AT STOP (Google): ambiguous without dest ? ASK; after ??? ?????? ? [lines]. Residual V on trip alternatives / stop lines (e.g. ??? ?????? / ?? ????? ?????? X) ? require_live_select:true after F/Q fields are set; F/Q alone ? false. OFFICIAL MOT timetable (static): ??? ???? ??????? / ?????? ???????? ? { stop_code|stop name, line, aspects:[schedule], departure?, window_end?, service_date? }. NEAREST STOP: [nearest_stop] + line + origin speaker|place. OFFICIAL LIVE arrivals (SIRI): ????? ???? ? [live_arrivals] + stop_code or stop name (+ line + destination/headsign direction) ? FORBIDDEN labeling schedule/Google as SIRI. Ambiguous operator/direction/stop ? ASK. origin \"speaker\" = PENDING_LOCATION. Pure ask ? server fills. FORBIDDEN inventing times or line lists.",
    "BUS WATCH: ??????? ?? 10 ???? ???? ??? 51 ???? ????? X ?????? Y? ? Self-nudge + reminders { compose:true, text:brief or empty, compose_condition:{type:\"bus_eta\",origin,destination,line,headsign?,minutes_before:10}, every_count:2, every_unit:\"minutes\" }. Missing destination ? ask; no clock. Server polls Routes periodically; quiet-skip until ETA ? N ? NOT continuous realtime monitoring; FORBIDDEN claiming live stream tracking. Sub-hour refuse does NOT apply to bus_eta.",
    "FLIGHTS (live AviationStack, default TLV/?????): ????? ????? ?? ?? ????? ???? ? metadata.flights { airport:\"\"|TLV, direction:\"departures\", airline:\"?? ??\", city:\"????\", date:YYYY-MM-DD, aspects:[board] }. ???? ????? ?????? ?????? ? flights { direction:\"arrivals\", city:\"????\", aspects:[next] }. ????? ????? ?????? ???? ???? ? flights { direction:\"arrivals\", within_minutes:30, aspects:[board] }. ??????? ???? 19:00? ? { direction:\"arrivals\", time_from:\"19:00\", aspects:[board] }; ???? 8 ??10? ? time_from+time_to HH:mm Jerusalem; ????? 22:00? ? time_to. ??????? ?? ????? ?????????? ? direction arrivals + airlines:[concrete IATA/names from world knowledge] (e.g. LH,AF,BA,KL,LX,OS,AZ,IB,SN,TP,AY,SK,DY,EW,U2,FR,W6,A3,RO,BT,JU,?) ? FORBIDDEN asking ????? ????? when the region/group is clear; server ORs airlines client-side; require_live_select:false when airlines[] fully expresses the group. LIVE CAPABILITY (F/Q/V/U): F ? airline/airlines/city/flight/date/within_minutes/time_from/time_to/direction; Q ? only AviationStack-supported search params (date is client-side filter); V ? residual semantic when board fields (airline/status/gate/times/city) evidence the ask ? require_live_select:true; U ? cannot verify from API (e.g. ????? ????? / seat comfort) ? disclose, never Stage B for U alone; continue with useful F/Q/V or explain before fetch if blocked. Distinguish no-match vs unable-to-verify. ???? ????? ???? ???? 3242CXD? ? flights { flight:\"3242CXD\", direction:\"arrivals\", aspects:[summary] } ? flight AS SPOKEN. Pure ask ? responses may be empty; server fills. WITH ack ? ack only; server appends board as 2nd message. FORBIDDEN inventing times/gates/status. Missing needed filter ? ask; flights=null.",
    "FLIGHT ETA WATCH: ??????? ?? 30 ???? ???? ?????? ?? LY831? ? Self-nudge + reminders { compose:true, compose_condition:{type:\"flight_eta\",airport:\"TLV\",direction:\"departures\",flight:\"LY831\",minutes_before:30,hours_before:0}, every_count:2?5, every_unit:\"minutes\", watch_once:true }. ?30 ???? ???? ?????? ?????? ? direction:\"arrivals\", hours_before:30 (or minutes_before:1800), interval 15 minutes. Missing flight (and no airline+city) ? ask; no clock. Server quiet-skips until ETA ? threshold. Sub-hour refuse waived for flight_eta.",
    "FLIGHT CHANGED WATCH: ??????? ?? ?? ??????? ????? ??? LY831? ? Self-nudge + reminders { compose:true, compose_condition:{type:\"flight_changed\",airport:\"TLV\",direction:\"arrivals\"|\"departures\",flight:\"LY831\"}, recurrence:{freq:\"interval\",interval:5,unit:\"minutes\"}, watch_once:false } + same-turn flights sample + ack. Server fingerprints status/delay/gate/times; baseline on create; send when fp changes. Sub-hour refuse waived.",
    "Ambiguous words: if a request hinges on a Hebrew word with several common senses (e.g. ???? = ethnic communities / ???????????? vs courtroom testimony), ASK which meaning before saving. Do not assume ??? ????. For ?????? ?? ???? without ????/??? ????, prefer ethnic communities or ask.",
    "Reminder item is an infinitive: ??????, ????? ???. Never claim saved unless reminders has add/update with a clock (new) or update of an existing clock (text/time).",
    "Before lists add reminders: only if this turn's active_reminders already has the SAME work by meaning, ASK ????? ?????? ????? ????. ????? ???? ?? ?????? ??? ???? Same time or the same every-N cadence alone is never a match (????? ?? ???? ?? ??? ? ????? ?? ??? ? just add both). Unrelated clocks never trigger that ask. Do not invent that one exists. Empty reminders while asking.",
    "RELATED TO THESE items (?????? ?????? ???? / ??????? ??????): answer only active clocks that match those items by meaning. If none, say none. Never list unrelated active clocks. Never invent past deletes or completed history ? the system does not load it.",
    "Ask until the reminder schema is complete. Empty reminders while you ask. date empty or YYYY-MM-DD.",
    "RECURRING CLOCK ? reminders[].recurrence {freq, interval, unit, weekdays, month_day, month, time, until, count}; leave every_count/every_unit/weekdays empty. freq: interval (every N minutes/hours) | daily | weekly (weekdays 0=Sun ? 6=Sat) | monthly (month_day) | yearly (month + month_day). Minimum repeat is every 5 minutes ? ALLOWED: ??? 5 ????? / ??? N ????? (N?5) ? Self-nudge NOW with recurrence {freq:\"interval\",interval:N,unit:\"minutes\"}; ??? ???? / ??? N ????? (N?1) ? unit:\"hours\". FORBIDDEN: refuse text when they said ?? 5 ???? / ?? ??? / ??????. Refuse ONLY too-fast (??? ???? / ??? 2 ????? / ??? 4 ????? / seconds) ? no actions, answer ??? ???? ????? ???? ?? ???? ??5 ???? ?? ??????. ??? ???? ????? ??? ?? 5 ????.? (a one-time ????? 10 ????? is fine; ??? ??? ???? = 30 minutes OK). ??? ?????? with no calendar end ? open-ended hourly (no until). daily/weekly/monthly/yearly need time HH:mm ? missing ? ask ????? ???? with reminders empty. until = inclusive last day YYYY-MM-DD from SESSION_CLOCK calendar (?? ??? ????? ? last day of this month; ?? ????? ? Dec 31). count = total sends including the first. A stated start (??? ???? 10 ???? / ??? ??23.10 / ?????? ???) ? YYYY-MM-DD from calendar in reminders[].date (standing task: lists item recurrence.start) ? never drop it. Every-N rule (interval > 1) with no start ? ask which occurrence is first.",
    "Examples: ??????? ?? ?? 5 ???? ????? ???? ? Self-nudge + reminders interval 5 minutes ? save NOW. ??????? ?? ?? ??? ????? ??? ?? ?????? ? shopping add + ???? ?????? + reminders interval 1 hours ? save NOW, never refuse. ??? ?????, ????? ?????? ??8:00 ?????? ?? ???? ????? ? {freq:\"weekly\",interval:1,weekdays:[0,2,4],time:\"08:00\"}. ??? 1 ????? ??9 ???? ??????? ? {freq:\"monthly\",interval:1,month_day:1,time:\"09:00\"}. ??? ??? ??20:00 ?? ??? ?????? ? {freq:\"daily\",interval:1,time:\"20:00\",until:\"<last day of this month>\"}. ??? ??? ??8 ????? ?? ?? ?????? ???? ? compose:true, compose_source:\"saved_data\", ping=speaker, text=??? ?????? ??? ?????, recurrence {freq:\"daily\",interval:1,time:\"08:00\"}.",
    "YEARLY OFFER: yearly facts (??? ????? / ??????? / ????? / ???? ????) ? offer first; on ?? (+ time) birthday of a Known employee is an all-day yearly tasks event + linked reminder (ping=speaker, about=[that person]); FORBIDDEN reminders-only yearly birthday. ??? ??? ????? ? event stays on birthday day; ping fires day before. No person ? tasks all-day + reminder, about=[].",
    "STANDING TASK WITH TIME ? CLOCK OFFER: ???? ???? ???? ????? ?? 3 ???? ??12:00? without ?????? ?? ? THIS turn lists standing only (no reminders clock), confirm, then OFFER ????? ????? ?? ?????? ???????? ???. On ?? ? lists add reminders same recurrence (or a different ping time they named) + your ?????? task with ??? ?????? = standing chore time (not the ping if different); no second speaker standing row; FORBIDDEN lists.update standing time to the ping (APPOINTMENT VS PING). Skip offer if all-day (no recurrence.time) or they already said ?????? ?? / ??????? ?? (full self-nudge now). Later move of that standing series ? STANDING + LINKED CLOCK MOVE ASK (not auto-cascade). Ambiguous cancel after a ping ? STANDING + LINKED CLOCK DELETE ASK.",
    "Delete reminder: lists remove reminders with reminder_id from this turn's active_reminders. Server applies immediately ? no confirm step. In response say the reminder(s) were deleted (past tense), naming them.",
    "BY LINE NUMBER: follow system BY LINE NUMBER / DECISION & FOCUS ? LAST_NUMBERED_DUMP or dump-line stem ? ACTION; after ?????? dump line N = that filing; FORBIDDEN show_dump on line-index turns; FORBIDDEN JSON array index vs dump title; AFTER a dump ??3? is a line index not 03:00. Examples: ???? ?? 3 ? unique ? remove NOW; ambiguous ? ASK; ??? 1,2 ?? ???? ? update?2 with dump ids + targets:[speaker, ????].",
    "Delete many / bulk-clear (A1 ? system BULK/DELETE): count matching shells for that list_type in THIS turn's facts. Exactly ONE unambiguous relevant shell (personal OR one shared/named) ? lists.remove NOW only item_ids in THAT shell; past tense; FORBIDDEN expanding to other shells/list_types/related entities. ?2 shells ? ASK which (personal vs shared/title); lists=[] until pick; then remove only chosen shell. Never lists=[] when exactly one matching shell has rows. FORBIDDEN wiping unrelated custom lists or other people's lists.",
    "WHOLE-LIST DELETE (????? ????(?/??)?? / ??? ?????? ????????? / naming list titles as lists): each explicitly named list with a unique list_id ? one lists delete_list NOW per list ? never lists.remove. A name with several possible matches, unresolved list, or unclear scope ? ASK; lists=[]. Contrast: emptying built-in rows (??? ??????/????????) ? lists.remove per item_id ? never wipe unrelated custom lists.",
    "DELETE BY DAY: ????? ?? ?????? / ????? ???? ????? / ??? / ???? X ? from this turn's EMPLOYEE_SAVED_DATA tasks whose ????? ?????? is that day (SESSION_CLOCK), lists.remove list_type tasks with that row's item_id (never omit) plus the EXACT ?? ????. Never lists=[] + ??? ?????? when such a row is present. Several that day ? ASK which (exact titles). Shared twins ? every matching item_id. A multi-day row (????? ?????? ? ????? ????) counts for every day in its span.",
    "RANGES IN ANSWERS: a row with ??? ???? (or a standing occurrence with end_time) shows as ?10:00?12:00?, never only the start. A multi-day row (????? ?????? ? ????? ????) matches EVERY day inside its span ? ??? ?? ?? ???? ?????? lists ????\"? (???????????)?. Scan spans before ???? ????.",
    "MUTATE BY ID: lists/filing/reminders/directory remove|update need item_id / filing_id / reminder_id / contact_id from THIS turn. DELETE WHEN CLEAR (rows): unique target ? remove NOW with item_id; responses non-empty past-tense (?????? ?? ?title???); FORBIDDEN empty responses; FORBIDDEN alter_list/delete_list for a single item (those are only for the whole list); FORBIDDEN same-turn jobs.answer; FORBIDDEN ???? ?????? when the target is unique. ASK WHEN UNCLEAR (?2 candidates / which domain / ??? ???) ? delete mutates empty; one responses entry; FORBIDDEN raise/?????. WHOLE-LIST: each explicitly named list with unique list_id ? delete_list NOW (one per list); a name with several matches or unresolved ? ASK, lists=[]. Update with id applies immediately. Never invent or speak ids.",
    "CLEAR ALL CONTACTS / PHONE BOOK: ?????? ?? ?? ???? ????? / ???? ?? ?? ??? ????????? ? ASK first (which domain / confirm wipe); directory=[] lists=[]. If SPEAKER_CONTACTS has rows this turn, FORBIDDEN claiming the book is empty ? ask whether they meant ??? ???????? (name that contacts exist). Never wipe-all without a clarifying ask.",
    "Speaker still needs ? EMPLOYEE_SAVED_DATA lists. Your tasks / your reminder jobs (?????? ??) ? WORKER_SAVED_DATA (+ OPEN_JOBS). Ping clocks only ? active_reminders. Empty clocks ? you have no work. Never emit metadata.query.",
    "WHEN / TODAY / SOON ? FULL agenda only (?? ????? ???? / ??? / ??? ????? / ????? / ???? ?????? / ???? ?????? with NO meaning filter): SESSION_CLOCK. ???/??? ? metadata.show_dump=tasks + show_dump_from/to YYYY-MM-DD; show_dump_ids=null; lists=[]; server replaces EVERY row in range. ?? ?? ????? ???? X ? show_dump=tasks + show_dump_about=YOUR display name + from/to. FORBIDDEN model-written agenda. Do NOT use TEAM_SCHEDULES as the speaker's day plan. Multi-day (?????) ? from=first to=last day of the window. SEMANTIC day asks (???????? / ??????? / topic filter) ? RETRIEVAL CONTRACT path 2 (ids required or responses without bare dump) ? FORBIDDEN bare show_dump without ids for those. TIME-OF-DAY (????) is NOT an engine dump filter.",
    "LIST ITEM URGENCY: on lists add/update set item urgency = normal | urgent | very_urgent by MEANING (same as messages) ? never ask. normal by default; urgent when they stress it (???? / ?????); very_urgent when hard (??? ???? / ???? ???? / ???). Clean title without urgency words. Shopping/tasks/contacts/custom alike.",
    "URGENCY IN RESPONSE: when a saved item has urgency (urgent / very_urgent ? normal is omitted from EMPLOYEE_SAVED_DATA), wrap that entire numbered line in guillemets so the whole row is bold. urgent ? ?1. ????? ??? ????. very_urgent ? the same wrap plus ?? after the closing guillemet: ?1. ????? ??? ???? ??. ?? and ?(??????: ?)? stay inside the wrap. FORBIDDEN: the words ???? / ???? ???? on the line. Never wrap or mark normal/missing. ?? ?? ?? ???? / ?? ???? ? metadata.show_dump=tasks (or full) + show_dump_urgency=urgent; lists=[]; server replaces.",
    "Status / ??? / what someone needs to buy or do / show a list: LIVE DATA ONLY ? never resurrect titles from earlier chat after a delete. Bare ??? ?? ??? / ?????? ???? / ????? ??? / ?? ?? ????? ? metadata.show_dump=full; lists=[]; server replaces response (FORBIDDEN model-written overview; shopping COUNTS + tasks detail + phone book). SHAREABLE STATUS ASK / ABOUT X / ???? ????? ?????|??????: metadata.show_dump = shopping|tasks|?; one flat dump header + row marks (co-share (A, B); assign (??????? X ? ??? Y)); filings two-section; about X = speaker?X co-share. Current field values only ? never dump ?? ??? / update drafts. Inventory dump lines are server-owned ? do not bold them. On confirms, bold only the item title with a single WhatsApp pair *title* (never **, never wrap ???:?). Urgency: wrap the whole item line in ???; very_urgent also appends ?? after the closing guillemet. FORBIDDEN to write ???? / ???? ???? on that line. Shared lists: use scope/shared_with. Custom list titles follow LIST NAME MATCH. APPLY FEEDBACK: name object+list after mutates.",
    "Answer in your response from this turn's saved data. The server does not write that answer ? except known false delivery / list-type wording fixes. It does not append a mutation summary.",
    "After any save/send/remove, state clearly in response what you did ? that text is what the user sees.",
    "If the speaker says they bought or already have a shopping item, remove it from shopping. If they finished a task (????? / ?????? / ????? / ????? ????? / ????? / tap command ???? ?????: <title>?), remove it from tasks ? look up which list holds it in EMPLOYEE_SAVED_DATA. The mark-done button is the SAME path as spoken finished-chore ? not a separate ACTION. Never call a tasks item ????? ??????.",
    "STANDING TASK DONE: if that task row has ???? / next_occurrences, ??????? / ????? / ?????? OR ???? ?????: <that title>? means done for THIS occurrence ? never lists.remove (it would delete the whole series and its clock). Emit lists.update list_type tasks with that item_id and occurrence_done = YYYY-MM-DD of the occurrence they did (true = today; ?????? ?????? ? yesterday from calendar); nothing else on the item. Response: acknowledge and name the next occurrence AFTER that day from next_occurrences. done_dates on the row = already marked; do not list those occurrences again. lists.remove only on an explicit delete of the standing task (?????? ?? ???????, ???? ??? ?? ?????). Unclear ? ask ????? ?????? ?????, ?? ????? ?? ?????? ???????? with lists empty. Tasks without ????: remove as usual.",
    "STANDING TASK ? ONE DATE CHANGED: cancelling or moving a single occurrence (???23.10 ??? ?? ???? ?????? / ???23.10 ????? ??11:00?) ? lists.update list_type tasks with that item_id and occurrence_change { date: YYYY-MM-DD (one of next_occurrences), cancel: true } or { date, time: \"HH:mm\" }; nothing else on the item. A linked repeating clock for the same work ? same turn lists update reminders with its reminder_id and the same occurrence_change. Never occurrence_done, lists.remove, a recurrence change, or a new one-off task for this. Only that date vs. every week unclear ? ask ??? ??<date> ?? ??? <weekday>?? with lists empty. Response names the date and that the other occurrences stay.",
    "list_type: shopping = things to buy (????? ???). tasks = work to do (????? ?????, ????? ???, ???? ?????). On remove/update, match the list_type of the saved row in EMPLOYEE_SAVED_DATA. response must say ????? for tasks and ????? for shopping.",
    "PERSONAL TASK DEFAULT: ??????? ?? ????? / ????? ??? / ????? ??? without naming a custom list ? list_type tasks, list_name empty, targets [] (built-in personal ?????). Detail/????? stays on that personal item. FORBIDDEN: dumping it onto a shared custom list like ?????? ?????? just because it exists or sounds work-related ? only when they explicitly named that list. Also FORBIDDEN: saving chat/meta/bug commentary as a list row.",
    "NAMED LIST MUTATE: when they name a list (?????? X / ??????? ??????), add/update/remove on list_type custom + that list_name from EMPLOYEE_SAVED_DATA ? personal or shared. Guests still cannot mutate. Do not refuse because shared; do not switch to built-in tasks/shopping.",
    "LIST NAME MATCH (custom / titled lists only): resolve against THIS turn's EMPLOYEE_SAVED_DATA list_name (personal or shared). Built-in ?????/?????/???? ??? ? fixed list_type, list_name \"\" unless they named a custom title. (1) IDENTICAL: exactly ONE list_name equals what they said ? mutate NOW, no ask. Spoken token in TWO OR MORE titles (????? / ????? ???? / ?) ? NOT unique ? treat as (3). (2) VERY SIMILAR but not identical (exactly one near-miss) ? lists=[] and ASK once ???????? ?????? ?X??? ? never mutate until confirm. (3) Several close candidates, OR spoken token in ?2 list_name titles, OR none ? lists=[] and ASK which as NUMBERED 1. 2. 3. (exact list_name; personal vs ?????? ?? X); never pick first/shared/looks-like. Example: ?????? ????? ????????? then ?1. ?????? / ?2. ????? ???? (?????? ?? ????)?. After they answer with the title OR a line index (?2? / ??2?) ? map to the LAST list-pick ask line ? exact list_name from EMPLOYEE_SAVED_DATA. Out-of-range index ? re-ask; FORBIDDEN inventing numbers. FORBIDDEN: inventing list_name or picking by topic alone (??????? ???? ? a ?????* list). Server will not fix a wrong list_name.",
    "SPEAKER_ADDRESS (this turn's fact block): always conjugate second-person Hebrew to gender male|female. If gender: unknown ? ask once ?????? ???? ????? ??? ?? ?????? with empty actions; on answer ? filing add ????? ?????? (item_info ???/????) ? the server stores address gender for next turns. Never ignore SPEAKER_ADDRESS.",
    "Durable personal memory ? file with lists add list_type filing in the same turn (do not only say ?????): ???? ?????/????, ?????, ?????/??? (street+city without the word ????? still counts ? ???? ??? ??? ????), ??? ??????, ?????, ?????, ???? ?????, pets/school/diet/allergies. SAVE VERB (?????/?????/????? ? text and/or files): follow ATTACHMENTS DESTINATION LADDER ? unique custom list_name defaults to ITEM attach (ask which item if unclear; list shell only when explicitly ???? ??????/?????? ????); filings only when ???????/????/??; FORBIDDEN filing only because ?????. LIST NAME MATCH on named lists. TOPIC-ONLY / NO LIST NAMED (??????? ???: ?? / ?????? ?? ?????): lists=[] ? if ?2 list_names contain ???/????? ? ASK which as NUMBERED 1. 2. 3. candidates (they may reply with the index); else ASK filings/shopping/tasks/named list. FORBIDDEN auto-picking a ?????* list by topic. Do NOT auto-file soft plans. Put detail in item_info (product ?????); item_description = optional find-helper (???? ??????) after ANY code/ID/doc/car-number/gate-code/?.?/file filing when description empty (bare ????? ???? 703?? counts ? not only ?????); never after soft auto-memory (???? ?????/?????/??????). Find filings by name+info+description. ?? ??????? ??? ? explicit saves; ?? ?? ????? ??? ? memory. Prefer SPEAKER_ADDRESS for address gender.",
  ].join("\n");
}

function isIdleSince(lastActivity: Date): boolean {
  return Date.now() - lastActivity.getTime() >= CONVERSATION_IDLE_MS;
}

async function rotateConversation(existing: { id: string }): Promise<{
  id: string;
  openaiConversationId: string;
  contextInjectedAt: Date | null;
  updatedAt: Date;
}> {
  const openaiConversationId = await getLlmClient().createConversation();
  await prisma.chatMessage.deleteMany({
    where: { conversationId: existing.id },
  });
  return prisma.chatConversation.update({
    where: { id: existing.id },
    data: {
      openaiConversationId,
      contextInjectedAt: null,
    },
  });
}

async function expireIdleConversation(existing: {
  id: string;
  openaiConversationId: string;
  contextInjectedAt: Date | null;
  updatedAt: Date;
}): Promise<{
  id: string;
  openaiConversationId: string;
  needsContext: boolean;
}> {
  const lastMessage = await prisma.chatMessage.findFirst({
    where: { conversationId: existing.id },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const lastActivity = lastMessage?.createdAt ?? existing.updatedAt;
  if (!isIdleSince(lastActivity)) {
    return {
      ...existing,
      needsContext: existing.contextInjectedAt == null,
    };
  }

  const rotated = await rotateConversation(existing);
  return {
    ...rotated,
    needsContext: true,
  };
}

async function getOrCreateConversation(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
): Promise<{
  id: string;
  openaiConversationId: string;
  needsContext: boolean;
}> {
  const existing = await prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: { userId, employeeId, digitalEmployeeId },
    },
  });

  if (existing) {
    return expireIdleConversation(existing);
  }

  const openaiConversationId = await getLlmClient().createConversation();

  try {
    const created = await prisma.chatConversation.create({
      data: {
        userId,
        employeeId,
        digitalEmployeeId,
        openaiConversationId,
      },
    });
    return { ...created, needsContext: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const raced = await prisma.chatConversation.findUniqueOrThrow({
      where: {
        userId_employeeId_digitalEmployeeId: { userId, employeeId, digitalEmployeeId },
      },
    });
    return {
      ...raced,
      needsContext: raced.contextInjectedAt == null,
    };
  }
}

function redactStoredJson(
  value: unknown,
  register: LlmMetadata["register"],
): unknown {
  if (!register?.password || value == null) {
    return value;
  }
  try {
    const json = JSON.stringify(value);
    if (!json.includes(register.password)) {
      return value;
    }
    return JSON.parse(redactRegisterSecrets(json, register));
  } catch {
    return value;
  }
}

async function saveTurn(input: {
  conversationId: string;
  speaker: string;
  assistantSpeaker: string;
  message: string;
  reply: string;
  raw: unknown;
  request: unknown;
  userAttachments?: ChatAttachmentRef[];
}): Promise<ChatTurnMessageIds & { assistantAt: Date }> {
  const parsed = parseLlmReply(input.reply);
  const register = parseReplyMetadata(input.reply).register;
  const safeMessage = redactRegisterSecrets(input.message, register);
  const safeRaw = redactStoredJson(input.raw, register);
  const safeRequest = redactStoredJson(input.request, register);
  const userAt = new Date();
  const assistantAt = new Date(userAt.getTime() + 1);
  const ids = { user: randomUUID(), assistant: randomUUID() };

  await prisma.chatMessage.createMany({
    data: [
      {
        id: ids.user,
        conversationId: input.conversationId,
        author: "you",
        speaker: input.speaker,
        text: safeMessage,
        ...(input.userAttachments?.length
          ? { attachments: toJsonValue(input.userAttachments) }
          : {}),
        createdAt: userAt,
      },
      {
        id: ids.assistant,
        conversationId: input.conversationId,
        author: "assistant",
        speaker: input.assistantSpeaker,
        // Later messages of the turn are written by syncTurnReplies once the engine is done,
        // so history polling does not show them before the reply returns.
        text: parsed.responseBubbles[0]?.text ?? parsed.responses[0] ?? "",
        actions: Prisma.JsonNull,
        buttons: parsed.responseBubbles[0]?.buttons
          ? toJsonValue(parsed.responseBubbles[0].buttons)
          : Prisma.JsonNull,
        navigateAddress: parsed.responseBubbles[0]?.navigateAddress ?? null,
        raw: toJsonValue(packStoredLlmRaw(safeRequest, safeRaw)),
        createdAt: assistantAt,
      },
    ],
  });
  return { ...ids, assistants: [ids.assistant], assistantAt };
}

/**
 * Writes the turn's final spoken messages: the first row (from saveTurn) gets
 * the first message, each further message is its own row right after it.
 */
async function syncTurnReplies(input: {
  conversationId: string;
  assistantSpeaker: string;
  saved: ChatTurnMessageIds & { assistantAt: Date };
  /** Final spoken bubbles (text + per-bubble buttons / Waze). */
  bubbles: LlmSpokenBubble[];
  /** Files the engine sends with this reply (metadata.send_attachments). */
  attachments?: ChatAttachmentRef[];
  /** Emoji reaction on the speaker's message (metadata.show_icon). */
  showIcon?: string;
  /** Line map from this turn's show_dump REPLACE (for next-turn BY LINE). */
  lastNumberedDump?: LastNumberedDumpLine[];
}): Promise<ChatTurnMessageIds> {
  const bubbles =
    input.bubbles.length > 0 ? input.bubbles : [{ text: "" }];
  const [first, ...rest] = bubbles;
  const firstButtons = first?.buttons ?? [];
  const firstNavigate = first?.navigateAddress ?? null;
  const showIcon = input.showIcon?.trim() || null;
  if (showIcon) {
    await prisma.chatMessage.update({
      where: { id: input.saved.user },
      data: { showIcon },
    });
  }
  const existingAssistant = await prisma.chatMessage.findUnique({
    where: { id: input.saved.assistant },
    select: { raw: true },
  });
  const unpacked = unpackStoredLlmRaw(existingAssistant?.raw);
  const dumpLines = input.lastNumberedDump ?? [];
  const nextRaw =
    dumpLines.length > 0
      ? packStoredLlmRaw(unpacked.request, unpacked.response, dumpLines)
      : existingAssistant?.raw;
  await prisma.chatMessage.update({
    where: { id: input.saved.assistant },
    data: {
      text: first?.text ?? "",
      actions: Prisma.JsonNull,
      buttons:
        firstButtons.length > 0 ? toJsonValue(firstButtons) : Prisma.JsonNull,
      navigateAddress: firstNavigate,
      ...(input.attachments?.length
        ? { attachments: toJsonValue(input.attachments) }
        : {}),
      ...(dumpLines.length > 0 ? { raw: toJsonValue(nextRaw) } : {}),
    },
  });
  const extra = rest.map((bubble, index) => {
    const entryButtons = bubble.buttons ?? [];
    return {
      id: randomUUID(),
      conversationId: input.conversationId,
      author: "assistant",
      speaker: input.assistantSpeaker,
      text: bubble.text,
      actions: Prisma.JsonNull,
      buttons:
        entryButtons.length > 0 ? toJsonValue(entryButtons) : Prisma.JsonNull,
      navigateAddress: bubble.navigateAddress ?? null,
      createdAt: new Date(input.saved.assistantAt.getTime() + index + 1),
    };
  });
  if (extra.length > 0) {
    await prisma.chatMessage.createMany({ data: extra });
  }
  return {
    user: input.saved.user,
    assistant: input.saved.assistant,
    assistants: [input.saved.assistant, ...extra.map((row) => row.id)],
  };
}

/**
 * After a remove/update of a reminder (or of the worker task linked to it), tell
 * everyone else it involved ? who asked for it and everyone it pings. Reports only
 * what the engine applied; one message per person.
 */
export function planInvolvedChangeNotices(input: {
  actor: PublicEmployee;
  humans: PublicEmployee[];
  listMutations: ListItemMutation[];
  reminderChanges: ReminderChange[];
}): Array<{ target: PublicEmployee; text: string }> {
  const actorName = employeeDisplayName(input.actor);
  const changes = [
    ...input.listMutations
      .filter(
        (row) =>
          (row.action === "remove" || row.action === "update") &&
          (row.workerTaskInvolvedIds?.length ?? 0) > 0,
      )
      .map((row) => ({
        action: row.action as "remove" | "update",
        label: row.itemLabel,
        fireAt: "",
        involvedIds: row.workerTaskInvolvedIds ?? [],
      })),
    ...input.reminderChanges,
  ];
  const linesByTarget = new Map<string, string[]>();
  for (const change of changes) {
    const line =
      change.action === "remove"
        ? `??????? ?${change.label}? ????? ?? ??? ${actorName}${change.fireAt ? ` (???? ?-${change.fireAt})` : ""}.`
        : `??????? ?${change.label}? ?????? ?? ??? ${actorName}${change.fireAt ? ` ? ????? ?-${change.fireAt}` : ""}.`;
    for (const id of new Set(change.involvedIds)) {
      if (id === input.actor.id) {
        continue;
      }
      const lines = linesByTarget.get(id) ?? [];
      if (!lines.includes(line)) {
        lines.push(line);
      }
      linesByTarget.set(id, lines);
    }
  }
  return [...linesByTarget.entries()].flatMap(([id, lines]) => {
    const target = input.humans.find((row) => row.id === id);
    return target && !isDigitalEmployee(target) && !isGuestEmployee(target)
      ? [{ target, text: lines.join("\n") }]
      : [];
  });
}

async function pushRelayMessage(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  speaker: string;
  text: string;
}): Promise<ChatThreadNotification> {
  const conversation = await getOrCreateConversation(
    input.userId,
    input.employeeId,
    input.digitalEmployeeId,
  );
  const raw = { relay: true };
  const message = await saveAssistantMessage({
    conversationId: conversation.id,
    modelConversationId: conversation.openaiConversationId,
    speaker: input.speaker,
    text: input.text,
    actions: [],
    raw,
  });

  if (conversation.needsContext) {
    await markContextInjected(conversation.id);
  }

  const notification = {
    employeeId: input.employeeId,
    digitalEmployeeId: input.digitalEmployeeId,
    message,
    raw,
  };
  publishChatEvent(
    input.userId,
    input.employeeId,
    input.digitalEmployeeId,
    notification,
  );
  return notification;
}

async function saveAssistantMessage(input: {
  conversationId: string;
  /** Also record the text in this OpenAI conversation (server-sent messages). */
  modelConversationId?: string;
  speaker: string;
  text: string;
  actions: string[];
  buttons?: LlmReplyButton[];
  raw: unknown;
}): Promise<ChatThreadMessage> {
  const buttons = input.buttons?.length
    ? toReplyButtons({ buttons: input.buttons })
    : [];
  const created = await prisma.chatMessage.create({
    data: {
      conversationId: input.conversationId,
      author: "assistant",
      speaker: input.speaker,
      text: input.text,
      actions: input.actions.length > 0 ? input.actions : Prisma.JsonNull,
      buttons: buttons.length > 0 ? toJsonValue(buttons) : Prisma.JsonNull,
      raw: toJsonValue(input.raw),
    },
  });

  if (input.modelConversationId) {
    await rememberInModelConversation(input.modelConversationId, input.text);
  }

  return toThreadMessage(created);
}

async function markContextInjected(conversationId: string): Promise<void> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { contextInjectedAt: new Date() },
  });
}

/**
 * Remove/update ACTIONs carry only `item_id`; name those rows from the saved
 * label so notifications never echo a raw id.
 */
function withSavedItemLabels(
  metadata: LlmMetadata,
  savedLabels?: ReadonlyMap<string, string>,
): LlmMetadata {
  if (!savedLabels || savedLabels.size === 0) {
    return metadata;
  }
  return {
    ...metadata,
    lists: metadata.lists.map((list) => ({
      ...list,
      items: list.items.map((item) => {
        const itemId = readItemId(item);
        const label = itemId ? savedLabels.get(itemId)?.trim() : "";
        return label ? { ...item, name: label } : item;
      }),
    })),
  };
}

async function pushTargetNotification(input: {
  userId: string;
  actor: PublicEmployee;
  target: PublicEmployee;
  metadata: LlmMetadata;
  savedLabels?: ReadonlyMap<string, string>;
  purchased?: boolean;
  shared?: boolean;
  unshared?: boolean;
  recipientIsOwner?: boolean;
  recipientIsPartner?: boolean;
  ownerName?: string;
  partnerNames?: string[];
  assistantSpeaker?: string;
  digitalEmployeeId: string;
}): Promise<{
  notification: ChatThreadNotification;
  whatsappSkips: WhatsAppDeliverySkip[];
}> {
  const conversation = await getOrCreateConversation(
    input.userId,
    input.target.id,
    input.digitalEmployeeId,
  );
  const labeled = withSavedItemLabels(input.metadata, input.savedLabels);
  const text = fallbackNotificationText(input.actor, labeled, {
    purchased: input.purchased,
    shared: input.shared,
    unshared: input.unshared,
    recipientIsOwner: input.recipientIsOwner,
    recipientIsPartner: input.recipientIsPartner,
    ownerName: input.ownerName,
    partnerNames: input.partnerNames,
  });
  const buttons = showButtonsForNotify(labeled);
  const raw = { notification: text };
  const message = await saveAssistantMessage({
    conversationId: conversation.id,
    modelConversationId: conversation.openaiConversationId,
    speaker: input.assistantSpeaker ?? "Assistant",
    text,
    actions: [],
    buttons,
    raw,
  });

  if (conversation.needsContext) {
    await markContextInjected(conversation.id);
  }

  const notification = {
    employeeId: input.target.id,
    digitalEmployeeId: input.digitalEmployeeId,
    message,
    raw,
  };
  publishChatEvent(input.userId, input.target.id, input.digitalEmployeeId, notification);
  const whatsappDelivery = await deliverWhatsAppRelays(
    [{ target: input.target, text, buttons }],
    input.actor.id,
  );
  return { notification, whatsappSkips: whatsappDelivery.skips };
}

type SharedNotifyClass =
  | "purchased"
  | "shared"
  | "unshared"
  | "owner"
  | "other";

function sharedNotifyClass(
  event: SharedItemEvent,
  targetId: string,
): SharedNotifyClass {
  if (event.purchased) {
    return "purchased";
  }
  if (event.shared) {
    return "shared";
  }
  if (event.unshared) {
    return "unshared";
  }
  if (event.listOwnerId === targetId) {
    return "owner";
  }
  return "other";
}

function pickSharedNotifyClass(
  events: SharedItemEvent[],
  targetId: string,
): SharedNotifyClass {
  if (events.some((event) => event.purchased)) {
    return "purchased";
  }
  if (events.some((event) => event.shared)) {
    return "shared";
  }
  if (events.some((event) => event.unshared)) {
    return "unshared";
  }
  if (events.some((event) => event.listOwnerId === targetId)) {
    return "owner";
  }
  return "other";
}

function listMergeKey(list: LlmListAction): string {
  return `${list.listType}\0${list.listName ?? ""}\0${list.action}`;
}

/**
 * One partner gets one notify per turn. Merge same-class events (e.g. three
 * newly shared shopping rows) so the message names every item, not only the first.
 */
export function mergeEventsForTargetNotify(
  events: SharedItemEvent[],
  targetId: string,
): SharedItemEvent {
  if (events.length === 0) {
    throw new Error("mergeEventsForTargetNotify requires at least one event");
  }
  const notifyClass = pickSharedNotifyClass(events, targetId);
  const cohort = events.filter(
    (event) => sharedNotifyClass(event, targetId) === notifyClass,
  );
  const representative = cohort[0] ?? events[0]!;
  if (cohort.length <= 1) {
    return representative;
  }

  const listBuckets = new Map<string, LlmListAction>();
  for (const event of cohort) {
    for (const list of event.metadata.lists ?? []) {
      const key = listMergeKey(list);
      const existing = listBuckets.get(key);
      if (!existing) {
        listBuckets.set(key, { ...list, items: [...list.items] });
        continue;
      }
      const seenIds = new Set(
        existing.items
          .map((item) => readItemId(item as Record<string, unknown>))
          .filter(Boolean),
      );
      for (const item of list.items) {
        const id = readItemId(item as Record<string, unknown>);
        if (id && seenIds.has(id)) {
          continue;
        }
        if (id) {
          seenIds.add(id);
        }
        existing.items.push(item);
      }
    }
  }

  return {
    ...representative,
    metadata: {
      ...emptyLlmMetadata(),
      ...representative.metadata,
      lists: [...listBuckets.values()],
      filing: representative.metadata.filing ?? [],
    },
  };
}

export async function notifySharedItemEvents(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  events: SharedItemEvent[];
  assistantSpeaker?: string;
  digitalEmployeeId: string;
  alreadyNotifiedIds?: Set<string>;
  savedLabels?: ReadonlyMap<string, string>;
}): Promise<{
  notifications: ChatThreadNotification[];
  whatsappSkips: WhatsAppDeliverySkip[];
}> {
  const notified = new Set<string>(input.alreadyNotifiedIds ?? []);
  const notifications: ChatThreadNotification[] = [];
  const whatsappSkips: WhatsAppDeliverySkip[] = [];
  const eventsByTarget = new Map<string, SharedItemEvent[]>();

  for (const event of input.events) {
    for (const targetId of event.notifyEmployeeIds) {
      const current = eventsByTarget.get(targetId) ?? [];
      current.push(event);
      eventsByTarget.set(targetId, current);
    }
  }

  for (const [targetId, events] of eventsByTarget) {
    const target = input.employees.find((item) => item.id === targetId);
    if (!target || target.id === input.actor.id || notified.has(target.id)) {
      continue;
    }
    notified.add(target.id);
    const event = mergeEventsForTargetNotify(events, targetId);
    const owner = input.employees.find((item) => item.id === event.listOwnerId);
    const pushed = await pushTargetNotification({
      userId: input.userId,
      actor: input.actor,
      target,
      metadata: event.metadata,
      savedLabels: input.savedLabels,
      purchased: event.purchased,
      shared: event.shared,
      unshared: event.unshared,
      recipientIsOwner: event.listOwnerId === target.id,
      recipientIsPartner:
        event.listOwnerId !== target.id &&
        Boolean(event.addedById) &&
        event.addedById !== target.id,
      ownerName: owner ? employeeDisplayName(owner) : undefined,
      partnerNames: event.partnerNames,
      assistantSpeaker: input.assistantSpeaker,
      digitalEmployeeId: input.digitalEmployeeId,
    });
    notifications.push(pushed.notification);
    whatsappSkips.push(...pushed.whatsappSkips);
  }

  return { notifications, whatsappSkips };
}

export async function getChatHistory(
  userId: string,
  employeeId: string,
  digitalEmployeeId?: string,
): Promise<ChatHistoryResponse> {
  await getEmployeeForUser(userId, employeeId);
  const digital = await requireDigitalChatPartner(userId, digitalEmployeeId);

  const conversation = await prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: {
        userId,
        employeeId,
        digitalEmployeeId: digital.id,
      },
    },
    include: {
      messages: {
        orderBy: [{ createdAt: "asc" }, { author: "desc" }],
      },
    },
  });

  if (!conversation) {
    return emptyHistory(employeeId, null, null, digital.id);
  }

  const lastActivity =
    conversation.messages.at(-1)?.createdAt ?? conversation.updatedAt;
  if (isIdleSince(lastActivity)) {
    const rotated = await rotateConversation(conversation);
    return emptyHistory(
      employeeId,
      rotated.openaiConversationId,
      rotated.updatedAt,
      digital.id,
    );
  }

  return toHistoryResponse(employeeId, conversation);
}

export async function resetChatConversation(
  userId: string,
  employeeId: string,
  digitalEmployeeId?: string,
): Promise<ChatHistoryResponse> {
  await getEmployeeForUser(userId, employeeId);
  const digital = await requireDigitalChatPartner(userId, digitalEmployeeId);
  const existing = await prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: {
        userId,
        employeeId,
        digitalEmployeeId: digital.id,
      },
    },
  });

  if (existing) {
    const rotated = await rotateConversation(existing);
    return emptyHistory(
      employeeId,
      rotated.openaiConversationId,
      rotated.updatedAt,
      digital.id,
    );
  }

  const created = await prisma.chatConversation.create({
    data: {
      userId,
      employeeId,
      digitalEmployeeId: digital.id,
      openaiConversationId: await getLlmClient().createConversation(),
    },
  });
  return emptyHistory(
    employeeId,
    created.openaiConversationId,
    created.updatedAt,
    digital.id,
  );
}

/** The ACTION asks for a new repeat every N seconds/minutes (clock, standing task or scheduled message). */
export function actionRepeatsSubHourly(metadata: LlmMetadata): boolean {
  return (
    (metadata.reminders ?? []).some((row) => reminderRepeatsSubHourly(row)) ||
    (metadata.lists ?? []).some(
      (row) =>
        row.action !== "remove" &&
        row.items.some((item) => isSubHourlyRecurrence(item.recurrence)),
    ) ||
    (metadata.messages ?? []).some((row) => isSubHourlyRecurrence(row.recurrence))
  );
}

function matchHandoffWorker(
  workerName: string | undefined,
  digitals: PublicEmployee[],
  currentId: string,
): PublicEmployee | undefined {
  const needle = workerName?.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  return digitals.find((employee) => {
    if (employee.id === currentId) {
      return false;
    }
    const aliases = [
      employee.nickname,
      employee.name,
      employee.surname,
      `${employee.name} ${employee.surname}`.trim(),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim().toLowerCase());
    return aliases.includes(needle);
  });
}

export async function sendChatMessage(input: {
  userId: string;
  message: string;
  employeeId: string;
  digitalEmployeeId?: string;
  skipHandoffFollow?: boolean;
  pendingWorkerItems?: WorkerTaskRef[];
  /**
   * Set when another digital worker is asking this one on the speaker's behalf.
   * The turn runs and is billed on the worker?worker conversation; the speaker
   * still decides permissions and saved data.
   */
  consult?: { fromWorkerId: string; fromWorkerName: string };
  /** Files that arrived with this message (stored already). */
  attachments?: TurnAttachments;
}): Promise<{
  reply: string;
  raw: unknown;
  notifications: ChatThreadNotification[];
  answeredBy: string;
  timing: { llmMs: number; afterLlmMs: number };
  request: unknown;
  messageIds: ChatTurnMessageIds;
  /** Validated metadata.send_attachments ? the channel sends these after the reply. */
  outboundAttachmentIds: string[];
  outboundAttachments?: ChatAttachmentRef[];
}> {
  const client = getLlmClient();
  const [employee, employees] = await Promise.all([
    getEmployeeForUser(input.userId, input.employeeId),
    listEmployeesForUser(input.userId),
  ]);
  const humans = humanEmployees(employees);
  const digital = await resolveDigitalChatPartner(
    input.userId,
    input.digitalEmployeeId,
    employees,
  );
  if (!digital) {
    throw new ValidationError("Digital employee is required", {
      digitalEmployeeId: "Employee is required",
    });
  }
  const config = llmConfigForDigital(digital);
  const speaker = speakerName(employee);
  const assistantSpeaker = speakerName(digital);
  const consultFrom = input.consult?.fromWorkerName.trim() ?? "";
  const turnSpeaker = consultFrom ? `${consultFrom} (??? ${speaker})` : speaker;
  const consultEnvelope = consultFrom
    ? [
        `CONSULT: ${consultFrom} is another digital worker on this team. ${consultFrom} is asking you on behalf of ${speaker}, who is the speaker for permissions and saved data.`,
        `Answer the question fully and directly in response. Your response is passed back to ${consultFrom} and shown to ${speaker} as your answer ? write it so ${speaker} can read it as is.`,
        `Do not handoff and do not message ${consultFrom} back. If you lack what you need to answer, say what is missing in response.`,
        `This conversation with ${consultFrom} is shared by everyone ${consultFrom} asks for. Earlier turns may have been on behalf of other people ? answer only for ${speaker}, from this turn's data, and never reveal another person's details.`,
      ].join("\n")
    : "";
  const conversationOwnerId = input.consult?.fromWorkerId ?? input.employeeId;
  let conversation = await getOrCreateConversation(
    input.userId,
    conversationOwnerId,
    digital.id,
  );
  const guestSpeaker = isGuestEmployee(employee);
  const speakerContacts = guestSpeaker
    ? []
    : await listContactsForEmployee(input.employeeId);
  const contactBookShare = guestSpeaker
    ? null
    : await getContactBookShare(input.employeeId);
  const recentOutbound = guestSpeaker
    ? []
    : await listRecentReminderOutbounds({
        userId: input.userId,
        employeeId: input.employeeId,
      });
  const openJobs = guestSpeaker
    ? []
    : ((await withoutFailingTurn("job_list_failed", () =>
        listOpenJobsForViewer({
          digitalEmployeeId: digital.id,
          viewerId: input.employeeId,
        }),
      )) ?? []);
  const lastNumberedDump = guestSpeaker
    ? []
    : await loadLastNumberedDumpForConversation(conversation.id);
  const context = [
    formatSessionClockContext(),
    guestSpeaker ? "" : formatSpeakerAddressContext(employee.addressGender),
    formatEmployeeContext(
      await withAttachmentRefsSafe(await getEmployeeRecordSnapshot(input.employeeId)),
    ),
    guestSpeaker
      ? ""
      : formatEmployeeContext(
          await withAttachmentRefsSafe(
            await getEmployeeRecordSnapshot(digital.id, {
              scopeItemsToViewerId: input.employeeId,
            }),
          ),
          "WORKER_SAVED_DATA",
        ),
    guestSpeaker
      ? ""
      : formatSpeakerContacts(speakerContacts, contactBookShare),
    guestSpeaker ? "" : formatTeamSchedules(await getTeamSchedules(input.employeeId)),
    guestSpeaker ? "" : formatRecentOutboundContext(recentOutbound),
    guestSpeaker ? "" : formatOpenJobsContext(openJobs, input.employeeId),
    guestSpeaker ? "" : formatLastNumberedDumpContext(lastNumberedDump),
    guestSpeaker || consultFrom
      ? ""
      : formatPendingAttachmentsContext(
          (
            (await withoutFailingTurn("attachments_pending_failed", () =>
              listPendingAttachments(input.employeeId),
            )) ?? []
          ).filter(
            (fact) =>
              !input.attachments?.facts.some(
                (fresh) => fresh.attachment_id === fact.attachment_id,
              ),
          ),
        ),
    guestSpeaker
      ? ""
      : formatPendingLocationContext(getPendingLocation(input.employeeId)),
    (await withoutFailingTurn("tips_context_failed", () =>
      formatAvailableTipsContext({
        userId: input.userId,
        speaker: employee,
        digitalEmployeeId: digital.id,
      }),
    )) ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const attachLucyEngine = shouldAttachLucyRuntimeEngine(
    digital,
    employees,
    loadLlmConfig().systemMessage,
  );
  const guestModeInstructions = guestSpeaker
    ? [
        "GUEST MODE: The SPEAKER is a WhatsApp guest (????) ? not you. You are ????-????.",
        "Never say ??? ????? / ??? ?? ????? / I'm a guest. Speak TO them (second person) or use impersonal Hebrew.",
        "Your purpose: help them register as a Workee member (their own account + ????). Collect first name, surname, username, password; when all four are known emit metadata.register with those fields. Until then register=null and ask for what is missing.",
        "Also allowed: answer about lists/filings already shared with them in this turn's EMPLOYEE_SAVED_DATA (scope=shared). Show items, say if empty, confirm a named shared list exists.",
        "Forbidden while guest: shopping adds, tasks, reminders, messages, directory, filings mutates, handoff, jokes/weather/market/mashov/places/jewish/routes as the main topic.",
        "Off-topic outside shared lists or registration ? guide them back to shared lists or signing up. Empty lists/filing/reminders/messages/directory (register only when complete).",
        "Add/update/delete/buy/remind/send while guest ? response: ????? ?? ????? ??????? ?????? ???? ? ??? ?????? ?? ?????. ???? ?????? ??? ???? ????? ????.? Empty mutate arrays.",
        "lists/filing/reminders/directory/messages/handoff must always stay []. Do not invent private data.",
      ].join("\n")
    : "";
  const instructions = attachLucyEngine
    ? [
        config.systemMessage,
        RESPONSES_RULE,
        `The user is chatting as ${speaker}.`,
        guestModeInstructions ||
          workerTargetingInstructions(employees, speaker, digital),
        guestSpeaker ? "" : OPEN_JOBS_RULES,
        consultEnvelope,
        guestSpeaker
          ? "GUEST MODE: shared-list Q&A + registration (metadata.register). Never claim you are the guest. You are ????-????."
          : "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
        "EMPLOYEE_SAVED_DATA is the speaker's visible saved items. WORKER_SAVED_DATA is YOUR lists and tasks. Do not invent items.",
        "LIVE DATA ONLY (lists / status / clocks / jobs): answer ???? ???????, ?? ??????/?????? ???, status dumps, reminders, OPEN_JOBS inventory ONLY from this turn's injected blocks (EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, OPEN_JOBS, active_reminders, SPEAKER_CONTACTS, TEAM_SCHEDULES, SESSION_CLOCK; RECENT_OUTBOUND only for that outbound). Soft-deleted/done rows are never injected ? absence means gone. FORBIDDEN: listing titles from earlier assistant/user messages or from your previous ???????? / ??????? ???????? reply if they are not in this turn's JSON ? including after a delete when they tap ???. Empty section ? one empty sentence; never re-show chat-history-only titles. Exact button commands ???? ????? X? / ???? ????????: lists/reminders empty; the server may replace response with a live dump. EXCEPTION: BY LINE NUMBER ? after a numbered dump, spoken indices map dump titles ? ids in THIS turn's JSON, then any supported ACTION (???? / ???? / ???? ?????? / ????? ?? N?); FORBIDDEN show_dump on that turn.",
        guestSpeaker
          ? ""
          : "BY LINE NUMBER: follow system BY LINE NUMBER / DECISION & FOCUS ? LAST_NUMBERED_DUMP or dump-line stem ? ACTION; filings dump ? filing; share-by-index ? update + dump ids + targets:[speaker, partner]; FORBIDDEN ???????? without those updates; FORBIDDEN JSON array index vs dump title; FORBIDDEN show_dump on line-index turns; AFTER a dump ??3? is a line index not 03:00.",
        guestSpeaker
          ? ""
          : "SPEAKER_ADDRESS is how to address this speaker (male/female/unknown). Always follow it for second-person Hebrew. filing is durable memory + explicit saves ? use family/job silently; address gender prefers SPEAKER_ADDRESS. ?? ??????? ??? ? prefer codes/docs/explicit ?????; ?? ?? ????? ??? ? memory rows. Do not claim you lack a fact that appears there.",
        guestSpeaker
          ? ""
          : "SPEAKER_CONTACTS is the speaker's personal phone book. Names there resolve without asking for a number.",
        guestSpeaker
          ? ""
          : "RECENT_OUTBOUND is the latest reminder/scheduled message YOU already sent to this speaker. If they ask about ?? ????? / ?????? / ?????? ??????? / ???? ??????? about that digest, use that text and talk to THIS speaker. Do not claim you sent nothing when it is listed. Do not resend unless they ask. FORBIDDEN: invent ???? (or any other person) as who to ask/send ? example names are not real; only message someone the speaker named this turn. Snooze / ????? ?? ??? / ?? ?? / ???? X about that block ? NEW self-nudge for this speaker from RECENT_OUTBOUND.item/text (three ACTIONS). Bare ????? ???? right after that outbound = snooze the same item. Do not revive the old done clock ? add a new one. Missing delay ? ASK ????",
        guestSpeaker
          ? "This speaker is a guest. EMPLOYEE_SAVED_DATA has only lists/filings shared with them. Never invent other employees' private lists or clocks."
          : employee.isOwner
            ? "This speaker is the account owner. EMPLOYEE_SAVED_DATA includes every human employee's lists, tasks, filings, and reminder clocks. When they ask what someone has, answer from that data and name the owner. When they ask about themselves, prefer their own rows."
            : "This speaker is not the account owner. EMPLOYEE_SAVED_DATA has only their own items plus shared items visible to them. Never invent other employees' private lists or clocks.",
        guestSpeaker
          ? ""
          : "VISIBILITY: Non-owners only see their own data. Account owner sees all humans' data in EMPLOYEE_SAVED_DATA. Personal SPEAKER_CONTACTS stay the speaker's alone.",
        guestSpeaker
          ? ""
          : "SHAREABLE STATUS ASK (?? ??? ???? ????? / ????? ?????? ?????? / ????? / ?????? / ??? ????? ?????|?????|???? ???): pick ONE category. For shopping|tasks|contacts|filings set metadata.show_dump = shopping|tasks|contacts|filings and lists=[] ? the server replaces response with the live dump. ABOUT X (??? ???? ????? ?????? / ????? ?? ??) ? same show_dump + show_dump_about=X. All domains use the same dump marks: co-share (A, B) and assign (??????? X ? ??? Y). Bare FULL DUMP (??? ?? ??? / ????? ???) ? show_dump=full (not a category). Shopping lines in any model-written leftover ALWAYS ??? - ?????.",
        guestSpeaker
          ? ""
          : "SHAREABLE STATUS ASK ABOUT X (?? X ????/????? ????? / ????? ?? X / ?????? ?? X): metadata.show_dump + show_dump_about=X or [X,Y] for X ?? Y (union). Optional section/partner/assignee (arrays = OR within field). Server applies visibility (owners see X's lists; others only rows already visible involving X). Empty ? engine empty sentence. ?? ?? ????? ??X ? show_dump=full (+ show_dump_about=X).",
        guestSpeaker
          ? ""
          : "APPLY FEEDBACK: after saves/removes ALWAYS name the object and list (e.g. ?????? ?? ???? ?????? ???????). FORBIDDEN: bare ?????, ?????!? / ??????. Claim past-tense success ONLY for actions in THIS turn's metadata. MULTI-INTENT CONFIRM: ?? after an offer of several mutations ? re-emit EVERY offered ACTION this turn, not a subset (incl. every lists delete_list). DELETE CLARIFY follow-up (which item/list/scope) ? emit only that resolved delete with ids from THIS turn; unambiguous deletes do not wait for ??. FORBIDDEN same-turn jobs.answer.",
        guestSpeaker
          ? ""
          : `If asked what you still need to do/check, or which tasks / work you have (${WORKER_INVENTORY_ASKS}): INVENTORY ? metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED); lists=[]; no reminders clock; buttons=[]. Server replaces with your tasks dump + ??????? from OPEN_JOBS (omit if empty). FORBIDDEN show_dump=tasks alone (speaker book); FORBIDDEN ???? ?? ?????? / ???? ?? ????? when WORKER_SAVED_DATA / OPEN_JOBS has rows; FORBIDDEN writing inventory lines yourself. Do NOT RAISE. Never emit metadata.query. FORBIDDEN: treating ????????? asks (${SPEAKER_CLOCK_ASKS}) as inventory ? those are speaker ping clocks (show_dump=reminders).`,
        "USER-FACING LANGUAGE: echo the speaker's words for any saved thing (??????? / ????? / ????? / ????). Never rename their category or explain storage. Never say schema words (sections, clocks, metadata, list_name).",
        "Status / ??? / show a list / ???? ????? X? / ?????? ???????: LIVE DATA ONLY. SHAREABLE STATUS ASK shopping|tasks|contacts|filings / ABOUT X / exact ???? ????? ?? / ???? ??????? / spoken inventory ?????? ??????? ? metadata.show_dump (+ show_dump_about for X) + empty lists; server replaces response ? FORBIDDEN model-written numbered filing inventory. Unique filing lookup (address/home/gate code/by meaning when exactly one filing matches) ? ITEM DUMP: show_dump=filings + show_dump_ids=[filing_id] from THIS turn; lists=[]; server replaces ? FORBIDDEN prose restating item_info/coords. >=2 matches ? ASK; 0 ? short no-match (no bare filings inventory). SHOW DUMP SECTION: bare ? show_dump only; ????? ? personal; ?????? ? shared; ?? X ? partner=X; ??????? ??? ? assignee=self; ??????? ???? ? assignee=????; date range ? show_dump_from + show_dump_to YYYY-MM-DD. OR WITHIN FIELD: X ?? Y on same dimension ? string[] (assignee/partner/about); AND across fields; ????? ?? ?????? ? omit section; FORBIDDEN cross-shape OR ? ask or full dump. FORBIDDEN same-as-bare for ?????/??????. Bare FULL DUMP (??? ?? ??? / ????? ??? / ????? ??? / ?? ?? ?????) ? metadata.show_dump=full; lists=[]; server replaces (FORBIDDEN model-written overview). SAVE VERB (?????/??????/?????/????? + text and/or files): (1) clear existing list or item (unique name / active context ? NOT last-mentioned latch) ? add/update THAT list or item (attachment_ids when files); (2) no clear list ? filing add (new durable fact); (3) ambiguous ?2 lists ? NUMBERED which-list ask, actions empty. FORBIDDEN always-filing only because they said ?????. TOPIC-ONLY ??????? ???? ? NUMBERED which-list ask if ?2 ?????* titles (else ask destination); never invent/auto-pick custom list_name from topic. Deletes: unique target+scope ? remove/delete_list NOW with ids; unclear ? ASK, delete mutates empty. SHARE-ONLY FACTS: filing/contacts/directory co-share; partners may mutate/unshare by id. Contacts alter_list participants OK; shopping/tasks whole-list share refused.",
        `Ping clocks (${SPEAKER_CLOCK_ASKS}) ? metadata.show_dump = reminders; lists/reminders/buttons=[]. Server replaces response with the live clocks dump. FORBIDDEN: answering any of these from WORKER_SAVED_DATA / OPEN_JOBS.`,
        "WHEN / TODAY / SOON ? FULL agenda only (?? ????? ???? / ??? / ??? ????? / ????? / ???? ?????? with NO meaning filter): SESSION_CLOCK. ???/??? ? metadata.show_dump=tasks + show_dump_from/to YYYY-MM-DD; show_dump_ids=null; lists=[]; server replaces EVERY row in range. ?? ?? ????? ???? X ? show_dump=tasks + show_dump_about=YOUR display name + from/to. FORBIDDEN model-written agenda. Multi-day (?????) ? from=first to=last of the window. SEMANTIC day asks (???????? / ???????) ? RETRIEVAL CONTRACT path 2 (show_dump_ids required or responses with show_dump=null) ? FORBIDDEN bare show_dump without ids. TIME-OF-DAY (????) is NOT an engine dump filter.",
        "SHOW MY LISTS / ????? ?? ??????? ???: metadata.show_dump=\"full\"; lists=[]; no reminders clock; buttons=[]. Same engine as FULL DUMP (server replaces). FORBIDDEN writing the overview yourself. Exact ???? ????? X? stays category/custom dump.",
        "FULL DUMP / ?? ?? ?? / ????? ??? / ??? ??? / ?? ???? ?? / ?? ?? ????? ??? / ????? ???: metadata.show_dump = \"full\"; lists=[]; no reminders clock; buttons=[]. Server replaces response with the live flat-list overview (EMPLOYEE_SAVED_DATA + SPEAKER_CONTACTS). FORBIDDEN writing the overview in response yourself. FULL DUMP DETAIL RULE (server): ONLY ????? enumerate items (1. 2. 3. under one ??????:? header; assign ?(??????? X ? ??? Y)?; co-share ?(A, B)?; LINKED REMINDER on task lines). ????? COUNTS ONLY breakdown under ??????:? ? ?????? / ?(A, B)? / ?(??????? X ? ??? Y)? (all involved on co-share); ?????? ????? = ?*name* (A, B) ? N ??????? (all involved, e.g. ?(????, ??)?; no ????). ??????? ??????: NUMBERED 1. 2. 3. (never ?) for clocks NOT already on a task LINKED REMINDER line. SHAREABLE STATUS ASK / ??? ????? X stay category dumps. Hint once: ?????? ?????: ??? ????? ?. ?????? (one ???????:? + ?(A, B)?); ???? ??? (one ????? ???:? from EMPLOYEE_SAVED_DATA only ? not SPEAKER_CONTACTS); ??? ???????? (one ???? ????????:? from SPEAKER_CONTACTS; co-share ?(A, B)?; empty ? ???). FORBIDDEN: skipping ??? ???????? when SPEAKER_CONTACTS is non-empty; FORBIDDEN filling ??? ???????? from list_type contacts or calling the phone book ????? ????. No schema jargon.",
        "PHONE BOOK ALONE / ??? ???????? / ????? ?? ??? ????????: metadata.show_dump=\"phone_book\"; lists=[]; server replaces from SPEAKER_CONTACTS. FORBIDDEN model-written phone book; FORBIDDEN confusing with ???? ??? (contacts list).",
        "Show a named list / ????? ?? ????? X / ??????? ?????? / ??????? ????? ?? ?????: metadata.show_dump = exact custom list_name from EMPLOYEE_SAVED_DATA (or shopping|tasks|contacts|filings); lists=[]; server replaces numbered dump + LAST_NUMBERED_DUMP. FORBIDDEN model-written ? inventory for named lists (breaks ?????? 6?). items=[] ? server empty sentence. Speak Hebrew only ? never list_name / list_type / metadata. After that dump, ?????? 6? / ??? 3? ? ITEM DUMP show_dump + show_dump_ids from LAST_NUMBERED_DUMP line n (same list kind); missing/out of range ? ASK, not invent ids.",
        "SHARED LISTS: use scope + shared_with from EMPLOYEE_SAVED_DATA. Shared ? say ?????? and name shared_with partners; never ??? ????? alone if the speaker is in shared_with. ????? ?????? ??????? ? only scope=shared. scope=shared_items shopping/tasks ? status header ??????/????? ?? <owner>? (FORBIDDEN ?????? ??). Named-list add/update/remove ? LIST NAME MATCH (identical-unique ? mutate; very similar one ? confirm; several / token in ?2 titles / topic-only ??????? ???? ? NUMBERED which-list ask; FORBIDDEN pick by topic). ?????? ????? ??????? / ?? after that offer ? shopping + list_name \"\" (FORBIDDEN custom with list_name ????? / ????? / ???? ???).",
        "?? ?? ?? ?? X / ?? ?? ?? ????? ?? X / ?? ????? ?? ???X / ?? ????? ?? X / ?? ?? ??? ?? X / ?? ????? ?????? ?? X: metadata.show_dump=\"full\"; show_dump_section=shared; show_dump_partner=X; lists=[]. Server dump (partner-filtered). FORBIDDEN model-written with-X overview.",
        "Bold in response: inventory dump lines are server-owned ? do not bold them. On confirms, bold only the item title with a single WhatsApp pair *title* (never **, never wrap ???:?). Item urgency: wrap the whole numbered line in ???. very_urgent also appends ?? after the closing guillemet. FORBIDDEN: writing ???? / ???? ???? on the line.",
        guestSpeaker
          ? ""
          : "lists update: put the NEW value under the real column name (?? / ?? ???? / ?). Never emit \"?? ???\" or \"X ???\" as a separate key.",
        guestSpeaker
          ? ""
          : "Dates in saved items: if a field still says ????/???, speak the concrete calendar date (YYYY-MM-DD) when answering. When saving, always emit YYYY-MM-DD, not ????.",
        guestSpeaker
          ? ""
          : "Past deletes / already-fired / ?? ???? / ??? ????? / ?? ?????: say you only have live saved data ? do not invent history. Active scheduled sends and clocks ? answer from this turn's EMPLOYEE_SAVED_DATA / active_reminders.",
        guestSpeaker
          ? ""
          : "FOLLOW-UP TO YOUR QUESTION: the server keeps no draft ? your previous turn in this conversation is the draft. When the speaker answers what you asked (time / hour HH:mm / ??9 / 21:00, relative date ????/???/?????, calendar date YYYY-MM-DD or spoken date, weekday / day ????? / ??? ?????, a duration/until you asked for, phone, name, message body, description, ??, or a pick from options you listed ? ?1? / ????????? / an exact title), emit the COMPLETE action this turn with every field you already had plus the answer ? resolve picks to ids from THIS turn's live facts, never invent or speak ids ? never ?? ?????. If you just asked for a date/day/time/start and they reply with only that kind of short answer (bare ??? / a weekday / a clock), that fills the draft ? do NOT treat it as a new WHEN/TODAY / ??? ?? ??? query and do NOT ask the same question again. Exception ? REMINDER OFFER follow-up: if you already saved a timed speaker row and only asked whether/when to add a WhatsApp ping, their time/?? fills reminders (+ your ?????? with that speaker row's ?????/??? ?????? copied onto the worker item) only ? never overwrite speaker ???/????? ?????? (APPOINTMENT VS PING). On ?? to an offer, emit exactly that offered action (same targets) ? if the offer was several mutations (lists remove/update/add, reminders, ?), re-emit EVERY one this turn, not a subset. response may claim past-tense success ONLY for actions present in THIS turn's metadata. Cancel (?? / ??? / ?? ????? / cancel / ???? ??) ? emit nothing for that draft and say you cancelled. If the open ask was a DELETE CLARIFY (which item/list/scope) ? cancel ONLY that delete (ack that title); FORBIDDEN binding ?? to AFTER ASSIGN / date+reminder / older offers. List/filing/directory deletes: unique target+scope+id ? remove/delete_list NOW; unclear which ? ASK then FOLLOW-UP with ids from THIS turn. Reminder deletes with reminder_id apply immediately (past tense).",
        guestSpeaker
          ? "If asked what you can do: ???? ????-???? ? ???? ????? ?????? ?????? ????, ????? ?????? ?????? Workee ????.?"
          : "If asked what you can do: FULL catalog ? lists (any/custom), share lists/filings, meetings+?????, standing tasks, day/week agenda, filings, phone book, messages now/later, checks&nudges, reminders, scheduled digests, handoff. Lead ???? ????? ???? ?? ??????. Saved data does not limit that answer. No git digests / schema jargon.",
        "LIVE FACTS (this turn only): Saved state ? list/filing/reminder/contact rows, field values, urgency, dates, sharing, clocks, open jobs ? comes ONLY from this turn's fact blocks in the user message (EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, RECENT_OUTBOUND, OPEN_JOBS, SESSION_CLOCK, SPEAKER_ADDRESS). Second-person Hebrew gender comes from SPEAKER_ADDRESS (not chat history). Earlier chat turns and your own prior replies are NOT a source for those values. If chat memory conflicts with this turn's JSON, the JSON wins. A field missing from the JSON (e.g. no urgency) means absent/normal ? never resurrect it from an older turn. Chat history is only for the speaker's current intent and unfinished drafts (what they just answered), never for ?what is saved?. Items can also change outside this chat (a reminder fired, someone bought or removed an item, an edit on the site). Examples: (a) you said ???? ????? ?????? ?? ????? ????, then the task is gone from WORKER_SAVED_DATA ? ??? ?? ????? ?????? = nothing open; (b) after lists.update sets urgency to normal, a later ???? ?????? must NOT wrap that line or append ?? even if an earlier turn did.",
        guestSpeaker
          ? ""
          : "Ping clocks only ? active_reminders; list NUMBERED 1. 2. 3. (never ?). Empty active clocks does not mean you have no reminder jobs ? those live in WORKER_SAVED_DATA.",
        guestSpeaker ? "" : ATTACHMENTS_RULE,
        guestSpeaker
          ? ""
          : "LAST CHECK before you answer: every entry in metadata.messages must have all five fields ? targets, text, expects_reply, ask_summary, urgency (normal unless the speaker stressed it). expects_reply is true whenever the speaker waits for an answer, an agreement, or an action from that person (???? / ????? / ????? / ????), false only for pure information. Never emit a messages entry without them.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : [
        config.systemMessage,
        RESPONSES_RULE,
        guestModeInstructions,
        thinSessionEnvelope({
          employees,
          speaker,
          worker: digital,
          speakerIsOwner: employee.isOwner === true,
        }),
        consultEnvelope,
      ]
        .filter(Boolean)
        .join("\n\n");
  const message = [
    context,
    `${turnSpeaker}: ${input.message}`,
    formatNewAttachmentsBlock(input.attachments?.facts ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
  const imageUrls = input.attachments?.imageUrls ?? [];

  try {
    let turn;
    const llmStarted = Date.now();
    let openaiRequest = buildOpenAiRequest({
      conversationId: conversation.openaiConversationId,
      message,
      model: config.model,
      temperature: config.temperature,
      reasoningEffort: config.reasoningEffort,
      instructions,
      textFormat: config.responseFormat,
    });
    try {
      turn = await client.createResponse({
        conversationId: conversation.openaiConversationId,
        message,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        instructions,
        textFormat: config.responseFormat,
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
      });
    } catch (error) {
      if (!isContextTooLargeError(error)) {
        throw error;
      }
      recordWhatsAppEvent("chat_rotate", "openai_request_too_large");
      const rotated = await rotateConversation(conversation);
      conversation = { ...rotated, needsContext: true };
      openaiRequest = buildOpenAiRequest({
        conversationId: conversation.openaiConversationId,
        message,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        instructions,
        textFormat: config.responseFormat,
      });
      turn = await client.createResponse({
        conversationId: conversation.openaiConversationId,
        message,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        instructions,
        textFormat: config.responseFormat,
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
      });
    }
    const llmMs = Date.now() - llmStarted;
    const afterLlmStarted = Date.now();
    await recordLlmUsage({
      conversationId: conversation.id,
      employeeId: conversationOwnerId,
      digitalEmployeeId: digital.id,
      openaiConversationId: conversation.openaiConversationId,
      model: config.model,
      turn,
    });
    const messageIds = await saveTurn({
      conversationId: conversation.id,
      speaker: turnSpeaker,
      assistantSpeaker,
      message: input.message,
      reply: turn.reply,
      raw: turn.raw,
      request: openaiRequest,
      userAttachments: input.attachments?.refs,
    });

    const parsedMetadata = parseReplyMetadata(turn.reply);
    let metadata = resolveSpokenMetadata(
      input.message,
      parsedMetadata,
      humans,
      employee.id,
    );
    if (!guestSpeaker) {
      const alignedLists = alignListTargetsWithMessageRecipients({
        lists: metadata.lists ?? [],
        messages: metadata.messages ?? [],
        speakerName: employeeDisplayName(employee),
      });
      if (alignedLists !== metadata.lists) {
        metadata = { ...metadata, lists: alignedLists };
      }
    }
    if (!guestSpeaker) {
      const booked = meetingListsForAnswers(openJobs, metadata.jobs ?? []);
      const alreadyBooked = (metadata.lists ?? []).some(
        (row) => row.action === "add" && row.listType === "tasks",
      );
      if (booked.length > 0 && !alreadyBooked) {
        metadata = { ...metadata, lists: [...(metadata.lists ?? []), ...booked] };
      }
    }
    // A repeat every N seconds/minutes is refused with its companion tasks/messages,
    // so no half of a self-nudge is saved.
    const subHourlyRepeat = !guestSpeaker && actionRepeatsSubHourly(metadata);
    if (subHourlyRepeat) {
      metadata = {
        ...metadata,
        lists: [],
        listOps: [],
        filing: [],
        messages: [],
        reminders: [],
        directory: [],
      };
    }
    // Closed UI button command (opaque equality) ? synthesize show_dump if model omitted it.
    // Free-form never maps here ? model must emit show_dump. Dump intent is ACTION-only.
    if (!(metadata.showDump?.trim() ?? "")) {
      const buttonText = stripWhatsAppReplyPrefix(input.message);
      let buttonDump = mapShowButtonCommandToDumpTarget(buttonText);
      if (!buttonDump) {
        const listsForAllowlist = await getEmployeeRecordSnapshot(
          input.employeeId,
        );
        buttonDump = mapShowButtonCommandToDumpTarget(
          buttonText,
          listsForAllowlist,
        );
      }
      if (buttonDump) {
        metadata = {
          ...clearMutatingMetadata(metadata),
          showDump: buttonDump.kind,
          ...(buttonDump.section != null
            ? { showDumpSection: buttonDump.section }
            : {}),
          ...(buttonDump.partner
            ? { showDumpPartner: buttonDump.partner }
            : {}),
          ...(buttonDump.assignee
            ? { showDumpAssignee: buttonDump.assignee }
            : {}),
          ...(buttonDump.about
            ? { showDumpAbout: buttonDump.about }
            : {}),
        };
      }
    }
    // show_dump: display-only ? drop spurious removes; mutates win over accidental show_dump.
    metadata = stripShowTurnMutates(metadata);
    const metadataForApply = {
      ...metadata,
      lists: [
        ...(metadata.lists ?? []).filter((row) => row.action !== "remove"),
        ...(metadata.lists ?? []).filter((row) => row.action === "remove"),
      ],
    };
    // Before item-level lists so a same-turn rename/delete is visible to them.
    const listOpResults = guestSpeaker
      ? []
      : await applyListOps({
            userId: input.userId,
            actor: employee,
            employees: humans,
            ops: metadata.listOps ?? [],
          });
    const sharedLists = await listSharedCustomListsForActor(
      input.userId,
      employee.id,
    );
    const itemOwners = guestSpeaker
      ? undefined
      : await loadListItemOwners(
          input.userId,
          listActionItemIds(metadataForApply.lists),
        );
    const filingOwners = guestSpeaker
      ? undefined
      : await loadFilingOwners(
          input.userId,
          filingActionIds(metadataForApply.filing ?? []),
        );
    const plan = planTargetedActions({
      actor: employee,
      employees: humans,
      workers: digitalEmployees(employees),
      metadata: metadataForApply,
      sharedLists,
      itemOwners,
      filingOwners,
    });
    const relays = planRelayDeliveries({
      actor: employee,
      sender: digital,
      employees,
      messages: guestSpeaker ? [] : resolveRelayMessages(metadata.messages ?? []),
    });

    const collectedEvents: SharedItemEvent[] = [];
    const listMutations: ListItemMutation[] = [];
    const filingMutations: FilingMutation[] = [];
    const shareMisses: ShareApplyMiss[] = [];
    let attachmentOutcome = mergeAttachmentOutcomes(
      ...listOpResults.map(
        (row) => row.attachmentOutcome ?? emptyAttachmentOutcome(),
      ),
    );
    const cancelledReminderIds: string[] = listOpResults.flatMap(
      (row) => row.cancelledReminderIds,
    );
    for (const application of plan.applications) {
      const applied = await applyEmployeeRecords(
        application.employeeId,
        application.metadata,
        application.visibility,
        employee.id,
      );
      collectedEvents.push(...applied.events);
      listMutations.push(...applied.mutations);
      filingMutations.push(...applied.filingMutations);
      cancelledReminderIds.push(...applied.cancelledReminderIds);
      shareMisses.push(...applied.shareMisses);
      attachmentOutcome = mergeAttachmentOutcomes(
        attachmentOutcome,
        applied.attachmentOutcome,
      );
    }
    const customRemoves = metadataForApply.lists.filter(
      (row) => row.action === "remove" && row.listType === "custom",
    );
    const removedCustom = listMutations.some(
      (row) =>
        row.action === "remove" && row.listType === "custom" && !row.listShell,
    );
    if (customRemoves.length > 0 && !removedCustom) {
      const recovered = await removeVisibleCustomItems({
        userId: input.userId,
        actorId: employee.id,
        lists: customRemoves,
      });
      collectedEvents.push(...recovered.events);
      listMutations.push(...recovered.mutations);
      cancelledReminderIds.push(...recovered.cancelledReminderIds);
    }
    const guestMutationNotice =
      guestSpeaker &&
      ((metadata.lists?.length ?? 0) > 0 ||
        (metadata.listOps?.length ?? 0) > 0 ||
        (metadata.filing?.length ?? 0) > 0 ||
        (metadata.reminders?.length ?? 0) > 0 ||
        (metadata.directory?.length ?? 0) > 0 ||
        (parsedMetadata.messages?.length ?? 0) > 0 ||
        plan.guestMutationBlocked)
        ? "???? ?? ????? ??????? ?????? ???? ? ??? ?????? ?? ?????."
        : "";
    let registerNotice = "";
    if (guestSpeaker && metadata.register) {
      if (!isGuestLucy(digital)) {
        registerNotice = "";
      } else {
        const registerResult = await registerGuestMember({
          hostUserId: input.userId,
          guest: employee,
          digital,
          register: metadata.register,
        });
        if (registerResult.ok) {
          registerNotice = `????? ?????? ??${registerResult.displayName}. ?????? ????? ?? ???? ?????? ??? (?? ?????: ${registerResult.username}).`;
          recordWhatsAppEvent(
            "guest_register",
            `ok user=${registerResult.newUserId.slice(0, 8)} mirror=${registerResult.mirrorEmployeeId.slice(0, 8)}`,
          );
        } else if (registerResult.reason === "username_taken") {
          registerNotice = "?? ?????? ??? ???? ? ???? ?? ???.";
        } else if (registerResult.reason === "invalid_fields") {
          registerNotice =
            "?? ?????? ????? ? ???? ?? ????, ?? ?????, ?? ????? ?????? ??????.";
        } else {
          registerNotice = "?? ?????? ?????? ?? ?????? ????. ??? ??? ???? ???.";
          recordWhatsAppEvent(
            "guest_register",
            `fail reason=${registerResult.reason}`,
          );
        }
      }
      // Never leave plaintext password in in-memory metadata used later.
      metadata = redactMetadataSecrets(metadata);
    }
    const incomingReminders = guestSpeaker ? [] : metadata.reminders ?? [];
    const reminderWrites = [
      ...incomingReminders.filter((row) => row.action !== "remove"),
      ...incomingReminders.filter((row) => row.action === "remove"),
    ];
    const incompleteComposeClocks = (metadata.reminders ?? []).filter(
      (row) =>
        row.action === "add" &&
        (row.composeSource === "git_log" ||
          row.composeSource === "saved_data" ||
          row.composeSource === "weather" ||
          row.composeSource === "market" ||
          row.composeSource === "mashov" ||
          row.composeSource === "jewish" ||
          row.composeSource === "places" ||
          row.composeSource === "flights" ||
          row.composeSource === "routes") &&
        !row.time.trim() &&
        !(typeof row.inSeconds === "number" && row.inSeconds > 0) &&
        !(row.everyCount && row.everyUnit) &&
        !(row.weekdays && row.weekdays.length > 0) &&
        !row.recurrence?.freq,
    );
    const reminderResult = await applyReminders({
      userId: input.userId,
      actor: employee,
      employees: humans,
      reminders: reminderWrites,
      contacts: speakerContacts,
      alreadyCancelledReminderIds: cancelledReminderIds,
    });
    attachmentOutcome = mergeAttachmentOutcomes(
      attachmentOutcome,
      reminderResult.attachmentOutcome,
    );
    // Clock cancel soft-deletes the linked worker ?????? ? count it as a list
    // remove so reply correction does not claim ??? ????? ?? ????? ???????.
    const knownMutationIds = new Set(listMutations.map((row) => row.itemId));
    for (const task of reminderResult.removedWorkerTasks) {
      if (knownMutationIds.has(task.id)) {
        continue;
      }
      knownMutationIds.add(task.id);
      listMutations.push({
        action: "remove",
        itemId: task.id,
        employeeId: task.employeeId,
        listType: "tasks",
        itemKey: task.itemKey,
        itemLabel: task.itemLabel,
      });
    }
    const directoryResult = guestSpeaker
      ? { saved: [], removed: [], shareNotices: [] }
      : await applyDirectoryActions({
          userId: input.userId,
          ownerEmployeeId: employee.id,
          actions: metadata.directory ?? [],
          employees: humans,
        });
    const refreshedContacts =
      directoryResult.saved.length > 0 || directoryResult.removed.length > 0
        ? await listContactsForEmployee(employee.id)
        : speakerContacts;
    const workerItems: WorkerTaskRef[] = [
      ...(input.pendingWorkerItems ?? []),
      ...listMutations
        .filter(
          (row) =>
            row.employeeId === digital.id &&
            row.listType === "tasks" &&
            row.action !== "remove" &&
            row.itemId,
        )
        .map((row) => ({ id: row.itemId, itemKey: row.itemKey })),
    ];
    const savedClocks = reminderResult.saved.map((row) => ({
      id: row.id,
      itemKey: row.itemKey,
      itemLabel: row.itemLabel,
    }));
    await linkRemindersToWorkerTasks(savedClocks, workerItems);
    // Soft-link: same-turn human add/update union live shopping/tasks (exact
    // itemKey later). Never fuzzy label ? that wrote wrong links.
    const humanIds = humans.map((human) => human.id);
    const sameTurnItems = itemsFromListMutationsForSoftLink(
      listMutations,
      humanIds,
    );
    const liveItems =
      savedClocks.length > 0
        ? await listLiveHumanItemsForReminderLink({
            userId: input.userId,
            humanIds,
          })
        : [];
    await linkRemindersToItems(
      savedClocks,
      unionSoftLinkItemCandidates(sameTurnItems, liveItems),
    );
    recordWhatsAppEvent(
      "reminder_apply",
      `worker=${digital.name} incoming=${metadata.reminders?.length ?? 0} apply=${reminderWrites.length} saved=${reminderResult.saved.length} skipped=${reminderResult.skipped.length} ping=${reminderResult.saved.map((row) => row.ping).filter(Boolean).join("|") || "none"}`,
    );
    const jobResult = guestSpeaker
      ? null
      : await withoutFailingTurn("job_apply_failed", () =>
          applyJobActions({
            userId: input.userId,
            digitalEmployeeId: digital.id,
            speaker: { id: employee.id, name: speakerName(employee) },
            actions: metadata.jobs ?? [],
            jobs: openJobs,
          }),
        );
    // Removing a job task through lists.remove must also drop its follow-up clock
    // and notify the other party (full job end).
    const removedJobReports =
      (await withoutFailingTurn("job_sweep_failed", () =>
        sweepJobNudgesForRemovedItems({
          userId: input.userId,
          actorId: employee.id,
          actorName: speakerName(employee),
          itemIds: listMutations
            .filter(
              (row) =>
                row.action === "remove" &&
                row.employeeId === digital.id &&
                row.listType === "tasks" &&
                row.itemId,
            )
            .map((row) => row.itemId),
        }),
      )) ?? [];
    const phoneRelays = planPhoneRelays(
      guestSpeaker ? [] : metadata.messages ?? [],
      employees,
      employee.id,
      refreshedContacts,
    );
    const outbound = planOutboundSends({
      relays: guestSpeaker ? [] : relays,
      phones: phoneRelays,
    });
    if (outbound.held) {
      recordWhatsAppEvent(
        "outbound_held",
        "spoken reply is still a question",
      );
    }

    const notifications: ChatThreadNotification[] = [];
    const notified = new Set<string>();
    const sharedWhatsAppSkips: WhatsAppDeliverySkip[] = [];
    const savedLabels = new Map(
      listMutations.map((row) => [row.itemId, row.itemLabel] as const),
    );

    // Prefer plan notifications (named shared lists include partner context + full list payload).
    for (const notification of plan.notifications) {
      if (notified.has(notification.employee.id) || notification.employee.id === employee.id) {
        continue;
      }
      notified.add(notification.employee.id);
      const pushed = await pushTargetNotification({
        userId: input.userId,
        actor: employee,
        target: notification.employee,
        metadata: notification.metadata,
        savedLabels,
        recipientIsOwner: true,
        partnerNames: notification.partnerNames,
        assistantSpeaker,
        digitalEmployeeId: digital.id,
      });
      notifications.push(pushed.notification);
      sharedWhatsAppSkips.push(...pushed.whatsappSkips);
    }

    for (const notice of directoryResult.shareNotices) {
      if (notified.has(notice.employeeId) || notice.employeeId === employee.id) {
        continue;
      }
      const target = humans.find((row) => row.id === notice.employeeId);
      if (!target) {
        continue;
      }
      notified.add(notice.employeeId);
      const pushed = await pushTargetNotification({
        userId: input.userId,
        actor: employee,
        target,
        metadata: notice.metadata,
        savedLabels,
        recipientIsOwner: true,
        partnerNames: [],
        assistantSpeaker,
        digitalEmployeeId: digital.id,
      });
      notifications.push(pushed.notification);
      sharedWhatsAppSkips.push(...pushed.whatsappSkips);
    }

    const sharedNotify = await notifySharedItemEvents({
      userId: input.userId,
      actor: employee,
      employees: humans,
      events: collectedEvents,
      assistantSpeaker,
      digitalEmployeeId: digital.id,
      alreadyNotifiedIds: notified,
      savedLabels,
    });
    for (const notification of sharedNotify.notifications) {
      if (notified.has(notification.employeeId)) {
        continue;
      }
      notified.add(notification.employeeId);
      notifications.push(notification);
    }
    sharedWhatsAppSkips.push(...sharedNotify.whatsappSkips);

    const listOpRelays = listOpResults.flatMap((result) =>
      result.notices.flatMap((notice) => {
        const target = humans.find((row) => row.id === notice.employeeId);
        return target ? [{ target, text: notice.text }] : [];
      }),
    );
    for (const relay of listOpRelays) {
      notifications.push(
        await pushRelayMessage({
          userId: input.userId,
          employeeId: relay.target.id,
          digitalEmployeeId: digital.id,
          speaker: assistantSpeaker,
          text: relay.text,
        }),
      );
    }
    if (listOpRelays.length > 0) {
      const listOpDelivery = await deliverWhatsAppRelays(listOpRelays, employee.id);
      sharedWhatsAppSkips.push(...listOpDelivery.skips);
    }

    const actorName = speakerName(employee);
    const attributedRelays = outbound.relays.map((relay) => ({
      ...relay,
      text: formatAttributedOutbound({
        actorName,
        destIsActor: relay.employeeId === employee.id,
        text: relay.text,
      }),
    }));
    const attributedPhones = outbound.phones.map((row) => ({
      ...row,
      text: formatAttributedOutbound({
        actorName,
        destIsActor: Boolean(
          employee.phone && phonesMatch(employee.phone, row.phone),
        ),
        text: row.text,
      }),
    }));
    // A question to another digital worker is a job like any other, but that worker
    // answers now: open the job, run its turn, report, close. Consulted workers never
    // consult again, so this cannot loop.
    const consultRelays =
      guestSpeaker || consultFrom
        ? []
        : outbound.relays.filter(
            (relay, index, all) =>
              isDigitalEmployee(relay.target) &&
              relay.expectsReply !== false &&
              relay.target.id !== digital.id &&
              all.findIndex((row) => row.target.id === relay.target.id) === index,
          );
    const consulted = new Set(consultRelays.map((relay) => relay.target.id));
    // Open a job for every relay the asker expects something back from, after the
    // relay actually went out, so the answer can be bound and reported later.
    // Relaying through a worker means the asker is waiting, so the job opens
    // unless the model marked the message as pure information.
    if (!guestSpeaker) {
      const relayJobDeliveries = outbound.relays
        .filter(
          (relay) =>
            relay.expectsReply !== false &&
            (!isDigitalEmployee(relay.target) || consulted.has(relay.target.id)) &&
            relay.target.id !== employee.id,
        )
        .map((relay) => ({
          subjectId: relay.target.id,
          subjectName: speakerName(relay.target),
          text: relay.text,
          ask: relay.askSummary ?? "",
          ...(relay.urgency ? { urgency: relay.urgency } : {}),
          ...(relay.book ? { book: relay.book } : {}),
        }));
      // ?????? ????? ? speaker-targeted expects_reply opens a self-job (no relay).
      const relayMessages = resolveRelayMessages(metadata.messages ?? []);
      const selfJobDeliveries = planSelfJobDeliveries({
        actor: employee,
        employees,
        messages: relayMessages,
      });
      await withoutFailingTurn("job_open_failed", () =>
        createJobsFromRelays({
          userId: input.userId,
          digitalEmployeeId: digital.id,
          asker: { id: employee.id, name: actorName },
          reuseJobIds: jobResult?.progressed ?? [],
          deliveries: [...relayJobDeliveries, ...selfJobDeliveries],
        }),
      );
      const scheduledJobDeliveries = planScheduledJobDeliveries({
        actor: employee,
        sender: digital,
        employees,
        messages: relayMessages,
      });
      await withoutFailingTurn("job_schedule_failed", () =>
        createScheduledJobsFromRelays({
          userId: input.userId,
          digitalEmployeeId: digital.id,
          asker: { id: employee.id, name: actorName },
          deliveries: scheduledJobDeliveries,
        }),
      );
    }
    const consultAnswers: string[] = [];
    for (const relay of consultRelays) {
      const workerName = speakerName(relay.target);
      const answer = await withoutFailingTurn("worker_consult_failed", () =>
        sendChatMessage({
          userId: input.userId,
          message: relay.text,
          employeeId: employee.id,
          digitalEmployeeId: relay.target.id,
          skipHandoffFollow: true,
          consult: { fromWorkerId: digital.id, fromWorkerName: assistantSpeaker },
        }),
      );
      notifications.push(...(answer?.notifications ?? []));
      const said = answer ? parseLlmReply(answer.reply).response.trim() : "";
      if (!said) {
        consultAnswers.push(
          `?? ?????? ???? ????? ?${workerName} ? ?????? ????? ????? ????.`,
        );
        continue;
      }
      consultAnswers.push(`${workerName} ????: ${said}`);
      await withoutFailingTurn("consult_memory_failed", async () => {
        await client.appendAssistantMessage?.(
          conversation.openaiConversationId,
          `${workerName} ????: ${said}`,
        );
      });
      await withoutFailingTurn("job_answer_failed", () =>
        answerOpenJobForPair({
          userId: input.userId,
          digitalEmployeeId: digital.id,
          askerId: employee.id,
          subjectId: relay.target.id,
          answer: said,
        }),
      );
    }
    const relayed = new Set<string>();
    for (const relay of attributedRelays) {
      const key = `${relay.employeeId}:${relay.digitalEmployeeId}`;
      if (relayed.has(key) || consulted.has(relay.target.id)) {
        continue;
      }
      relayed.add(key);
      notifications.push(
        await pushRelayMessage({
          userId: input.userId,
          employeeId: relay.employeeId,
          digitalEmployeeId: relay.digitalEmployeeId,
          speaker: assistantSpeaker,
          text: relay.text,
        }),
      );
    }
    // Reports back to the asker: Lucy's own words about the subject, not a
    // forwarded relay, so they skip the "??? X" attribution.
    const jobReports = [...(jobResult?.reports ?? []), ...removedJobReports].flatMap(
      (report) => {
        const target = employees.find((row) => row.id === report.employeeId);
        return target && !isDigitalEmployee(target) && target.id !== employee.id
          ? [{ target, text: report.text }]
          : [];
      },
    );
    for (const report of jobReports) {
      notifications.push(
        await pushRelayMessage({
          userId: input.userId,
          employeeId: report.target.id,
          digitalEmployeeId: digital.id,
          speaker: assistantSpeaker,
          text: report.text,
        }),
      );
    }
    await deliverWhatsAppRelays(jobReports, employee.id);
    const involvedNotices = planInvolvedChangeNotices({
      actor: employee,
      humans,
      listMutations,
      reminderChanges: reminderResult.changes ?? [],
    });
    for (const notice of involvedNotices) {
      notifications.push(
        await pushRelayMessage({
          userId: input.userId,
          employeeId: notice.target.id,
          digitalEmployeeId: digital.id,
          speaker: assistantSpeaker,
          text: notice.text,
        }),
      );
    }
    await deliverWhatsAppRelays(involvedNotices, employee.id);
    const waRelays = await deliverWhatsAppRelays(attributedRelays, employee.id);
    const waPhones = await deliverWhatsAppPhones(attributedPhones);
    // Partner shared-list notify skips must not erase the speaker's spoken reply.
    // replaceSpoken is only for intentional outbound sends the model claimed to deliver.
    const outboundSkips = [...waRelays.skips, ...waPhones.skips];
    const skips = [...sharedWhatsAppSkips, ...outboundSkips];
    const whatsappNotice = formatWhatsAppSkipNotice(skips);
    const missingSend = formatMissingSendTextNotice(metadata.messages ?? []);
    const deliveryFailed = formatWhatsAppSkipNotice(outboundSkips).length > 0;
    let workingReply = alignListTypeInReply(turn.reply, listMutations);
    const misaddressed = correctMisaddressedJobReply({
      response: parseLlmReply(workingReply).response,
      relays: outbound.relays
        .filter((relay) => relay.target.id !== employee.id)
        .map((relay) => ({
          targetName: speakerName(relay.target),
          text: relay.text,
        })),
      reports: jobReports.map((report) => ({
        toName: speakerName(report.target),
        text: report.text,
      })),
    });
    if (misaddressed) {
      workingReply = setEngineResponse(workingReply, misaddressed);
    }
    if (jobResult && jobResult.askWhich.length > 1) {
      workingReply = setEngineResponse(
        workingReply,
        `?? ???? ??????\n${jobResult.askWhich.map((ask) => `? ${ask}`).join("\n")}`,
      );
    }
    // Model often claims mutate success when that kind did not apply ? correct.
    const requestedListRemove = (metadata.lists ?? []).some(
      (row) => row.action === "remove",
    );
    const requestedListUpdate = (metadata.lists ?? []).some(
      (row) => row.action === "update",
    );
    const requestedListAdd = (metadata.lists ?? []).some(
      (row) => row.action === "add",
    );
    const appliedListRemove = listMutations.some(
      (row) => row.action === "remove" && !row.listShell,
    );
    const appliedListUpdate = listMutations.some(
      (row) => row.action === "update" && !row.listShell,
    );
    const appliedListAdd = listMutations.some(
      (row) => row.action === "add" && !row.listShell,
    );
    const appliedListOps = listOpResults.some((row) => row.applied);
    const appliedFilingRemove = filingMutations.some(
      (row) => row.action === "remove",
    );
    const appliedFilingUpdate = filingMutations.some(
      (row) => row.action === "update",
    );
    const appliedFilingAdd = filingMutations.some(
      (row) => row.action === "add",
    );
    const listOpFallback = formatListOpFallback(listOpResults);
    const appliedFallback = formatAppliedMutationFallback(
      listMutations,
      filingMutations,
    );
    const reminderDeleteFallback =
      (reminderResult.removed?.length ?? 0) > 0
        ? formatReminderDeleteFallback(reminderResult.removed)
        : "";
    // Empty LLM response must not leak raw JSON / blank bubble to the user.
    if (!parseLlmReply(workingReply).response.trim()) {
      const fallback =
        guestMutationNotice ||
        (metadata.confirm === false
          ? "?????? ?? ??????."
          : metadata.confirm === true
            ? "????."
            : "") ||
        listOpFallback ||
        (appliedListRemove ||
        appliedListUpdate ||
        appliedListAdd ||
        appliedFilingRemove ||
        appliedFilingUpdate ||
        appliedFilingAdd
          ? appliedFallback
          : "") ||
        reminderDeleteFallback ||
        (!appliedListOps &&
        !appliedFilingRemove &&
        !appliedFilingUpdate &&
        requestedListRemove &&
        !appliedListRemove
          ? LIST_FIND_MISS
          : "") ||
        (!appliedListOps &&
        !appliedFilingRemove &&
        !appliedFilingUpdate &&
        requestedListUpdate &&
        !appliedListUpdate
          ? LIST_FIND_MISS
          : "");
      if (fallback) {
        workingReply = setEngineResponse(workingReply, fallback);
      }
    }
    workingReply = correctListMutationClaimReply({
      reply: workingReply,
      requestedRemove: requestedListRemove,
      requestedUpdate: requestedListUpdate,
      requestedAdd: requestedListAdd,
      appliedRemove: appliedListRemove,
      appliedUpdate: appliedListUpdate,
      appliedAdd: appliedListAdd,
      appliedFallback: [listOpFallback, appliedFallback].filter(Boolean).join("\n"),
      setResponse: setEngineResponse,
      spoken: parseLlmReply(workingReply).response,
      appliedListOps,
      appliedFilingRemove,
      appliedFilingUpdate,
    });
    workingReply = correctShareClaimReply({
      reply: workingReply,
      spoken: parseLlmReply(workingReply).response,
      mutations: listMutations,
      misses: shareMisses,
      setResponse: setEngineResponse,
    });
    workingReply = correctAttachmentClaimReply({
      reply: workingReply,
      spoken: parseLlmReply(workingReply).response,
      outcome: attachmentOutcome,
      setResponse: setEngineResponse,
    });
    if (
      requestedListRemove &&
      appliedListRemove &&
      !parseLlmReply(workingReply).response.trim()
    ) {
      workingReply = setEngineResponse(workingReply, appliedFallback);
    }
    // Clock-only delete (no linked worker task): do not leave LIST_FIND_MISS.
    if (reminderDeleteFallback) {
      const spokenAfter = parseLlmReply(workingReply).response.trim();
      if (!spokenAfter || spokenAfter === LIST_FIND_MISS) {
        workingReply = setEngineResponse(workingReply, reminderDeleteFallback);
      }
    }
    // The model already said ???????/?????? ? correct it when the engine refused the list op.
    const listOpRefusal = formatListOpRefusals(listOpResults);
    if (listOpRefusal) {
      workingReply = setEngineResponse(
        workingReply,
        [formatListOpFallback(listOpResults), listOpRefusal].filter(Boolean).join("\n"),
      );
    }
    // Do not append apply-summary lines ? the spoken reply is the model's response only.
    const noTimeSkipped = reminderResult.skipped.some(
      (row) => row.reason === "no_time",
    );
    if (subHourlyRepeat) {
      workingReply = setEngineResponse(workingReply, SUB_HOURLY_REFUSAL);
    } else if (noTimeSkipped || incompleteComposeClocks.length > 0) {
      workingReply = setEngineResponse(
        workingReply,
        "??? ????? ? ?????, ???? X, ?? ???? ??????",
      );
    }
    // Model / allowlist show_dump (+ section/partner/assignee/about) ? live DB dump.
    // Never utterance-parse dump intent ? ACTION fields only.
    let turnLastNumberedDump: LastNumberedDumpLine[] = [];
    /** ITEM DUMP rows with files ? engine sends them (model may omit send_attachments). */
    let itemDumpAttachmentIds: string[] = [];
    const showDumpKind = metadata.showDump?.trim() ?? "";
    if (showDumpKind) {
      const speakerAliases = [
        ...new Set(
          [employee.nickname?.trim() ?? "", employee.name.trim()].filter(
            Boolean,
          ),
        ),
      ];
      const aboutNames = showDumpNames(metadata.showDumpAbout);
      const dumpOccurrenceRange =
        metadata.showDumpFrom?.trim() || metadata.showDumpTo?.trim()
          ? {
              from: metadata.showDumpFrom ?? null,
              to: metadata.showDumpTo ?? null,
            }
          : null;
      const speakerSnapshot = await withAttachmentRefsSafe(
        await getEmployeeRecordSnapshot(input.employeeId, {
          ...(dumpOccurrenceRange
            ? { occurrenceRange: dumpOccurrenceRange }
            : {}),
        }),
      );
      const dumpIds = showDumpIdList(metadata.showDumpIds);
      const itemDumpRequested = isShowDumpIdsRequested(metadata.showDumpIds);
      const dumpPartner = metadata.showDumpPartner ?? null;
      const dumpAssignee = metadata.showDumpAssignee ?? null;
      const dumpSection = metadata.showDumpSection ?? null;
      // Derive pure collaboration mode for allowlisted / model filters.
      const dumpCollaboration =
        dumpFilterNames(dumpAssignee).length > 0 &&
        dumpFilterNames(dumpPartner).length === 0
          ? ("assign" as const)
          : dumpFilterNames(dumpPartner).length > 0 &&
              dumpSection === "shared" &&
              dumpFilterNames(dumpAssignee).length === 0
            ? ("co_share" as const)
            : null;
      const baseDumpOpts = {
        section: dumpSection,
        partner: dumpPartner,
        assignee: dumpAssignee,
        assigneeSelfNames: speakerAliases,
        dateFrom: metadata.showDumpFrom ?? null,
        dateTo: metadata.showDumpTo ?? null,
        urgency: metadata.showDumpUrgency ?? null,
        collaboration: dumpCollaboration,
        ...(itemDumpRequested
          ? { itemIds: new Set(dumpIds), omitEmptySentence: true }
          : {}),
      };
      const resolvedDumpKind = resolveShowDumpKind(showDumpKind);
      const needsPhoneBook =
        resolvedDumpKind?.kind === "full" ||
        resolvedDumpKind?.kind === "phone_book";
      const speakerPhoneBook = needsPhoneBook
        ? speakerContacts.map((row) => ({
            name: row.name,
            phone: row.phone ?? "",
            scope: (row.scope ?? "personal") as "personal" | "shared",
            ...(row.sharedWith && row.sharedWith.length > 1
              ? { shared_with: row.sharedWith }
              : {}),
            ...(row.assignedBy ? { assigned_by: row.assignedBy } : {}),
            ...(row.sharedFromOwner ? { owner: row.sharedFromOwner } : {}),
          }))
        : undefined;

      const dumpForSubject = async (
        viewerName: string,
        viewerAliases: string[],
        snapshot: Awaited<ReturnType<typeof withAttachmentRefsSafe>>,
        phoneBook?: Array<{
          name: string;
          phone: string;
          scope: "personal" | "shared";
          shared_with?: string[];
        }>,
        extraOpts?: { flatLayout?: boolean; omitEmptySentence?: boolean },
      ): Promise<{
        text: string | null;
        lines: LastNumberedDumpLine[];
        snapshot: typeof snapshot;
        opts: typeof baseDumpOpts & {
          viewerName: string;
          viewerAliases: string[];
          phoneBook?: typeof speakerPhoneBook;
          flatLayout?: boolean;
          omitEmptySentence?: boolean;
        };
      }> => {
        const dumpOpts = {
          ...baseDumpOpts,
          viewerName,
          viewerAliases,
          ...(phoneBook ? { phoneBook } : {}),
          ...(extraOpts?.flatLayout ? { flatLayout: true } : {}),
          ...(extraOpts?.omitEmptySentence
            ? { omitEmptySentence: true }
            : {}),
        };
        const mapped = formatShowDumpWithLineMap(
          showDumpKind,
          snapshot,
          dumpOpts,
        );
        return {
          text: mapped.text,
          lines: mapped.lines,
          snapshot,
          opts: dumpOpts,
        };
      };

      if (aboutNames.length === 0) {
        const { text, lines, snapshot, opts } = await dumpForSubject(
          speaker,
          speakerAliases,
          speakerSnapshot,
          speakerPhoneBook,
        );
        turnLastNumberedDump = lines;
        if (text) {
          workingReply = setEngineResponse(workingReply, text);
          const resolved = resolveShowDumpKind(showDumpKind);
          if (itemDumpRequested && dumpIds.length > 0) {
            itemDumpAttachmentIds = collectAttachmentIdsForDumpRows(
              snapshot,
              dumpIds,
            );
          }
          if (resolved?.kind === "filings") {
            const dumpAddress = navigateAddressFromFilingsDump(
              snapshot.filing ?? [],
              opts,
            );
            if (dumpAddress && !parseLlmReply(workingReply).navigateAddress) {
              workingReply = setEngineNavigateAddress(workingReply, dumpAddress);
            }
          }
          if (
            dumpIds.length === 1 &&
            resolved?.kind === "tasks" &&
            lines.length === 1
          ) {
            const title =
              lines[0]!.title_stem.trim() ||
              taskTitleFromSnapshot(snapshot, dumpIds[0]!);
            const hasLinked = taskHasLinkedReminder(snapshot, dumpIds[0]!);
            const itemButtons = singleTaskShowButtons({
              title,
              hasLinkedReminder: hasLinked,
            });
            if (itemButtons.length > 0) {
              workingReply = setEngineButtons(workingReply, itemButtons);
            }
          }
        } else if (itemDumpRequested) {
          workingReply = setEngineResponse(
            workingReply,
            "?? ????? ?? ?????.",
          );
        }
      } else {
        const blocks: string[] = [];
        const missing: string[] = [];
        let soleFilingSnapshot: Awaited<
          ReturnType<typeof withAttachmentRefsSafe>
        > | null = null;
        let soleFilingOpts:
          | (typeof baseDumpOpts & {
              viewerName: string;
              viewerAliases: string[];
            })
          | null = null;
        let filingDumpCount = 0;

        for (const aboutRaw of aboutNames) {
          const aboutPerson = matchEmployee(aboutRaw, employees);
          if (!aboutPerson) {
            missing.push(aboutRaw);
            continue;
          }
          const aboutAliases = [
            ...new Set(
              [
                aboutPerson.nickname?.trim() ?? "",
                aboutPerson.name.trim(),
                employeeDisplayName(aboutPerson),
              ].filter(Boolean),
            ),
          ];
          const aboutIsDigital = isDigitalEmployee(aboutPerson);
          const aboutIsCurrentWorker = aboutIsDigital && aboutPerson.id === digital.id;
          let subjectSnapshot = speakerSnapshot;
          if (aboutIsDigital) {
            // Digital worker lists live on that employee ? never filter the speaker's book.
            // Current chat worker ? same scope as WORKER_SAVED_DATA for this speaker.
            subjectSnapshot = await withAttachmentRefsSafe(
              await getEmployeeRecordSnapshot(aboutPerson.id, {
                ...(aboutIsCurrentWorker
                  ? { scopeItemsToViewerId: input.employeeId }
                  : {}),
                ...(dumpOccurrenceRange
                  ? { occurrenceRange: dumpOccurrenceRange }
                  : {}),
              }),
            );
          } else if (employee.isOwner === true) {
            subjectSnapshot = await withAttachmentRefsSafe(
              await getEmployeeRecordSnapshot(aboutPerson.id, {
                ...(dumpOccurrenceRange
                  ? { occurrenceRange: dumpOccurrenceRange }
                  : {}),
              }),
            );
          } else {
            subjectSnapshot = filterSnapshotForAboutPerson(
              speakerSnapshot,
              employeeDisplayName(aboutPerson),
              aboutAliases,
            );
          }
          // Inventory / tasks about this chat's worker: strip OPEN_JOBS shadow rows.
          if (aboutIsCurrentWorker && isTasksShowDumpKind(showDumpKind)) {
            subjectSnapshot = excludeItemIdsFromSnapshot(
              subjectSnapshot,
              new Set(openJobs.map((job) => job.id)),
            );
          }
          const inventoryTasks =
            aboutIsCurrentWorker && isTasksShowDumpKind(showDumpKind);
          const {
            text: rawText,
            lines: subjectLines,
            snapshot,
            opts,
          } = await dumpForSubject(
            employeeDisplayName(aboutPerson),
            aboutAliases,
            subjectSnapshot,
            undefined,
            {
              ...(aboutIsDigital && isTasksShowDumpKind(showDumpKind)
                ? { flatLayout: true }
                : {}),
              ...(inventoryTasks ? { omitEmptySentence: true } : {}),
            },
          );
          const sectionPrefix =
            aboutNames.length > 1
              ? employeeDisplayName(aboutPerson)
              : undefined;
          turnLastNumberedDump.push(
            ...subjectLines.map((line) =>
              sectionPrefix && !line.section
                ? { ...line, section: sectionPrefix }
                : line,
            ),
          );
          let text = rawText;
          if (inventoryTasks) {
            text = composeTasksDumpWithWaiting(
              rawText,
              formatOpenJobsWaitingDump(openJobs, input.employeeId),
            );
            if (!text?.trim()) {
              text = emptyListDumpSentence("?????", opts);
            }
          }
          if (text) {
            const header =
              aboutNames.length > 1
                ? `*${employeeDisplayName(aboutPerson)}*\n${text}`
                : text;
            blocks.push(header);
            if (itemDumpRequested && dumpIds.length > 0) {
              itemDumpAttachmentIds = [
                ...new Set([
                  ...itemDumpAttachmentIds,
                  ...collectAttachmentIdsForDumpRows(snapshot, dumpIds),
                ]),
              ].slice(0, 10);
            }
            if (resolveShowDumpKind(showDumpKind)?.kind === "filings") {
              filingDumpCount += 1;
              soleFilingSnapshot = snapshot;
              soleFilingOpts = opts;
            }
          }
        }

        if (blocks.length === 0 && missing.length === aboutNames.length) {
          workingReply = setEngineResponse(
            workingReply,
            missing.length === 1
              ? `?? ????? ?? ${missing[0]}.`
              : `?? ????? ?? ${missing.join(" ?? ")}.`,
          );
        } else if (
          blocks.length === 0 &&
          missing.length === 0 &&
          itemDumpRequested
        ) {
          workingReply = setEngineResponse(
            workingReply,
            "?? ????? ?? ?????.",
          );
        } else {
          const parts = [...blocks];
          if (missing.length > 0) {
            parts.push(
              missing.length === 1
                ? `?? ????? ?? ${missing[0]}.`
                : `?? ????? ?? ${missing.join(" ?? ")}.`,
            );
          }
          if (parts.length > 0) {
            workingReply = setEngineResponse(
              workingReply,
              parts.join("\n\n"),
            );
            if (
              filingDumpCount === 1 &&
              soleFilingSnapshot &&
              soleFilingOpts &&
              !parseLlmReply(workingReply).navigateAddress
            ) {
              const dumpAddress = navigateAddressFromFilingsDump(
                soleFilingSnapshot.filing ?? [],
                soleFilingOpts,
              );
              if (dumpAddress) {
                workingReply = setEngineNavigateAddress(
                  workingReply,
                  dumpAddress,
                );
              }
            }
          }
        }
      }
    }
    // WATCH create turn: live sample is a 2nd bubble after the model ack ?
    // preface ???????? ?????? (pure live asks stay unwrapped).
    const watchSampleTurn = (metadata.reminders ?? []).some(
      (row) =>
        (row.action === "add" || row.action === "update") &&
        row.composeCondition != null,
    );
    // Live weather ACTION ? Open-Meteo; tip LLM then facts (pure ask = 2 bubbles).
    // Guests: weather as main topic stays forbidden ? skip even if model emitted it.
    const weatherAction = guestSpeaker ? null : metadata.weather ?? null;
    if (weatherAction?.place.trim()) {
      const weatherBilling = {
        conversationId: conversation.id,
        employeeId: employee.id,
        digitalEmployeeId: digital.id,
      };
      const weather = await resolveWeatherMessages({
        place: weatherAction.place,
        date: weatherAction.date,
        aspects: weatherAction.aspects,
        minWaveM: weatherAction.minWaveM ?? null,
        addressGender: employee.addressGender,
        composeTip: (tipInput) =>
          composeWeatherLiveTip({
            ...tipInput,
            billing: weatherBilling,
          }),
      });
      workingReply = applyLiveDomainReply(
        workingReply,
        watchSampleTurn ? weather.body : weather.messages,
        { watchSample: watchSampleTurn },
      );
    }
    // Live market ACTION ? Yahoo Finance; guests skip (same as weather).
    const marketAction = guestSpeaker ? null : metadata.market ?? null;
    if (marketAction && marketAction.queries.length > 0) {
      const marketText = await resolveMarketReply({
        queries: marketAction.queries,
        aspects: marketAction.aspects,
      });
      workingReply = applyLiveDomainReply(workingReply, marketText, {
        watchSample: watchSampleTurn,
        watchDomain: "market",
      });
    }
    // Live Mashov ACTION ? login from filings; guests skip.
    const mashovAction = guestSpeaker ? null : metadata.mashov ?? null;
    if (mashovAction) {
      const mashovSnapshot = await getEmployeeRecordSnapshot(input.employeeId);
      const mashovText = await resolveMashovReply({
        filings: mashovSnapshot.filing ?? [],
        child: mashovAction.child,
        aspects: mashovAction.aspects,
        dateFrom: mashovAction.dateFrom,
        dateTo: mashovAction.dateTo,
        dateBoundsInvalid: mashovAction.dateBoundsInvalid,
      });
      workingReply = applyLiveDomainReply(workingReply, mashovText, {
        watchSample: watchSampleTurn,
      });
    }
    // Live places ACTION ? Google Places; guests skip.
    const placesAction = guestSpeaker ? null : metadata.places ?? null;
    const pendingLoc = guestSpeaker
      ? null
      : getPendingLocation(input.employeeId);
    if (placesAction?.query.trim()) {
      const nearSpeaker = placesAction.near === "speaker";
      const liveBilling = {
        conversationId: conversation.id,
        employeeId: employee.id,
        digitalEmployeeId: digital.id,
      };
      const placesText = await resolvePlacesReply({
        query: placesAction.query,
        place: placesAction.place,
        aspects: placesAction.aspects,
        intent: placesAction.intent,
        nearSpeaker,
        lat: placesAction.lat ?? pendingLoc?.lat ?? null,
        lng: placesAction.lng ?? pendingLoc?.lng ?? null,
        openNow: placesAction.openNow,
        minRating: placesAction.minRating,
        includedType: placesAction.includedType,
        radiusMeters: placesAction.radiusMeters,
        parkingCost: placesAction.parkingCost,
        radiusExplicit: placesAction.radiusMeters != null,
        requireLiveSelect: placesAction.requireLiveSelect === true,
        speakerAsk: input.message,
        billing: liveBilling,
      });
      workingReply = applyLiveDomainReply(workingReply, placesText, {
        watchSample: watchSampleTurn,
      });
      if (
        nearSpeaker &&
        pendingLoc &&
        !placesText.includes("??? ?????")
      ) {
        clearPendingLocation(input.employeeId);
      }
    }
    // Live Jewish / Shabbat ACTION ? Hebcal; guests skip.
    // Prefer candle-offset reminder over live jewish times when both appear.
    const candleAnchorReminder = (metadata.reminders ?? []).some(
      (row) =>
        row.scheduleAnchor === "jewish_candles" &&
        (row.action === "add" || row.action === "update"),
    );
    const jewishAction =
      guestSpeaker || candleAnchorReminder ? null : metadata.jewish ?? null;
    if (jewishAction) {
      const jewishText = await resolveJewishReply({
        place: jewishAction.place,
        date: jewishAction.date,
        aspects: jewishAction.aspects,
        query: jewishAction.query ?? null,
      });
      workingReply = applyLiveDomainReply(workingReply, jewishText, {
        watchSample: watchSampleTurn,
      });
    }
    // Live routes ACTION ? Google TRANSIT / Places board, MOT GTFS, or SIRI live_arrivals; guests skip.
    const routesAction = guestSpeaker ? null : metadata.routes ?? null;
    const routesLinesBoard = Boolean(
      routesAction?.aspects?.includes("lines"),
    );
    const routesGtfs = Boolean(
      routesAction?.aspects?.includes("schedule") ||
        routesAction?.aspects?.includes("nearest_stop") ||
        routesAction?.aspects?.includes("live_arrivals"),
    );
    if (
      routesAction &&
      (routesGtfs ||
        (routesAction.origin.trim() &&
          (routesAction.destination.trim() || routesLinesBoard)))
    ) {
      const pin = getPendingLocation(input.employeeId);
      const liveBilling = {
        conversationId: conversation.id,
        employeeId: employee.id,
        digitalEmployeeId: digital.id,
      };
      const routesResult = await resolveRoutesReply({
        origin: routesAction.origin,
        destination: routesAction.destination,
        departure: routesAction.departure,
        arrival: routesAction.arrival,
        line: routesAction.line,
        headsign: routesAction.headsign,
        stopCode: routesAction.stopCode,
        agency: routesAction.agency,
        serviceDate: routesAction.serviceDate,
        windowEnd: routesAction.windowEnd,
        aspects: routesAction.aspects,
        mode: routesAction.mode,
        requireLiveSelect: routesAction.requireLiveSelect === true,
        speakerAsk: input.message,
        billing: liveBilling,
        originLat:
          routesAction.origin.toLowerCase() === "speaker"
            ? pin?.lat ?? null
            : null,
        originLng:
          routesAction.origin.toLowerCase() === "speaker"
            ? pin?.lng ?? null
            : null,
      });
      workingReply = applyLiveDomainReply(workingReply, routesResult.text, {
        watchSample: watchSampleTurn,
      });
      if (
        routesResult.navigateAddress &&
        !parseLlmReply(workingReply).navigateAddress
      ) {
        workingReply = setEngineNavigateAddress(
          workingReply,
          routesResult.navigateAddress,
        );
      }
      if (
        routesAction.origin.toLowerCase() === "speaker" &&
        pin &&
        !routesResult.text.includes("??? ?????")
      ) {
        clearPendingLocation(input.employeeId);
      }
    }
    // Live flights ACTION ? AviationStack board / status; guests skip.
    const flightsAction = guestSpeaker ? null : metadata.flights ?? null;
    if (flightsAction) {
      const liveBilling = {
        conversationId: conversation.id,
        employeeId: employee.id,
        digitalEmployeeId: digital.id,
      };
      const flightsText = await resolveFlightsReply({
        airport: flightsAction.airport,
        direction: flightsAction.direction,
        airline: flightsAction.airline,
        airlines: flightsAction.airlines,
        city: flightsAction.city,
        flight: flightsAction.flight,
        date: flightsAction.date,
        withinMinutes: flightsAction.withinMinutes || null,
        timeFrom: flightsAction.timeFrom || null,
        timeTo: flightsAction.timeTo || null,
        aspects: flightsAction.aspects,
        requireLiveSelect: flightsAction.requireLiveSelect === true,
        speakerAsk: input.message,
        billing: liveBilling,
      });
      workingReply = applyLiveDomainReply(workingReply, flightsText, {
        watchSample: watchSampleTurn,
      });
    }
    // After live domains: empty responses:[] on a pure quote ask is filled above;
    // only then fall back so we never prepend ??? ??????? before a successful fetch.
    if (!parseLlmReply(workingReply).response.trim()) {
      workingReply = setEngineResponse(workingReply, EMPTY_REPLY_RETRY);
    }
    const reminderApplyNotice = formatReminderApplyNotice(reminderResult);
    const tipOps = collectAppliedTipOps({
      listMutations: listMutations.map((row) => ({
        action: row.action,
        listType: row.listType,
      })),
      filingMutations,
      reminderSavedCount: reminderResult.saved.length,
      reminderUpdateCount: (reminderResult.changes ?? []).filter(
        (row) => row.action === "update",
      ).length,
      reminderRemovedCount: reminderResult.removed?.length ?? 0,
      reminderRequestedAdd: (metadata.reminders ?? []).some(
        (row) => row.action === "add",
      ),
      directorySavedCount: directoryResult.saved.length,
      directoryRemovedCount: directoryResult.removed.length,
      directoryRequestedUpdate: (metadata.directory ?? []).some(
        (row) => row.action === "update" || row.action === "share_book",
      ),
    });
    const tipTurnFactItems = listMutations
      .filter(
        (row) =>
          row.action === "add" ||
          row.action === "update" ||
          row.action === "remove",
      )
      .map((row) => ({
        listType: row.listType,
        op: row.action,
        itemLabel: row.itemLabel?.trim() || row.itemKey?.trim() || "",
        itemKey: row.itemKey?.trim() || row.itemLabel?.trim() || "",
      }))
      .filter((row) => row.itemLabel);
    // Freeze per-bubble buttons/Waze onto the model reply BEFORE engine
    // tips/notices append, so legacy turn-level metadata.buttons are not
    // redistributed onto trailing tip bubbles.
    {
      const preTip = parseLlmReply(workingReply);
      let bubbles = preTip.responseBubbles;
      if (metadata.showDump) {
        // show_dump is display-only ? never attach choice taps on a bare dump.
        bubbles = clearBubbleButtons(bubbles);
      } else if (!guestSpeaker) {
        bubbles = applyShowButtonsToBubbles(
          bubbles,
          ensureSpeakerShowButtons(metadata, preTip.buttons ?? [], {
            speakerNames: [
              speakerName(employee),
              employeeDisplayName(employee),
              employee.nickname?.trim() ?? "",
              employee.name?.trim() ?? "",
            ].filter(Boolean),
            workerNames: [
              speakerName(digital),
              employeeDisplayName(digital),
              digital.nickname?.trim() ?? "",
              digital.name?.trim() ?? "",
            ].filter(Boolean),
            // Validate model LIST/collab against real apply ? not bare ACTION emit.
            // Collab kept only when mutation.collabApply proves it; else plain LIST.
            appliedNav: {
              listKeys: new Set(
                listMutations.map((row) => listNavKeyFromMutation(row)),
              ),
              filing: filingMutations.length > 0,
              collabByListKey: buildCollabByListKey(
                listMutations,
                new Map(
                  employees.map((row) => [
                    row.id,
                    employeeDisplayName(row),
                  ]),
                ),
              ),
            },
            // Item-open: keep existing-row taps; require apply proof for this-turn mutates.
            appliedItems: {
              lists: listMutations.map((row) => ({
                action: row.action,
                itemId: row.itemId,
                itemLabel: row.itemLabel,
                listType: row.listType,
                listShell: row.listShell,
              })),
              filings: filingMutations.map((row) => ({
                action: row.action,
                itemName: row.itemName,
              })),
            },
          }),
        );
      }
      workingReply = setEngineSpokenBubbles(workingReply, bubbles);
    }
    const tipTurn =
      (await withoutFailingTurn("tips_apply_failed", () =>
        resolveAndRecordTipsForTurn({
          userId: input.userId,
          speaker: employee,
          digitalEmployeeId: digital.id,
          appliedOps: tipOps,
          modelTipKeys: metadata.tips ?? [],
          turnFactItems: tipTurnFactItems,
          addressGender: employee.addressGender,
          billing: {
            conversationId: conversation.id,
            employeeId: employee.id,
            digitalEmployeeId: digital.id,
          },
        }),
      )) ?? { texts: [], tipIds: [] };
    const notice = [
      guestMutationNotice,
      registerNotice,
      missingSend,
      whatsappNotice,
      noTimeSkipped ? "" : reminderApplyNotice,
    ]
      .filter(Boolean)
      .join("\n\n");
    const replaceSpoken = deliveryFailed;
    const reply = replaceSpoken
      ? composeAssistantReply({
          llmReply: workingReply,
          notice: [...consultAnswers, notice, ...tipTurn.texts]
            .filter(Boolean)
            .join("\n\n"),
          replaceResponse: true,
        })
      : [...consultAnswers, notice, ...tipTurn.texts]
          .filter(Boolean)
          .reduce(
            (current, extra) => appendEngineNotice(current, extra),
            workingReply,
          );
    const outboundAttachments = guestSpeaker
      ? []
      : ((await withoutFailingTurn("attachments_send_failed", () =>
          resolveUsableAttachments(
            employee.id,
            [
              ...(metadata.sendAttachments ?? []),
              ...itemDumpAttachmentIds,
            ].slice(0, SEND_ATTACHMENTS_MAX),
          ),
        )) ?? []);
    const finalParsed = parseLlmReply(reply);
    const turnMessageIds = await syncTurnReplies({
      conversationId: conversation.id,
      assistantSpeaker,
      saved: messageIds,
      bubbles: finalParsed.responseBubbles,
      attachments: outboundAttachments.map(toChatAttachmentRef),
      ...(finalParsed.showIcon ? { showIcon: finalParsed.showIcon } : {}),
      ...(turnLastNumberedDump.length > 0
        ? { lastNumberedDump: turnLastNumberedDump }
        : {}),
    });

    if (conversation.needsContext) {
      await markContextInjected(conversation.id);
    }
    if (!input.skipHandoffFollow && !consultFrom) {
      const next = matchHandoffWorker(
        parsedMetadata.handoff?.worker,
        digitalEmployees(employees),
        digital.id,
      );
      if (next) {
        recordWhatsAppEvent("handoff", `follow=${next.name}`);
        return sendChatMessage({
          ...input,
          digitalEmployeeId: next.id,
          skipHandoffFollow: true,
          pendingWorkerItems: workerItems,
        });
      }
    }
    return {
      reply,
      raw: turn.raw,
      request: openaiRequest,
      notifications,
      answeredBy: digital.name,
      timing: { llmMs, afterLlmMs: Date.now() - afterLlmStarted },
      messageIds: turnMessageIds,
      outboundAttachmentIds: outboundAttachments.map((row) => row.id),
      outboundAttachments: outboundAttachments.map(toChatAttachmentRef),
    };
  } catch (error) {
    const table = missingTableName(error);
    recordWhatsAppEvent(
      "chat_failed",
      table
        ? `db_missing=${table}`
        : error instanceof Error
          ? error.message
          : "unknown",
    );
    if (error instanceof ServiceUnavailableError) {
      throw error;
    }
    throw new ServiceUnavailableError();
  }
}

async function listSharedCustomListsForActor(
  userId: string,
  actorId: string,
): Promise<SharedListRef[]> {
  const rows = await prisma.employeeList.findMany({
    where: {
      listType: "custom",
      deletedAt: null,
      employee: { userId, kind: "human" },
      OR: [{ employeeId: actorId }, { scope: "shared" }],
    },
    select: {
      employeeId: true,
      name: true,
      visibleTo: true,
      scope: true,
    },
  });
  return rows
    .map((row) => {
      const visibleTo = Array.isArray(row.visibleTo)
        ? row.visibleTo.filter((id): id is string => typeof id === "string")
        : [];
      const scope = row.scope === "shared" ? "shared" : "personal";
      return {
        ownerId: row.employeeId,
        listName: row.name,
        visibleTo: [...new Set([row.employeeId, ...visibleTo])],
        scope: scope as "personal" | "shared",
      };
    })
    .filter(
      (row) =>
        row.listName.trim() &&
        (row.ownerId === actorId ||
          (row.scope === "shared" && row.visibleTo.includes(actorId))),
    );
}
