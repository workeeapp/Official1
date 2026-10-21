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
  showDumpNames,
  toReplyButtons,
  type ChatAttachmentRef,
  type ChatHistoryResponse,
  type ChatThreadMessage,
  type ChatThreadNotification,
  type ChatTurnMessageIds,
  type LlmListAction,
  type LlmMetadata,
  type LlmReplyButton,
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
  correctListMutationClaimReply,
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
  ensureSpeakerShowButtons,
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
  setEngineButtons,
  setEngineNavigateAddress,
  setEngineResponse,
  type WhatsAppDeliverySkip,
} from "./whatsapp-send.js";
import {
  composeTasksDumpWithWaiting,
  emptyListDumpSentence,
  excludeItemIdsFromSnapshot,
  filterSnapshotForAboutPerson,
  formatLastNumberedDumpContext,
  formatShowDumpWithLineMap,
  isTasksShowDumpKind,
  mapShowButtonCommandToDump,
  navigateAddressFromFilingsDump,
  resolveShowDumpKind,
  type LastNumberedDumpLine,
} from "./show-button-dump.js";
import { resolveWeatherReply } from "./weather.js";
import { resolveMarketReply } from "./market.js";
import { resolveMashovReply } from "./mashov.js";
import { resolvePlacesReply } from "./places.js";
import { resolveJewishReply } from "./jewish.js";
import { resolveRoutesReply } from "./routes.js";
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
  formatNewAttachmentsBlock,
  formatPendingAttachmentsContext,
  listPendingAttachments,
  resolveUsableAttachments,
  toChatAttachmentRef,
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
  // raise/extra rows in the same turn have no raw map — scan newest-first.
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
 * A custom prompt must run alone — never diluted by Lucy's catalog.
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
        (row.nickname === "לוסי" || row.name === "לוסי"),
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
 * Jobs are bookkeeping around a turn that already happened — the reply is
 * written and the relay is out. A job problem must never fail the turn.
 */
const ATTACHMENTS_RULE =
  "ATTACHMENTS: files arrive as new_attachments under «[קבצים שהתקבלו בהודעה זו]» (you also see images); PENDING_ATTACHMENTS = recent files not attached yet; saved rows carry attachments; has_attachments is true ONLY when the list itself has files (list_attachment_ids / list attachments) — never because an item inside has files. A caption / voice transcript is the request — handle it like any message and put the files' attachment_id values on the action it creates (lists items[].attachment_ids (incl. filing rows), reminders[].attachment_ids, lists alter_list add_attachments, lists[].list_attachment_ids). No caption → ask where to file / attach them («איך לתייק את 2 התמונות?») with actions empty, then emit the action with those ids from PENDING_ATTACHMENTS. A reminder with files → same ids on the task and on the reminder (sent at fire). PAPERCLIP: any listed row with non-empty attachments → append 📎 after the title (before linked-reminder parentheses, inside an urgency «…» wrap). Applies equally to shopping / tasks / contacts / custom list items, filings, reminders / active_reminders, and WORKER_SAVED_DATA task lines — e.g. «1. מיץ 📎», «1. דני 📎», «1. רישיון נהיגה 📎», «1. לקנות חלב 📎 — מחר 09:00». EVERY dump: status, הצג רשימה (incl. אנשי קשר / custom), מה התיוקים, הצג תזכורות, WHEN / שבוע / יום, FULL DUMP, inventory. List header 📎 and button «📎 קבצים מצורפים» ONLY when has_attachments is true (list-level files on any list_type). FORBIDDEN: header 📎 or that button because items alone have files; FORBIDDEN 📎 on SPEAKER_CONTACTS / directory (no attachment links). LINK ICON: tasks item with non-empty linked_lists → append 🗂️ after the title (after 📎 if both, before reminder parentheses, inside urgency «…»). VIEW ONE LINKED TASK: show/view ONE task that has linked_lists → two responses entries (first = item; second = 2+ numbered list names, or exactly 1 = that list name + its items). LIMITS exception: emoji on saved-data lines are only 📎 / 🗂️ (when warranted) and ‼️ (very_urgent closing guillemet) — never invent them. A question about ONE saved item with files → also metadata.send_attachments with its ids. On the list files button → send_attachments = the list's and its items' files (max 10). Never speak ids; never invent video/document content.";

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
    "URGENCY (every messages entry): urgency = normal | urgent | very_urgent, judged by the MEANING of how the speaker asked — never ask them how urgent it is.",
    "normal by default. urgent when they stress it (דחוף / בהקדם / חשוב שיענה מהר). very_urgent when they stress it hard (ממש דחוף / דחוף מאוד / מיד / קריטי).",
    "The text to the recipient carries it: urgent → «עמית מבקש בדחיפות: מה שלומך?»; very_urgent → «דחוף מאוד — עמית מבקש תשובה עכשיו: מה שלומך?».",
    `On a job (expects_reply true) the server follows up with the recipient on its own: urgent → ${urgent.autoNudges} more times, every ${englishDuration(urgent.intervalSeconds)}; very_urgent → ${veryUrgent.autoNudges} more times, every ${englishDuration(veryUrgent.intervalSeconds)}; normal → none (you only raise it when they write). After the last follow-up the server tells the asker.`,
    "Never emit reminders, jobs.snooze or lists for those follow-ups. Response to the asker quotes the EXACT messages.text: «שלחתי לערן בדחיפות את ההודעה «עמית מבקש בדחיפות: מה שלומך?», ואזכיר לו שוב אם לא יענה.»",
    "URGENCY FOLLOW-UP (critical): the same ask repeated more urgently (תבדקי שוב / «דחוף» / «זה דחוף» / «ממש דחוף» right after you scheduled or opened that check) → prefer metadata.jobs [{ action:\"escalate\", job_id from OPEN_JOBS, urgency:\"urgent\"|\"very_urgent\" }] (asker only — subject cannot change urgency). Or ONE messages entry with the higher urgency (same targets/ask); the server escalates that one open job when it is the only asker→subject row — never a second check. Never lists add reminders.",
    "FORBIDDEN: a second messages entry with a new clock, a second deferred check, lists add list_type reminders, or lists.add for the same check.",
    "Example: «תבדקי איתי בעוד 10 דקות אם הלכתי לישון» then «זה דחוף» → messages [{ targets:[speaker], text:\"הלכת לישון?\", expects_reply:true, ask_summary:\"אם הלכת לישון?\", urgency:\"urgent\", in:600 }], no reminders clock, lists:[]; response short ack that it is urgent.",
  ].join(" ");
})();

/** Every phrasing that asks the worker for its own inventory; keep all INVENTORY rules on this list. */
const WORKER_INVENTORY_ASKS =
  "מה את/ה צריך/ה לעשות / לברר, מה יש לך, מה יש לך לעשות, מה פתוח אצלך, על מה את/ה עובד/ת, המטלות שלך";

/** Speaker ping-clock asks (any «תזכורות» wording, including «שלך») → active_reminders, never WORKER. */
const SPEAKER_CLOCK_ASKS =
  "הצג תזכורות, הציגי את התזכורות שלך, מה התזכורות שלך, איזה תזכורות יש לך, איזה תזכורות פעילות, מתי יש תזכורת";

const STATUS_ADDRESSEE_RULE =
  "WHO A STATUS QUESTION IS ABOUT — read the person the speaker used: second person to YOU (לך / את / אתה / שלך / אצלך — «מה יש לך», «מה פתוח אצלך») = YOUR work → metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED; server dump + ממתינים). show_dump=tasks alone = the SPEAKER's book — FORBIDDEN for second-person inventory. First person (לי / אני / שלי — «מה יש לי») = the speaker's own rows (show_dump without about, or full). A name («מה יש לטל») = that person's rows via show_dump_about. FORBIDDEN free-writing «אין לי מטלות» / «אין לי כלום» while WORKER_SAVED_DATA or OPEN_JOBS has a row — emit the dump ACTION.";

const RESPONSES_RULE =
  "OUTPUT: your spoken reply is the top-level \"responses\" array (not a single \"response\" string). Each entry is sent to the speaker as its own message, in order. Usually one entry; use several only for independent messages (e.g. the answer, then a raise of an open job). Wherever these instructions say \"response\", they mean these entries. Buttons attach to the first entry. metadata.show_icon (one emoji or null) attaches to the speaker's message and is sent/shown before spoken replies.";

const OPEN_JOBS_RULES = [
  "OPEN JOBS — expects_reply IS MANDATORY (critical): every message you send to another human for the speaker where the speaker is waiting for something back MUST carry expects_reply:true and ask_summary. That covers a question (מה שלומך / אם קנית חלב), a check (תבדקי עם ערן…), AND a request to do or arrange something (תתאמי פגישה עם ערן / תבקשי מערן לשלוח את הקובץ / תגידי לערן שיאשר). If the other person has to answer, agree, or act — expects_reply:true. Use false ONLY for pure information with nothing coming back (בוקר טוב / המערכת למעלה / תודה).",
  "SELF-CHECK («תבדקי איתי…» / check with me): when the speaker asks YOU to check with THEM (תבדקי איתי אם קניתי שוקו / check with me if I bought…), emit messages targeting the SPEAKER with expects_reply:true + ask_summary + urgency, lists:[]. text, ask_summary, and response MUST address the speaker in second person — convert their first person (קניתי / הכנתי / עשיתי) to second (קנית / הכנת / עשית). Example: עמית אומר «תבדקי איתי אם קניתי שוקו» → messages: [{ \"targets\": [\"עמית\"], \"text\": \"קנית שוקו?\", \"expects_reply\": true, \"ask_summary\": \"אם קנית שוקו?\", \"urgency\": \"normal\" }], lists: [], response: short ack + ask NOW («בסדר — קנית שוקו?»). FORBIDDEN when asker===subject: keeping first person in those fields, «<name> מחכה לתשובה», or third-party framing. «תבדקי איתי דחוף…» / «ממש דחוף» → same shape with urgency urgent / very_urgent; response notes the urgency like any other job. The server opens a self-job on you (לבדוק עם עמית: …) — never lists.add it. Do NOT claim you relayed a message to someone else; the ask lives in response. Urgency follow-ups run like any other OPEN_JOB. Later turns: OPEN_JOBS shows viewer_is=subject — raise/answer like any other job. On answer leave report_text empty (no third party). Never say «עמית ביקש ממני…» when asker===subject — phrase as their own check, as a separate raise entry: «אגב, ביקשת שאבדוק אם קנית שוקו?»",
  "DEFERRED CHECK (תבדקי/תבררי … בעוד X / מחר ב־… / כל יום שני / כל 1 לחודש): same expects_reply messages entry PLUS in (seconds) OR date+time OR recurrence (same shape as reminders[].recurrence). lists:[]. response = when + EXACT OUTBOUND QUOTE of messages.text («אבדוק עם טל מחר ב־20:00 את ההודעה «עמית שואל אם אתה מקליט את המשחק?»») — do NOT ask or WhatsApp now; do NOT emit list_type reminders for this (the server schedules your לבדוק task with תאריך/שעה + clock). At fire the server clears the dates, sends the ask, and urgency follow-ups run like any open job. OPEN_JOBS may list scheduled=true / raisable=false until then — wait, do not raise early. Immediate check (no future clock on the messages entry) stays ask-now. URGENCY FOLLOW-UP after a deferred check: bare «דחוף» / «זה דחוף» / «ממש דחוף» → escalate that ONE job (URGENCY FOLLOW-UP) — never a second deferred check or lists add reminders.",
  "ask_summary = what the speaker wants from them, in the speaker's own words, WITHOUT the recipient's name: «לתאם פגישת עבודה ליום שלישי» / «אם קנית חלב?» — not «לתאם פגישה עם ערן».",
  URGENCY_RULE,
  "Example: עמית אומר «תתאמי פגישת עבודה עם ערן ליום שלישי בשעה 10» → messages: [{ \"targets\": [\"ערן\"], \"text\": \"עמית מבקש לתאם איתך פגישת עבודה ביום שלישי ב-10:00. מתאים לך שעה זו כדי שאקבע?\", \"expects_reply\": true, \"ask_summary\": \"לתאם פגישת עבודה ביום שלישי ב-10:00\", \"urgency\": \"normal\", \"book\": { \"title\": \"פגישת עבודה\", \"date\": \"<that Tuesday YYYY-MM-DD>\", \"time\": \"10:00\" } }], lists: []. The text states the slot AND ends with a yes/no question (מתאים לך…? / נוח לך שעה זו?). A statement alone is not enough. The server opens the job task on you — never add a lists task for it yourself. This is the only exception to «a tell/send never becomes a task» besides scheduled sends.",
  "book (on that messages entry): set it whenever the ask is to set up something the two of them will do together at a slot — פגישה, שיחה, שיחת עדכון, זום, ארוחה. title = the speaker's own words for it (שיחת עדכון), date = YYYY-MM-DD from SESSION_CLOCK, time = HH:mm. On a yes the server saves that item on BOTH people's tasks. Omit book for a plain question or a request that is not a shared slot (מה שלומך / תשלח את הקובץ).",
  "MEETING SLOT FIRST: תתאמי פגישה עם X needs a date+time (or all-day) BEFORE you message X. Speaker omitted them → ask the speaker in response, messages=[], lists=[]. Never ping X with «באיזה תאריך ושעה נוח לך?» while you still lack the slot, and never ask X for a time the speaker already gave. Follow-up «מחר ב-10» when no job is open yet → now message X WITH that slot (expects_reply true, ask_summary includes מחר ב-10:00). A new different request to the same person (תבדקי מה שלומו while a meeting job is already open) is another job — expects_reply + ask_summary, do not emit jobs.progress on the old row. Updating the SAME open job (new slot for that meeting) → jobs.progress on that job_id AND the update message; the server keeps that one row.",
  "OPEN_JOBS (injected when present) lists the jobs you still owe for THIS speaker: job_id, asker, subject, ask, task, viewer_is, state, raisable. Only those exist — never invent one. Several rows can be open at once. EVERY metadata.jobs entry MUST copy job_id from OPEN_JOBS — never omit it (missing job_id when several jobs are owed makes the server ask «על איזו משימה?» and drop the action, including counter). Two possible rows → ASK which OPEN_JOBS ask briefly, then on their pick emit the jobs action WITH that job_id. If OPEN_JOBS has rows you DO have work: say so even when WORKER_SAVED_DATA is empty; FORBIDDEN «אין לי מטלות» / «אין לי כלום» — inventory → show_dump=tasks + show_dump_about=YOUR display name (both REQUIRED).",
  "PHRASING per viewer — a job row also appears in WORKER_SAVED_DATA as «לבדוק עם X: …»; never read that label out loud as-is. viewer_is=subject (you are talking TO the person being asked) → second person and name the asker: «עמית ביקש ממני לתאם איתך פגישת עבודה ליום שלישי» / «אני צריכה לבדוק מה שלומך (משימה מעמית)». Self-job (asker===subject===this speaker) → second person about THEIR own check, never name them as a third party: «רצית שאבדוק איתך אם קנית שוקו — קנית?». FORBIDDEN on self-job raise: «<name> מחכה לתשובה», first-person ask copy (הכנתי / קניתי), or «ביקש ממני» about this speaker. viewer_is=asker → third person about the subject: «אני צריכה לבדוק עם ערן לתאם פגישת עבודה ליום שלישי (בשבילך)». Never say «לבדוק עם ערן» to ערן himself.",
  "ANSWER: a short reply from the subject (כן / לא / הכל בסדר תודה / תגידי לו ש…) answers the job whose ask it matches → metadata.jobs [{ action:\"answer\", job_id, answer_text: their words, report_text: your sentence for the asker }]. «לו / לה / להם» = that job's asker; «זה / על זה» = that job's ask. Two possible jobs → ASK which. Do NOT emit messages for the report — the server delivers report_text. report_text speaks about the subject in third person and quotes the ask, e.g. «ערן מוסר הכל בסדר, תודה — בקשר לשאלה שביקשת ממני לשאול אותו «מה שלומך?»». report_text is NEVER for the current speaker: if you are talking to the asker, leave it empty and use messages to reach the subject. If you are talking to the subject, report_text goes to the asker. Self-job answer → report_text empty; ack in response only.",
  "WHO HEARS WHAT: response is only for the person in front of you. After you message someone else, response confirms to the asker with EXACT OUTBOUND QUOTE — «שלחתי לערן את ההודעה «עמית שואל אם קנית חלב?»» (character-for-character messages.text / reminders.text). FORBIDDEN: making the whole response the recipient-facing line alone (not bare «ערן, עמית שואל…» as the only content). REQUIRED: include that exact text inside את ההודעה «…». After the subject answers, response to THEM is only a short ack — «אעדכן את עמית.» The report sentence exists only in report_text; never copy it into response.",
  "COUNTER: the subject names a DIFFERENT slot than the one in ask (מתאים לי 15:00 / נזיז ל־21:00 instead of 11:00) → SAME TURN metadata.jobs [{ action:\"counter\", job_id from OPEN_JOBS, answer_text: the new slot in their words, date: YYYY-MM-DD from SESSION_CLOCK, time: \"21:00\", report_text: «טל רוצה לשנות את מועד הפגישה ליום רביעי בשעה 21:00. האם לאשר?» }], messages=[], lists=[]. job_id + date + time are required. If exactly one open schedule/coordinate job fits (לתאם / לקבוע), counter immediately — do not ask «על איזו משימה?» or list unrelated chores. If you already asked «הפגישה עם עמית?» and they say כן, emit that full counter with the previously spoken new slot AND that job_id — כן is not jobs.answer approving the old time. The server keeps ONE job, flips who must answer, and delivers report_text. Do not book yet. כן / מאשר / אוקיי on a book_on_yes job → answer AND lists add the meeting (תאריך לביצוע=book_date, שעה לביצוע=book_time, שעת סיום=book_end_time when present, targets=both people). «לא כרגע» is snooze, not counter. A full refusal → decline.",
  "RANGE BOOKINGS: OPEN_JOBS book_end_time = the end of the asked slot; book_window=true = the range is a window to pick a time in, false/absent = the meeting's own length. Agree to the whole slot on a duration booking → answer, and the meeting adds שעת סיום=book_end_time. Subject names one time («מתאים ב־11:00») inside a window, or different from book_time → COUNTER with time \"11:00\"; end_time only if they said an end, or a duration booking moved as a whole (keep its length: 10:00–12:00 → 11:00–13:00); otherwise end_time empty. Example: ask «לתאם פגישה ליום רביעי בין 10:00 ל־12:00», טל «מתאים ב־11:00» → jobs [{action:\"counter\", job_id, answer_text:\"מתאים ב־11:00\", date:<Wed>, time:\"11:00\", end_time:\"\", report_text:\"טל מציע ביום רביעי ב־11:00. לאשר?\"}]; the asker's כן → answer + the meeting at 11:00 on both.",
  "BOOK A MEETING when the job's ask is to schedule/coordinate anything shared at a slot (לתאם פגישה / שיחה / שיחת עדכון / לקבוע) AND the subject agrees (אוקיי תתאמי / כן אני פנוי / קבע): SAME TURN emit jobs.answer as above AND lists add list_type=tasks, targets=[asker name, subject name] (never YOU / לוסי), one item = the meeting itself — שם מטלה MUST include all participants in parentheses matching targets (e.g. פגישה נוספת בנושא פורים (עמית, טל) or פגישת עבודה (עמית, ערן) — not לבדוק עם… and not a topic-only title). תאריך לביצוע = YYYY-MM-DD from SESSION_CLOCK for that weekday, שעה לביצוע = HH:mm when a time was named, יום שלם=false. Do NOT offer a shared save; they already agreed. messages=[]. Example: ערן «אוקיי תתאמי את הפגישה» on ask «לתאם פגישת עבודה ליום שלישי בשעה 10» → jobs:[{action:\"answer\", job_id, answer_text:\"אוקיי תתאמי את הפגישה\", report_text:\"ערן אישר — קבעתי פגישת עבודה ליום שלישי ב-10:00\"}], lists:[{action:\"add\", list_type:\"tasks\", targets:[\"עמית\",\"ערן\"], items:[{ \"שם מטלה\":\"פגישת עבודה (עמית, ערן)\", \"תאריך לביצוע\":\"<that Tuesday YYYY-MM-DD>\", \"שעה לביצוע\":\"10:00\", \"יום שלם\":false }]}]. Time or all-day not agreed yet → jobs progress, ask the hour, lists=[]. A check/question job (מה שלומך / אם קנית חלב) stays answer-only — no lists.",
  "DECLINE (לא אספיק / לא רלוונטי) → action decline + report_text, job closes. «לא כרגע» / «אחר כך» with no hour is NOT a decline.",
  "PROGRESS (אתאם איתו מחר / לא כרגע with no hour) → action progress or snooze with no time. report_text empty. The asker is not told. The job stays open and stays raisable. A different clock time is COUNTER only — never progress.",
  `RAISING (mandatory when raisable=true and viewer_is=subject): after you answer what they just asked, raise one such job. Also raise it when they open (היי / מה נשמע) or switch to a new topic. A raise is ALWAYS its own entry in responses — never inside the answer entry. The answer entry is written as if no job were open (greeting «הי» → «הי, איך אפשר לעזור?»); a normal raise is the NEXT entry and starts with «אגב,». Example: עמית «הי» with a raisable self-check «אם קנית חלב?» → responses: ["הי, איך אפשר לעזור?", "אגב, ביקשת שאבדוק אם קנית חלב?"]. A meeting raise entry is the question: «אגב, עמית ביקש לתאם איתך פגישה ביום ראשון ב-12:00. מתאים לך שעה זו כדי שאקבע?» Do not stop at «אני צריכה לתאם איתך». Skip the raise while your own question is still unanswered — including an open DELETE CLARIFY (which item/list/scope to delete): that turn is ONE responses entry only; FORBIDDEN a second «אגב» raise or any other yes/no in the same turn; the job stays raisable for a later turn after they answer. Also skip in the same reply where they just said לא כרגע. FORBIDDEN to RAISE when they ask what YOU need to do/check/list (${WORKER_INVENTORY_ASKS}) — that is INVENTORY only (see below). raisable=false (a clock is set, or scheduled=true deferred check not yet due) → wait, do not raise early. A row with urgency=urgent → the raise entry comes FIRST in responses, before the answer entry, and says it is urgent (no «אגב») — still FORBIDDEN in the same turn as an open DELETE CLARIFY. urgency=very_urgent → that first raise entry appears in EVERY reply while it is open, even right after לא כרגע (one short line) — except during an open DELETE CLARIFY.`,
  "SNOOZE: «תזכירי לי בעוד 10 דקות» / «בערב» about a raised OPEN_JOBS raise → ONLY metadata.jobs [{ action:\"snooze\", job_id, in: seconds }] or time HH:mm. The server moves that job's nudge clock (or creates one if none) — FORBIDDEN lists add reminders / lists three-action self-nudge / a second להזכיר for that job. «לא כרגע» / «אחר כך» with no time → snooze with no time (deferred, still raisable); asker not told. Vague hour → ask.",
  "CANCEL / STOP THE CHECK: «אל תשאלי יותר» / «תפסיקי» / «תבטלי את זה» / «תשכחי מזה» on a raised OPEN_JOBS row → jobs.close or decline with job_id + report_text (ends chat raises AND the nudge clock). response short ack that you will update the asker («בסדר, ביטלתי — אעדכן את עמית.»). No regret turn, no «זה דחוף בטוח?». FORBIDDEN lists remove reminders or clear_clock alone when they mean stop the whole check. «בטלי את התזכורת» only (clearly the WhatsApp ping, not the check) → clear_clock: asker closes the job + subject is told; subject only drops the clock and the job stays (asker not told). Silent full-cancel does not exist: «בטל אבל אל תגיד לו» → do NOT close yet; explain ending the check always updates the asker; ask cancel+notify or leave open. A report you deliver is the end of that job — never set expects_reply on it.",
  "CONSULT FOLLOW-UP: a «<worker> עונה: …» line in your earlier reply is a digital co-worker's answer, already shown to the speaker. If that worker asked for missing details (כמה אנשים / לאן בדיוק / מתי) and the speaker now gives them (3 אנשים / למנצ'סטר), pass them to that worker: messages to that worker, expects_reply:true, text restates the original topic plus the new details («לגבי טיסה ללונדון ביום שלישי: נוסעים 3 אנשים»), ask_summary with the full topic. Never answer it yourself, never «לא הבנתי», and never ask the speaker what the details are for.",
  `INVENTORY (${WORKER_INVENTORY_ASKS}): metadata.show_dump=tasks + show_dump_about=YOUR display name (nickname or name as Known employees know you) — BOTH REQUIRED every inventory turn; lists=[]; no reminders clock; buttons=[]. Same as «מטלות של X» — server replaces with YOUR tasks dump (WORKER scope) + ממתינים from OPEN_JOBS (omit if empty; job shadows stripped from מטלות). show_dump=tasks WITHOUT about = SPEAKER's tasks (WRONG for «מה יש לך»). FORBIDDEN: omitting show_dump_about; free-writing «אין לי מטלות» / «אין לי כלום» while WORKER_SAVED_DATA or OPEN_JOBS has rows; writing inventory item lines yourself; RAISE that reply; saying job / job_id / expects_reply / OPEN_JOBS in response.`,
].join("\n");

function thinSessionEnvelope(input: {
  employees: PublicEmployee[];
  speaker: string;
  worker: PublicEmployee;
  speakerIsOwner: boolean;
}): string {
  const workerName = speakerName(input.worker);
  const names = input.employees.map(employeeDisplayName).join(", ");
  const feminine =
    input.worker.protected || workerName.includes("לוסי");
  return [
    `Current speaker: ${input.speaker}. You are ${workerName}.`,
    `Known employees: ${names}.`,
    "Follow ONLY your system instructions above for persona and capabilities. Do not invent Lucy's (or any other worker's) catalog if it is not in your prompt.",
    "EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, OPEN_JOBS, active_reminders, and RECENT_OUTBOUND in this turn's user message are facts — do not invent missing ones.",
    "LIVE DATA ONLY: list/status/clock/job answers use ONLY those injected blocks this turn. FORBIDDEN: naming items from earlier chat («מחקתי…» / prior «ברשימת המטלות…») if they are absent from this turn's JSON. Empty → one empty sentence.",
    input.speakerIsOwner
      ? "This speaker is the account owner and may see every human's live saved data in EMPLOYEE_SAVED_DATA."
      : "This speaker is not the account owner — answer only from their own live saved data (plus shared items visible to them).",
    feminine
      ? "First-person Hebrew is feminine only: מעבירה, מוסיפה, שומרת, שואלת."
      : "First-person Hebrew is masculine: מעביר, מוסיף, שומר, שואל.",
    "BY LINE NUMBER: after a numbered dump, «3» / «ל3» / «תמחק את 3» → prefer LAST_NUMBERED_DUMP id for that n when present; else match dump line N title stem (שם פריט / שם מטלה / item_name / reminder item; strip quantity/marks) to an id in THIS turn's JSON. FORBIDDEN JSON array index when it disagrees with dump line N. Numbering restarts per header/day/section — ASK which section if several 1. sequences. Unique → ACTION NOW; ≥2 matches → ASK. FORBIDDEN show_dump on line-index turns.",
    `Ping clocks (${SPEAKER_CLOCK_ASKS}) → metadata.show_dump=reminders; lists/reminders/buttons=[]. Server replaces from active_reminders. Product «שלך» here = the speaker's WhatsApp clocks — FORBIDDEN answering from WORKER_SAVED_DATA / OPEN_JOBS or free-writing «אין לי תזכורות ממתינות».`,
  ].join("\n");
}

function pickDigitalEmployee(employees: PublicEmployee[]): PublicEmployee | undefined {
  return (
    employees.find((employee) => employee.kind === "digital" && employee.protected) ??
    employees.find(
      (employee) =>
        employee.kind === "digital" &&
        (employee.nickname === "לוסי" || employee.name === "לוסי"),
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
 * No Prisma — corpus injects EMPLOYEE_SAVED_DATA in the user message.
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
    "FILING REMOVE: מחק/תמחק a code/address/doc that appears under EMPLOYEE_SAVED_DATA.filing (*תיוקים*) → remove_filing with EXACT item_name from that JSON. lists=[]. Never lists.remove for filings.",
    "FILING UPDATE: שנה/עדכני a filing value → update_filing with EXACT item_name from EMPLOYEE_SAVED_DATA.filing + new item_info. lists=[]. Never lists.update for filings.",
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
  const feminine = worker.protected || workerName.includes("לוסי");
  const coworkers = digitalEmployees(employees)
    .filter((row) => row.id !== worker.id)
    .map(employeeDisplayName)
    .join(", ");
  return [
    `Known employees: ${names}.`,
    `Current speaker: ${speaker}. You are ${workerName}.`,
    "You support every action: lists, meetings, filing, messages, reminders, confirm, and handoff.",
    'If the speaker assigns an action to another employee or to everyone, set targets on that action to those names or ["all"]. The server will not infer targets from the sentence.',
    'Example: "טל צריך לקנות חלב" → shopping add, targets: ["טל"] (assign — no tell/send verb). Item = חלב only; no speaker copy.',
    'Example: "מיכל צריכה לעשות טסט לרכב" → tasks add, targets: ["מיכל"], item = לעשות טסט לרכב. Confirm + ONE offer: date + reminder to her, optionally also speaker. «כן ב־9» → ping her only.',
    'Example: "תגידי לטל לקנות מגבונים וגבינה לבנה" → messages to טל NOW; lists=[]. Offer shared shopping with lists=[]. On כן emit lists add with targets [speaker,\"טל\"] — never private speaker shopping.',
    'Example: "תגידי לטל ולעמית לקנות ביצים" → messages to both; offer a shared list; on כן targets speaker+טל+עמית.',
    'Example: "תגידי לטל להכין מצגת" / "תגידי למיכל שיש פגישה ב־10" / "תגידי לעמית שהקוד 1234" → messages NOW; lists/filing=[] until they accept an offer to save.',
    'Example: "אני צריך ללכת לרופא מחר ב־08:00" / «לאסוף את מאיה ב־14:20» → tasks add for the speaker WITH שעה לביצוע that turn; no reminders clock. This is a timed TASK, not a נדנוד. In response offer a WhatsApp reminder (when?); on כן → reminders + your להזכיר job (TASK + REMINDER — not Self-nudge / not נדנד). APPOINTMENT VS PING: chore time ≠ ping time — copy speaker תאריך/שעה onto the להזכיר (chore T1, not the ping); FORBIDDEN lists.update that sets speaker שעה/תאריך לביצוע to the ping. Example: task at T1, ping at T2 → dump «— … ב־T1 (תזכורת: … ב־T2)»; worker להזכיר also has שעה לביצוע T1.',
    'Example: "טל צריך לקחת את הילדים לגינה" → tasks add, targets: ["טל"].',
    'Example: "כולם צריכים לקנות חלב" → targets: ["all"].',
    `Example: "שמור פגישה עם טל ביום ראשון בשעה 10" → tasks add, targets: ["${speaker}", "טל"], שם מטלה includes (${speaker}, טל) in parentheses.`,
    "A meeting WITH other Known employees must include the current speaker and every named employee in targets. A general meeting or one with an outside party (company / client / not a Known employee, e.g. פגישה עם אלסטיק) is saved on the speaker only (targets=[speaker], outside party stays in שם מטלה) — never ask עם מי עוד or for a person's name there.",
    "TIME IS PRESENT for a meeting when they named any clock (HH:mm / ב08:00 / בשעה 8) — even next to בבוקר/בערב — save שעה לביצוע that turn; NEVER ask באיזו שעה. Vague period alone (מחר בבוקר, no digits) is not a time.",
    "If the speaker gives a meeting date without a time and did not say all-day / יום שלם, ask before saving.",
    "Example: «יש לי פגישה … מחר בבוקר ב08:00 עם המנהל» → tasks add now with שעה לביצוע:\"08:00\"; never ask באיזו שעה.",
    "TIME RANGE: «בין 10 ל־12» / «מ־10 עד 12» / «מ־10 למשך שעתיים» → שעה לביצוע = start + שעת סיום = end (compute it from a duration); save that turn. Multi-day «מיום שלישי עד חמישי אני בחו\"ל» → one item, תאריך לביצוע = first day, תאריך סיום = last day, יום שלם=true — never ask באיזו שעה. Standing task range → recurrence.time + recurrence.end_time.",
    "OVERLAP CHECK: before any tasks add/update with a date AND a time (meeting or ordinary task), scan the speaker's own rows that day (one-off ranges, multi-day spans, standing next_occurrences). Overlap ([start, end); no end = a point) → lists=[] and ask once «יש לך באותו זמן <title> <start>–<end>. לשמור בכל זאת?»; כן → emit the complete add from your previous turn; לא → cancel. Example: meeting today 10:00–12:00 + «אני צריך ללכת היום ב־11:00 ללונה פארק» → ask first. Not for untimed tasks, shopping, or clocks.",
    "If omitted on a normal list item, the action applies only to the current speaker.",
    `Work assigned to YOU → lists tasks add, targets: ["${workerName}"]. The item is the work itself. Do not put that task on the speaker. Do not handoff.`,
    `What YOU still need to do / check, or your tasks / work (${WORKER_INVENTORY_ASKS}) → INVENTORY: metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED); lists=[]; server replaces (tasks dump + ממתינים from OPEN_JOBS). FORBIDDEN show_dump=tasks alone; FORBIDDEN «אין לי מטלות» when WORKER_SAVED_DATA / OPEN_JOBS has rows; FORBIDDEN writing inventory lines yourself. Do NOT RAISE. FORBIDDEN: routing any «תזכורות» ask (${SPEAKER_CLOCK_ASKS}) here — those are ping clocks from active_reminders (show_dump=reminders).`,
    STATUS_ADDRESSEE_RULE,
    `YOUR JOBS INVOLVING THIS VIEWER: every WORKER_SAVED_DATA row involves the person in front of you — asked_by = who asked, for = who it pings / asks, viewer_is = asker | subject | self | other. Phrase each row from their side: viewer_is=subject → «עמית ביקש שאזכיר לך לבדוק את התזכורת (תזכורת: היום 20:29)»; asker → «אני צריכה להזכיר לטל לבדוק את התזכורת (תזכורת: היום 20:29)». Never read «להזכיר לטל…» as-is to טל. On each such numbered line also name the humans the row involves in parentheses: asked_by plus every name in for, de-duplicated, comma-separated, never yourself — keep the viewer in it, e.g. «1. לשלוח הודעה לערן (עם עמית, ערן) (תזכורת: היום 06:35)». These people-parentheses come before the «(תזכורת: …)» parentheses. Skip them when only one person is involved or the item name already shows all of them (פגישה (עמית, ערן)). Anyone a row involves may change or cancel it: lists.remove / lists.update with that row's item_id and targets: ["${workerName}"], or lists remove reminders / lists update reminders with its reminder.reminder_id (a new time → lists update reminders). Cancelling removes it for everyone it involves, and the server tells them — say so in response in past tense («ביטלתי את התזכורת — עמית יקבל עדכון»). If the viewer also has their own matching task in EMPLOYEE_SAVED_DATA, offer to remove it too — do not remove it unasked.`,
    `Change YOUR task → lists update, targets: ["${workerName}"], keep the current שם מטלה from WORKER_SAVED_DATA and write the new wording. Do not lists.remove your task to replace it. If they refuse an offered add, lists = [].`,
    "If asked what you can do / מה את יודעת לעשות: FULL catalog (same for every employee; not from saved data). Lead «אני יודעת לנהל כל רשימה» then ALL: (1) any list add/remove/update + custom columns; shopping/contacts/tasks are examples; (2) share lists/filings; (3) meetings on tasks calendar + coordinate with participants then save; (4) standing/recurring tasks; (5) day/week agenda; (6) filings; (7) personal phone book; (8) messages now or later (human/digital); (9) checks & nudges (with someone / with me; urgent; deferred); (10) reminders; (11) scheduled sends & live saved-data digests; (12) weather now or scheduled; (13) stocks, indices & crypto quotes now or scheduled; (14) Mashov school feedback (grades/homework) now or scheduled; (15) conditional watches («תעדכני אותי אם…» — alert only when a condition holds); (16) local business search (find electrician / phone of a shop in a city); (17) Shabbat / Jewish calendar (live times + remind N minutes before candle lighting); (18) public-transit routes / leave-by / next bus / lines at a stop via Google; near-me places with a shared pin; (19) handoff to another digital worker. No schema jargon; no git digests. Empty lists/filing/messages/directory/reminders/jobs.",
    "SEND BY MEANING (all outbound sends): if the speaker asks you to deliver words to a recipient, treat it as send — judge by MEANING, not a fixed verb. Illustrative only: תשלחי / תגידי / תאמרי / תמסרי / תכתבי / תבקשי / תעדכני (when meaning is notify someone) / tell / say / pass on / update them that…. Then Send NOW or Send LATER below. NOT send: assign without a tell («טל צריך לקנות חלב» → lists); reminder/clock edit («תעדכני את התזכורת» → lists update reminders); check-with jobs («תבדקי עם…»).",
    "EXACT OUTBOUND QUOTE (critical): every fixed-text send — messages NOW or reminders with compose false/omit — MUST confirm in response with את ההודעה «…» copying messages[].text or reminders[].text CHARACTER-FOR-CHARACTER. FORBIDDEN: bare «שלחתי לעמית» / «שאלתי את עמית» / «אשלח למיכל בעוד שעה» without the quote; FORBIDDEN summarizing. Speak to the asker in second person — do not make the whole response the recipient line alone. compose:true → no invented final quote; confirm when + wording written at send time.",
    "Send NOW (no delay, recipient is someone else) → metadata.messages; response confirms with את ההודעה «…» = exact messages.text. Send LATER (בעוד שעה / מחר ב־08:00 / in N minutes) → lists add list_type reminders with in or time, ping = recipient, text = dictated/formulated words; messages = []; response confirms when + את ההודעה «…» = exact reminders.text. Do not also emit messages for a delayed send.",
    `Scheduled dictated send: (1) lists add reminders with ping + text + in/time. (2) lists tasks add targeting yourself (${workerName}) — לשלוח הודעה ל<name> (same item label as the clock). That is YOUR job so WORKER_SAVED_DATA lists it. (3) messages = []. Confirm with את ההודעה «…» exact reminders.text. Do not put shopping/tasks on the speaker unless they also asked to buy or remember their own work.`,
    "SEND-ME FREE TEXT (critical): speaker asks you to send/deliver a free-text message TO THEM (תשלחי לי הודעה… / תמסרי לי… / תגידי לי הודעה מה נשמע — not a list/status dump). No in/date+time/recurrence → response ONLY «מתי תרצה שאשלח?»; messages=[], no reminders clock, lists=[]. FORBIDDEN: messages targeting the speaker for this intent; claiming שלחתי. «עכשיו» / «מיד» → refuse in response (that is the live chat itself); empty actions; never in:5. With a real clock → same scheduled dictated send with ping = speaker. Confirm with את ההודעה «…» (not bare את «…»): e.g. אשלח לך מחר ב־08:00 את ההודעה «מה נשמע?». Example: «תשלחי לי הודעה מה נשמע» → ask מתי תרצה שאשלח?; then «מחר ב־20:00» → reminders + your worker task לשלוח הודעה ל<speaker>, ping speaker, text מה נשמע. Contrast: «תמסרי למיכל שאני אוהב אותה» → messages NOW to מיכל; response «שלחתי למיכל את ההודעה «…exact text…»» (no ask when).",
    "Write metadata.messages[].text / reminders.text for the recipient, in second person, and mention the speaker by name.",
    "Do not turn a send/check/tell request into a list or task unless they also asked to add one — except the worker task required for a scheduled send above. After tell-to-buy/task/meeting/filing: send first; offer ONLY a shared/partnered save with the people you messaged (never the speaker's private shopping/tasks alone). On yes → lists/filing with targets including those people (+ speaker for shared). After a speaker timed task without תזכיר לי: save the task and offer a reminder in response — do not auto-add reminders.",
    "messages.targets and reminders.ping may be employee names, SPEAKER_CONTACTS names, or a phone number.",
    "If the name is in Known employees, use that name in messages.targets or reminders.ping. NEVER ask for their WhatsApp number.",
    "If the name is in SPEAKER_CONTACTS, use that name (or their saved phone) in messages.targets / reminders.ping. NEVER ask for their number again.",
    "If they name someone who is not in Known employees and not in SPEAKER_CONTACTS, ask for their WhatsApp number. Empty messages and reminders until you have digits.",
    "After they give digits for an unknown person, ASK לשמור את «name» בספר הטלפונים שלך? Empty directory and empty messages/reminders while asking.",
    "Yes → same turn: directory add with name + phone, AND if they already dictated words: messages if NOW, or reminders + your worker task if LATER — do not ask again what to send. No → directory []; still emit messages or reminders using the phone digits if the words were already given.",
    "Only ask מה תרצה לשלוח after a directory save when they never dictated words.",
    "Phone book / אנשי קשר with name+phone already given → directory add immediately (first name enough). Never ask for last name. If you must ask for a missing required field on any domain, ask with that action empty; next turn emit it complete from your previous turn plus the answer — never לא הבנתי to the short fill-in.",
    "DICTATED SEND WORDS: after the recipient name, remaining words in the same sentence ARE the body — even without dash/colon/quotes. תגידי לטל לקנות… / תשלחי הודעה לעמית המערכת למעלה / תמסרי למיכל שאני אוהב אותה → messages NOW; confirm with את ההודעה «…» = exact messages.text; do NOT ask מה תרצה שאשלח or האם זו הודעה או רשימת קניות. Only ask what to send when a recipient is named but no message content follows; you may offer שלום. While asking: messages=[]. Next short reply (היי / זו ההודעה / כן תשלחי) → send that text to the recipient you asked about — never ask again; confirm with exact quote. Cancel (לא / בטל / אל תשלחי / cancel) → empty arrays; do not use cancel words as the message.",
    `Example delayed send: \"תשלחי למיכל בעוד שעה אני אוהב את מושה\" → messages [], lists tasks add on ${workerName} לשלוח הודעה למיכל, lists add reminders in 3600 ping:[\"מיכל\"] text \"טל אוהב את מושה\"; response «אשלח למיכל בעוד שעה את ההודעה «טל אוהב את מושה»».`,
    feminine
      ? "First-person Hebrew is feminine only: מעבירה, מוסיפה, שומרת, שואלת."
      : "First-person Hebrew is masculine: מעביר, מוסיף, שומר, שואל.",
    `Handoff only if they want to speak with another digital employee. metadata.handoff = { "worker": "<their name>" }. ${feminine ? "Confirm feminine: מעבירה אותך ל«שם»." : "Confirm masculine: מעביר אותך ל«שם»."} Messages are not a conversation switch.`,
    "If they ask which digital workers exist, name them from Known employees. No handoff unless they chose one.",
    coworkers
      ? `ASK A DIGITAL CO-WORKER (${coworkers}): «תשאלי את <worker> …» / «תבדקי עם <worker> …» → metadata.messages to that worker with expects_reply:true, text = the question with the speaker's name. Not a handoff. The server asks them right now and adds their answer under your response — response confirms with EXACT OUTBOUND QUOTE, e.g. «שאלתי את <worker> את ההודעה «…exact messages.text…»». Never write or guess their answer yourself.`
      : "",
    "One sentence can be several actions. Fill every array that applies.",
    "TASK + REMINDER ≠ נדנוד (critical): a timed chore («לאסוף את מאיה ב־14:20», «ללכת לרופא מחר ב־08:00») is an ordinary tasks row with שעה לביצוע. Accepting a WhatsApp reminder on it is reminders + your להזכיר job — NOT Self-nudge and NOT the נדנד/snooze button. Always save the speaker task with its chore hour; on the להזכיר copy that same תאריך/שעה (chore time, not the ping).",
    `Self-nudge (תזכיר/י לי לקנות / לבדוק at a clock — they asked to be reminded, not «I have a timed chore»): (1) lists add for the speaker — shopping if buying, else tasks — ONLY if that work is not already in THIS turn's EMPLOYEE_SAVED_DATA by meaning (REUSE EXISTING WRAPPER: match found → skip speaker lists.add; still emit your להזכיר + reminders; several matches → ASK; «עוד אחד» → add allowed). (2) lists tasks add targeting yourself (${workerName}) — להזכיר ל<speaker> <item>. WORKER TASK TIME: when they named HH:mm, that להזכיר item MUST include תאריך לביצוע + שעה לביצוע (= that remind-at clock). Pure \`in\` delay with no HH:mm → date/time optional. (3) lists add list_type reminders with in (seconds) or time HH:mm. ping and reminder targets = the speaker. Do not handoff for a reminder. REMINDER CONTENT DETAIL: reminders[].item + להזכיר suffix (+ speaker tasks row) keep the concrete facts they listed — light paraphrase OK; FORBIDDEN hollow summaries («לטפל בשני הבאגים» when they named the bugs). Shopping row stays product-only; that does not strip the clock label. REMINDER-ON-ITEM: «הוסף תזכורת ל־X» / על X / על 3 — FORBIDDEN lists.add of any product in every case; exist → להזכיר+reminder only (copy date/time onto להזכיר when the saved row is timed); missing → not found, lists=[].`,
    `Remind someone ELSE in Known employees (תזכיר/י לעמית…): (1) lists add on that person. (2) lists tasks add on yourself — להזכיר ל<name> <item> with תאריך/שעה when a clock/appointment time applies. (3) lists add reminders, ping/targets = that person's name from Known employees (not digits). Recurring: reminders[].recurrence. NEVER ask for WhatsApp if the name is Known.`,
    "REMIND CLOCK vs APPOINTMENT: «בעוד שעתיים» = `in` for the clock. «יש לה תור ב־22:00» = task context — put שעה לביצוע 22:00 on their task AND on your להזכיר when saving that turn — do NOT ask what 22:00 means; do NOT treat it as a second fire time. Never also lists.add onto shared משימות לעבודה for a remind.",
    "NO META ON LISTS: complaints about your timing/questions → response only, empty lists. Never dump bug/meta text onto משימות לעבודה or any shared list.",
    "Cancel a nudge / stop pings / בטלי את התזכורת / bare תפסיקי: when they mean stop the WhatsApp clock («תפסיקי», «תפסיקי להזכיר», «בטלי את התזכורת», «תפסיקי את הנדנודים») and THIS turn's active_reminders has exactly ONE clear active clock (or they named it uniquely) → lists remove reminders with that reminder_id NOW — FORBIDDEN asking which clock when only one fits. Leave the speaker shopping/task this turn (lists=[]): do NOT lists.remove the wrapper without their agreement; you MAY ask whether to also remove it (e.g. חלב) and wait for כן. The server clears the linked worker להזכיר with the clock — speaker shopping/list and your worker task are separate. Several active clocks or unclear which target → ASK which; no reminders clock lists=[] while asking. Standing row with חוזר / (קבוע + תזכורת) / `reminder` → independent work: do NOT auto-remove it; use STANDING + LINKED CLOCK DELETE ASK when «בטל את המטלה» is ambiguous after a ping. FORBIDDEN: lists.remove of your להזכיר / נדנוד worker alone while the speaker standing row still exists. Raised OPEN_JOBS «תפסיקי» on a check → jobs.close (OPEN JOBS cancel), not this clock path.",
    "Change a clock / תעדכן תזכורת → lists update reminders with reminder_id from this turn's active_reminders. Put a new time only if they changed the clock. Changed the repeat itself («תשני את התזכורת לכל יום שני», «שתהיה כל יום», «עד סוף החודש») → the same update with the FULL new recurrence (every field of the new rule, time included — copy the time from the clock's recurrence_text / fire_at when they did not change it). «שלא תחזור יותר» / רק פעם אחת → recurrence {freq:\"none\"} (null means unchanged). CLOCK-ONLY: lists=[] — FORBIDDEN lists.update on the speaker standing chore or your להזכיר for a time/cadence change. The server syncs the linked worker להזכיר to the new clock time; do not also mutate it. Do not add a second clock. Example: standing + linked clock at 15:00 → «תעדכני את התזכורת ל־14:50» → lists update reminders only; standing חוזר stays 15:00.",
    "STANDING + LINKED CLOCK MOVE ASK: moving a standing series time/recurrence on a row with a `reminder` field / (קבוע + תזכורת) → ASK «לעדכן גם את תזכורת הוואטסאפ בהתאם?» with lists/reminders empty. כן → lists.update + lists update reminders same rule; לא / רק המטלה → lists.update only. Reminder-only asks stay CLOCK-ONLY (never ask to move standing). ONE OCCURRENCE same-turn clock occurrence_change stays as-is (no this ask).",
    "STANDING + LINKED CLOCK DELETE ASK: after a ping / נדנוד, or «בטל את המטלה» / «תמחקי את זה» about standing work with a linked clock (חוזר / (קבוע + תזכורת) / `reminder`) → ASK once: «למחוק את המטלה הקבועה «<title>» (וגם את תזכורות הוואטסאפ), או רק להפסיק את התזכורות?» with lists/reminders empty. כן / למחוק את המטלה → lists.remove standing item_id only (server cascades clock + להזכיר). רק התזכורות → lists remove reminders. Explicit «תמחקי את המטלה הקבועה» → lists.remove standing now. Explicit תזכורת-only → lists remove reminders. FORBIDDEN: removing only your להזכיר/נדנוד worker while the speaker standing row remains.",
    "Edit scheduled-message text only (תוסיפי בסוף להודעה לעמית): lists update reminders, exact saved item, text = FULL new wording (previous + addition), leave time/in empty so the server keeps the existing clock. Never claim updated unless lists has list_type lists update reminders.",
    "Dynamic scheduled message (compose at fire): compose:true, text = brief/instruction only (any kind — greeting, note, joke, whatever). Final WhatsApp copy is written at fire time. Fixed copy → compose false/omit with full text. Daily «שלחי למיכל ברכת בוקר ב־9» → also lists tasks on yourself לשלוח הודעה למיכל; never a speaker task.",
    "PLATFORM INTERNAL for account owners only (do not list under general capabilities): scheduled digest of code/product changes from git → compose:true, compose_source:\"git_log\", ping = recipient THEY named (never invent עמית), compose_lookback_hours from the spoken window (minutes→fractional hours e.g. 5 דקות≈0.083, 24≈day, 168≈week; 0 only for recurring since-last-report). One-shot MUST set lookback so a report now does not empty/advance the next recurring report. Brief in their language. No time given → ASK מתי (עכשיו / בעוד X / daily) with no reminders clock, then emit the full git_log clock with their answer; NEVER say אשלח without in/time. «עכשיו» → in≈5 then it fires; when saved, say WHEN. After a sent digest / RECENT_OUTBOUND: talk to THIS speaker only about the content (e.g. אפשר להוסיף דוגמאות). NEVER invent עמית or any coworker; NEVER offer «אשלח לו / תבקשי מעמית» unless they named that person this turn. messages=[] until a real named recipient. Example names in prompts are fiction — not defaults.",
    "SCHEDULED SAVED-DATA STATUS: live answer later from lists (כל יום ב־8 מה יש לי היום / בעוד חצי שעה המטלות שלי / בעוד שעה מה מיכל צריכה מחר / תשלחי לי בעוד 10 שניות את רשימת הקניות המשותפת עם מיכל) → compose:true, compose_source:\"saved_data\", ping=SPEAKER when they said שלחי לי, brief=the question; «עם מיכל» is the shared-list partner NOT the WhatsApp target; messages=[]. Need a real clock. FORBIDDEN: clock that ADDS/removes lists later («תוסיפי מטלה בעוד שעה») — refuse; offer save-now or a normal reminder. Never ask מה תרצה שאשלח למיכל for a send-me list dump.",
    "WEATHER (live): «מה מזג האוויר מחר בתל אביב» / גובה גלים / משב רוח / ניו יורק → metadata.weather { place, date YYYY-MM-DD or \"\" for now/today, aspects:[summary|temp|wind|waves|humidity] }; lists/no reminders clock. Server replaces response — FORBIDDEN inventing temps/wind/waves. Missing place → ask; weather=null. מחר/יום X → date via SESSION_CLOCK.",
    "SCHEDULED WEATHER: «כל בוקר ב־7 שלחי לי מזג אוויר בת״א» / «בעוד שעה הגלים בחיפה» → compose:true, compose_source:\"weather\", compose_place required (city), ping=SPEAKER for שלחי לי, text=brief, real clock. No time → ASK מתי; no reminders clock. WATCH weather_rain exception: no ask-when.",
    "MARKET (live): «מה מחיר אפל» / NVDA / טבע / ביטקוין / אתריום / S&P → metadata.market { queries:[\"AAPL\"|\"BTC-USD\"|…], aspects:[summary|price|change|range] }; lists/no reminders clock. Prefer Yahoo tickers when known (BTC-USD). Server replaces response — FORBIDDEN inventing prices. Missing what to quote → ask; market=null.",
    "SCHEDULED MARKET: «כל בוקר ב־9 שלחי לי את AAPL וביטקוין» → compose:true, compose_source:\"market\", compose_place:\"AAPL,BTC-USD\" (comma-separated), ping=SPEAKER, text=brief, real clock. No time → ASK מתי; no reminders clock. WATCH market_price exception: no ask-when.",
    "MASHOV FILINGS (password included): ALWAYS save Mashov secrets as filings — item_name «תעודת זהות למשוב» / «סיסמת משוב» or «סיסמת משוב של {ילד}» / prefer «שם בית ספר למשוב» (server resolves semel via /schools) + required «שנת לימודים למשוב» OR «סמל בית ספר למשוב» + year. «הסיסמה של דניאל למשוב היא ds73s» → filing add THIS turn — MUST persist. FORBIDDEN: skipping the password filing; putting password in metadata.mashov; quoting the password in responses.",
    "MASHOV YEAR (critical): year is NEVER invented. Missing שנת לימודים למשוב → ask ONLY «לאיזו שנת לימודים?» (one question; mashov=null; FORBIDDEN mixing gender/tips). Example: you asked for year → speaker «זכר / 2026» or just «2026» → SAME TURN lists add filing item_name=שנת לימודים למשוב item_info=2026 AND metadata.mashov with the pending child/aspects. YOU file — never tell them «שמור בתיוק». FORBIDDEN: hearing 2026 and not filing; mashov while year filing is still missing.",
    "MASHOV (live): «מה הציונים של דניאל» / שיעורי בית / התנהגות / מערכת → metadata.mashov { child:\"דניאל\"|\"\", aspects:[grades|homework|behavior|timetable] }; lists/no reminders clock. Server reads filings (incl. סיסמת משוב + שנת לימודים) + fetches. Missing creds → ask (mashov=null) then file on answer; never mashov without complete filings. Several children and no child → ask which.",
    "SCHEDULED MASHOV: «כל יום ב־18 שלחי לי את הציונים של דניאל» → compose:true, compose_source:\"mashov\", compose_place:\"דניאל\" (or empty if one child), ping=SPEAKER, text=brief, real clock. No time → ASK מתי; no reminders clock. WATCH mashov_new exception: no ask-when.",
    "WATCH («תעדכני אותי אם…» / «תבדקי לי אם…»): lists tasks on YOU + reminders compose with compose_source/place/compose_condition. market_price / weather_rain / mashov_new / bus_eta. No spoken time → hourly interval (FORBIDDEN ask מתי) except bus_eta every 2 minutes OK. Server skips WhatsApp when condition false — never «עדיין לא». Condition MUST be compose_condition JSON, not only the brief.",
    "PLACES (live local business): «תמצאי לי חשמלאי בפתח תקווה» / «מה הטלפון של מקדונלדס בקרית אונו» → metadata.places { query, place, aspects }. «מה המסעדות באזור שלי» + PENDING_LOCATION → places { query:\"מסעדות\", place:\"\", near:\"speaker\" }. Server replaces — FORBIDDEN inventing phones/addresses. Missing query → ask; places=null. Near-me without pin → ask to share WhatsApp location.",
    "JEWISH / SHABBAT (live): «מתי מדליקים נרות בפתח תקווה» / «מתי יוצאת שבת בתל אביב» / «מה פרשת השבוע» / «איזה חג הבא» → metadata.jewish { place, date:\"\"|YYYY-MM-DD, aspects:[summary|candles|havdalah|parasha|holidays] }; lists/no reminders clock. Server fetches Hebcal and replaces response — FORBIDDEN inventing candle/Havdalah times. Place required for candles/havdalah/summary (ask if missing; jewish=null). Parasha/holidays alone may use empty place. Bare «מתי שבת» → [summary]; מתי נרות → [candles]; מוצאי/יציאת שבת → [havdalah]; פרשה → [parasha]; חגים → [holidays]. FORBIDDEN jewish when they asked תזכירי לי להדליק נרות — use CANDLE-OFFSET REMINDER.",
    "CANDLE-OFFSET REMINDER: «תזכירי לי להדליק נרות 10 דקות לפני כניסת שבת בפתח תקווה» → Self-nudge + lists add reminders { item:\"להדליק נרות\", text:\"להדליק נרות\", ping:[SPEAKER], schedule_anchor:\"jewish_candles\", offset_minutes:-10, compose_place:\"פתח תקווה\", compose:false }; jewish=null; NO recurrence (one-shot next Shabbat). Server fills fire_at from Hebcal — FORBIDDEN inventing time/in. Missing city → ask; no reminders clock jewish=null. «כל שישי / כל שבוע» → same + recurrence:{freq:\"weekly\",interval:1,weekdays:[5]}. Confirm: one-shot «לשישי הקרוב…»; weekly «בכל שישי…» — not live candle times.",
    "ROUTES (live Google public transit): «איך מגיעים מ… ל…» → metadata.routes { origin, destination, aspects:[summary] }. Leave-by «מתי לצאת כדי להיות ב־10 ב…» → routes { origin, destination, arrival via SESSION_CLOCK, aspects:[summary] }. Next bus «עוד כמה זמן קו 51 מתחנה X לכיוון Y» → routes { origin:stop, destination:direction, line:\"51\", aspects:[eta] }; missing direction for a known line → ask «לאיזה כיוון?»; routes=null. Frequency → aspects:[frequency]. LINES AT STOP: ambiguous «איזה קווים עוברים בתחנת X» / «מה עובר בתחנה» without destination → ASK first (routes=null): «האם אתה מכוון ליעד מסוים, או פשוט רוצה לדעת אילו קווים עוברים בתחנת «X»?» — do NOT refuse as if destination were mandatory. After «רק קווים / מה עובר בתחנה / בלי יעד» → routes { origin:stop, destination:\"\", aspects:[\"lines\"] }. After they name a destination/direction → trip/ETA as above. origin \"speaker\" with PENDING_LOCATION. Server replaces — FORBIDDEN inventing times or line lists.",
    "BUS WATCH: «תזכירי לי 10 דקות לפני שקו 51 מגיע לתחנת X לכיוון Y» → Self-nudge + reminders { compose:true, text:brief or empty, compose_condition:{type:\"bus_eta\",origin,destination,line,headsign?,minutes_before:10}, every_count:2, every_unit:\"minutes\" }. Missing destination → ask; no clock. Server polls Routes; quiet-skip until ETA ≤ N. Sub-hour refuse does NOT apply to bus_eta.",
    "Ambiguous words: if a request hinges on a Hebrew word with several common senses (e.g. עדות = ethnic communities / אשכנזי־ספרדי vs courtroom testimony), ASK which meaning before saving. Do not assume בית משפט. For בדיחות על עדות without משפט/בית משפט, prefer ethnic communities or ask.",
    "Reminder item is an infinitive: להתאמן, לקנות חלב. Never claim saved unless reminders has add/update with a clock (new) or update of an existing clock (text/time).",
    "Before lists add reminders: only if this turn's active_reminders already has the SAME work by meaning, ASK מצאתי תזכורת קיימת ל«…». לעדכן אותה או להוסיף עוד אחת? Same time or the same every-N cadence alone is never a match (בדיחה על עדות כל שעה ≠ חביתה כל שעה → just add both). Unrelated clocks never trigger that ask. Do not invent that one exists. Empty reminders while asking.",
    "RELATED TO THESE items (קשורות למטלות האלה / לפריטים שמחקנו): answer only active clocks that match those items by meaning. If none, say none. Never list unrelated active clocks. Never invent past deletes or completed history — the system does not load it.",
    "Ask until the reminder schema is complete. Empty reminders while you ask. date empty or YYYY-MM-DD.",
    "RECURRING CLOCK → reminders[].recurrence {freq, interval, unit, weekdays, month_day, month, time, until, count}; leave every_count/every_unit/weekdays empty. freq: interval (every N hours, unit:\"hours\") | daily | weekly (weekdays 0=Sun … 6=Sat) | monthly (month_day) | yearly (month + month_day). Minimum repeat is every hour — HOURLY IS ALLOWED: «כל שעה» / «כל N שעות» (N≥1) → Self-nudge NOW with recurrence {freq:\"interval\",interval:N,unit:\"hours\"}. FORBIDDEN: the minutes/seconds refuse text when they said כל שעה / שעתיים / N hours. Refuse ONLY sub-hour («כל 10 דקות» / «כל חצי שעה» / seconds) → no actions, answer «אי אפשר לקבוע חזרה כל כמה דקות או שניות. הכי תכוף שאפשר הוא כל שעה.» (a one-time «בעוד 10 דקות» is fine). «עד שאקנה» with no calendar end → open-ended hourly (no until). daily/weekly/monthly/yearly need time HH:mm — missing → ask באיזו שעה? with reminders empty. until = inclusive last day YYYY-MM-DD from SESSION_CLOCK calendar (עד סוף החודש → last day of this month; עד דצמבר → Dec 31). count = total sends including the first. A stated start (החל מעוד 10 ימים / החל מ־23.10 / מהשבוע הבא) → YYYY-MM-DD from calendar in reminders[].date (standing task: lists item recurrence.start) — never drop it. Every-N rule (interval > 1) with no start → ask which occurrence is first.",
    "Examples: «תזכירי לי כל שעה לקנות חלב עד שאקנה» → shopping add + לוסי להזכיר + reminders interval 1 hours — save NOW, never refuse. «כל ראשון, שלישי וחמישי ב־8:00 תזכירי לי לקחת כדור» → {freq:\"weekly\",interval:1,weekdays:[0,2,4],time:\"08:00\"}. «כל 1 לחודש ב־9 לשלם ארנונה» → {freq:\"monthly\",interval:1,month_day:1,time:\"09:00\"}. «כל יום ב־20:00 עד סוף החודש» → {freq:\"daily\",interval:1,time:\"20:00\",until:\"<last day of this month>\"}. «כל יום ב־8 תשלחי לי את המטלות שלי» → compose:true, compose_source:\"saved_data\", ping=speaker, text=«מה המטלות שלי היום», recurrence {freq:\"daily\",interval:1,time:\"08:00\"}.",
    "YEARLY OFFER: yearly facts (יום הולדת / נישואין / אזכרה / מנוי שנתי) — offer first; on כן (+ time) birthday of a Known employee is an all-day yearly tasks event + linked reminder (ping=speaker, about=[that person]); FORBIDDEN reminders-only yearly birthday. «גם יום לפני» → event stays on birthday day; ping fires day before. No person → tasks all-day + reminder, about=[].",
    "STANDING TASK WITH TIME — CLOCK OFFER: «אני צריך לקחת סירופ כל 3 ימים ב־12:00» without תזכירי לי → THIS turn lists standing only (no reminders clock), confirm, then OFFER «רוצה שאשלח לך תזכורת בוואטסאפ …?». On כן → lists add reminders same recurrence (or a different ping time they named) + your להזכיר task with שעה לביצוע = standing chore time (not the ping if different); no second speaker standing row; FORBIDDEN lists.update standing time to the ping (APPOINTMENT VS PING). Skip offer if all-day (no recurrence.time) or they already said תזכירי לי / שתזכירו לי (full self-nudge now). Later move of that standing series → STANDING + LINKED CLOCK MOVE ASK (not auto-cascade). Ambiguous cancel after a ping → STANDING + LINKED CLOCK DELETE ASK.",
    "Delete reminder: lists remove reminders with reminder_id from this turn's active_reminders. Server applies immediately — no confirm step. In response say the reminder(s) were deleted (past tense), naming them.",
    "BY LINE NUMBER: after a numbered dump (הצג / show_dump / תיוקים / תזכורות), indices («3» / «ל3» / «את 1» / «הציגי 1» / «מה זה 1») → prefer LAST_NUMBERED_DUMP for that n (copy id+kind; section when present) → ACTION. Else title stem on LAST dump line N → id from THIS turn's live JSON (שם פריט / שם מטלה / item_name / reminder item; strip quantity/marks). Dump shopping/tasks = personal then co-share then assign across shells. FORBIDDEN treating N as JSON array index / creation order when that picks a different title than dump line N. Numbering restarts per header/day/ממתינים/full-dump section — ASK which section if several 1. sequences. After תיוקים dump, line N = that filing; FORBIDDEN show_dump of another list. FORBIDDEN show_dump on any line-index turn. AFTER a dump bare «ל3» is a line index not 03:00. Examples: תמחק את 3 → when uniquely resolved remove NOW with that id (past tense); ambiguous → ASK, delete mutates empty; תשני את 3 → update; הוסף תזכורת ל3 → reminders; תשלחי את 3 ל… → messages.",
    "Delete many list items / מחק את כל המטלות / כל הקניות: when scope is clearly the built-in tasks or shopping shell → emit lists.remove NOW for each speaker-visible item_id in that list_type only. Past tense naming what was deleted. Never lists=[] when matching rows exist this turn. FORBIDDEN wiping custom lists or other people's lists. Unclear shell/title → ASK; delete mutates empty.",
    "WHOLE-LIST DELETE («מחקי רשימ(ה/ות)…» / «כל רשימות המשתתפים» / naming list titles as lists): each explicitly named list with a unique list_id → one lists delete_list NOW per list — never lists.remove. A name with several possible matches, unresolved list, or unclear scope → ASK; lists=[]. Contrast: emptying built-in rows («כל המטלות/הפריטים») → lists.remove per item_id — never wipe unrelated custom lists.",
    "DELETE BY DAY: תמחקי את הפגישה / המטלה ביום חמישי / מחר / ביום X → from this turn's EMPLOYEE_SAVED_DATA tasks whose תאריך לביצוע is that day (SESSION_CLOCK), lists.remove list_type tasks with that row's item_id (never omit) plus the EXACT שם מטלה. Never lists=[] + «לא מצאתי» when such a row is present. Several that day → ASK which (exact titles). Shared twins → every matching item_id. A multi-day row (תאריך לביצוע … תאריך סיום) counts for every day in its span.",
    "RANGES IN ANSWERS: a row with שעת סיום (or a standing occurrence with end_time) shows as «10:00–12:00», never only the start. A multi-day row (תאריך לביצוע … תאריך סיום) matches EVERY day inside its span — «מה יש לי ביום רביעי» lists «בחו\"ל (שלישי–חמישי)». Scan spans before «אין לך…».",
    "MUTATE BY ID: lists/filing/reminders/directory remove|update need item_id / filing_id / reminder_id / contact_id from THIS turn. DELETE WHEN CLEAR (rows): unique target → remove NOW with item_id; responses non-empty past-tense («מחקתי את «title»…»); FORBIDDEN empty responses; FORBIDDEN alter_list/delete_list for a single item (those are only for the whole list); FORBIDDEN same-turn jobs.answer; FORBIDDEN «האם מאשר?» when the target is unique. ASK WHEN UNCLEAR (≥2 candidates / which domain / מחק הכל) → delete mutates empty; one responses entry; FORBIDDEN raise/«אגב». WHOLE-LIST: each explicitly named list with unique list_id → delete_list NOW (one per list); a name with several matches or unresolved → ASK, lists=[]. Update with id applies immediately. Never invent or speak ids.",
    "CLEAR ALL CONTACTS / PHONE BOOK: «תמחקי את כל אנשי הקשר» / «מחק את כל ספר הטלפונים» → ASK first (which domain / confirm wipe); directory=[] lists=[]. If SPEAKER_CONTACTS has rows this turn, FORBIDDEN claiming the book is empty — ask whether they meant ספר הטלפונים (name that contacts exist). Never wipe-all without a clarifying ask.",
    "Speaker still needs → EMPLOYEE_SAVED_DATA lists. Your tasks / your reminder jobs (להזכיר ל…) → WORKER_SAVED_DATA (+ OPEN_JOBS). Ping clocks only → active_reminders. Empty clocks ≠ you have no work. Never emit metadata.query.",
    "WHEN / TODAY / SOON (מה לעשות היום / מחר / יום שלישי / השבוע / בעוד שעתיים / בעוד יומיים): SESSION_CLOCK. אני/שלי → metadata.show_dump=tasks + show_dump_from/to YYYY-MM-DD for that window; lists=[]; server replaces. מה את צריכה ביום X → show_dump=tasks + show_dump_about=YOUR display name + from/to. FORBIDDEN model-written agenda. Do NOT use TEAM_SCHEDULES as the speaker's day plan. Multi-day (השבוע) → from=first to=last day of the window.",
    "LIST ITEM URGENCY: on lists add/update set item urgency = normal | urgent | very_urgent by MEANING (same as messages) — never ask. normal by default; urgent when they stress it (דחוף / בהקדם); very_urgent when hard (ממש דחוף / דחוף מאוד / מיד). Clean title without urgency words. Shopping/tasks/contacts/custom alike.",
    "URGENCY IN RESPONSE: when a saved item has urgency (urgent / very_urgent — normal is omitted from EMPLOYEE_SAVED_DATA), wrap that entire numbered line in guillemets so the whole row is bold. urgent → «1. לשתות מים מחר». very_urgent → the same wrap plus ‼️ after the closing guillemet: «1. לשתות מים מחר» ‼️. 📎 and «(תזכורת: …)» stay inside the wrap. FORBIDDEN: the words דחוף / דחוף מאוד on the line. Never wrap or mark normal/missing. מה יש לי דחוף / מה דחוף → metadata.show_dump=tasks (or full) + show_dump_urgency=urgent; lists=[]; server replaces.",
    "Status / דוח / what someone needs to buy or do / show a list: LIVE DATA ONLY — never resurrect titles from earlier chat after a delete. Bare «מה יש לי» / «הציגי הכל» / סיכום מלא / כל מה ששמור → metadata.show_dump=full; lists=[]; server replaces response (FORBIDDEN model-written overview; shopping COUNTS + tasks detail + phone book). SHAREABLE STATUS ASK / ABOUT X / «הצג רשימת מטלות|קניות»: metadata.show_dump = shopping|tasks|…; one flat dump header + row marks (co-share (A, B); assign (באחריות X · מאת Y)); filings two-section; about X = speaker↔X co-share. Current field values only — never dump שם חדש / update drafts. Bold with single *asterisks* (WhatsApp), never **. Urgency: wrap the whole item line in «…»; very_urgent also appends ‼️ after the closing guillemet. FORBIDDEN to write דחוף / דחוף מאוד on that line. Shared lists: use scope/shared_with. Custom list titles follow LIST NAME MATCH. APPLY FEEDBACK: name object+list after mutates.",
    "Answer in your response from this turn's saved data. The server does not write that answer — except known false delivery / list-type wording fixes. It does not append a mutation summary.",
    "After any save/send/remove, state clearly in response what you did — that text is what the user sees.",
    "If the speaker says they bought or already have a shopping item, remove it from shopping. If they finished a task (הכנתי / סיימתי / עשיתי / הכנתי חביתה), remove it from tasks — look up which list holds it in EMPLOYEE_SAVED_DATA. Never call a tasks item רשימת הקניות.",
    "STANDING TASK DONE: if that task row has חוזר / next_occurrences, «סיימתי / עשיתי / הלכתי» means done for THIS occurrence — never lists.remove (it would delete the whole series and its clock). Emit lists.update list_type tasks with that item_id and occurrence_done = YYYY-MM-DD of the occurrence they did (true = today; «הלכתי אתמול» → yesterday from calendar); nothing else on the item. Response: acknowledge and name the next occurrence AFTER that day from next_occurrences. done_dates on the row = already marked; do not list those occurrences again. lists.remove only on an explicit delete of the standing task («תמחקי את המשימה», «אני כבר לא הולך»). Unclear → ask «לסמן שסיימת להפעם, או למחוק את המשימה הקבועה?» with lists empty. Tasks without חוזר: remove as usual.",
    "STANDING TASK — ONE DATE CHANGED: cancelling or moving a single occurrence («ב־23.10 אני לא צריך לאסוף» / «ב־23.10 לאסוף ב־11:00») → lists.update list_type tasks with that item_id and occurrence_change { date: YYYY-MM-DD (one of next_occurrences), cancel: true } or { date, time: \"HH:mm\" }; nothing else on the item. A linked repeating clock for the same work → same turn lists update reminders with its reminder_id and the same occurrence_change. Never occurrence_done, lists.remove, a recurrence change, or a new one-off task for this. Only that date vs. every week unclear → ask «רק ב־<date> או בכל <weekday>?» with lists empty. Response names the date and that the other occurrences stay.",
    "list_type: shopping = things to buy (לקנות חלב). tasks = work to do (להכין חביתה, לשתות מים, לקחת ילדים). On remove/update, match the list_type of the saved row in EMPLOYEE_SAVED_DATA. response must say מטלות for tasks and קניות for shopping.",
    "PERSONAL TASK DEFAULT: «תוסיפי לי מטלה» / «מטלה ל…» / «לטפל ב…» without naming a custom list → list_type tasks, list_name empty, targets [] (built-in personal מטלות). Detail/פירוט stays on that personal item. FORBIDDEN: dumping it onto a shared custom list like משימות לעבודה just because it exists or sounds work-related — only when they explicitly named that list. Also FORBIDDEN: saving chat/meta/bug commentary as a list row.",
    "NAMED LIST MUTATE: when they name a list (לרשימת X / במשימות לעבודה), add/update/remove on list_type custom + that list_name from EMPLOYEE_SAVED_DATA — personal or shared. Guests still cannot mutate. Do not refuse because shared; do not switch to built-in tasks/shopping.",
    "LIST NAME MATCH (custom / titled lists only): resolve against THIS turn's EMPLOYEE_SAVED_DATA list_name (personal or shared). Built-in קניות/מטלות/אנשי קשר → fixed list_type, list_name \"\" unless they named a custom title. (1) IDENTICAL: exactly ONE list_name equals what they said → mutate NOW, no ask. Spoken token in TWO OR MORE titles (באגים / באגים לקוד / …) → NOT unique — treat as (3). (2) VERY SIMILAR but not identical (exactly one near-miss) → lists=[] and ASK once «התכוונת לרשימת «X»?» — never mutate until confirm. (3) Several close candidates, OR spoken token in ≥2 list_name titles, OR none → lists=[] and ASK which as NUMBERED 1. 2. 3. (exact list_name; personal vs משותפת עם X); never pick first/shared/looks-like. Example: «לאיזו רשימה התכוונת?» then «1. באגים» / «2. באגים לקוד (משותפת עם עמית)». After they answer with the title OR a line index («2» / «ל2») → map to the LAST list-pick ask line → exact list_name from EMPLOYEE_SAVED_DATA. Out-of-range index → re-ask; FORBIDDEN inventing numbers. FORBIDDEN: inventing list_name or picking by topic alone («הוסיפי באג» → a באגים* list). Server will not fix a wrong list_name.",
    "SPEAKER_ADDRESS (this turn's fact block): always conjugate second-person Hebrew to gender male|female. If gender: unknown → ask once «לפנות אליך בלשון זכר או נקבה?» with empty actions; on answer → filing add «לשון פנייה» (item_info זכר/נקבה) — the server stores address gender for next turns. Never ignore SPEAKER_ADDRESS.",
    "Durable personal memory — file with lists add list_type filing in the same turn (do not only say אזכור): לשון פנייה/מגדר, משפחה, כתובת/עיר (street+city without the word כתובת still counts — רחוב שחם פתח תקוה), מצב משפחתי, השכלה, מקצוע, מקום עבודה, pets/school/diet/allergies. SAVE VERB: תייקי/תתייקי → lists add filing only; תוסיפי ל־X / לרשימת X → LIST NAME MATCH on X. תשמרי without list → infer or ASK. TOPIC-ONLY / NO LIST NAMED («הוסיפי באג: …» / «תשמרי את הבאג»): lists=[] — if ≥2 list_names contain באג/באגים → ASK which as NUMBERED 1. 2. 3. candidates (they may reply with the index); else ASK filings/shopping/tasks/named list. FORBIDDEN auto-picking a באגים* list by topic. Do NOT auto-file soft plans. Put detail in item_info (product תיאור); item_description = optional find-helper (מידע לחיפוש) after ANY code/ID/doc/car-number/gate-code/ת.ז/file filing when description empty (bare «מספר הרכב 703…» counts — not only תתייק); never after soft auto-memory (לשון פנייה/משפחה/כתובת…). Find filings by name+info+description. מה התיוקים שלי → explicit saves; מה את זוכרת עלי → memory. Prefer SPEAKER_ADDRESS for address gender.",
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
        text: parsed.responses[0] ?? "",
        actions: Prisma.JsonNull,
        buttons: parsed.buttons ? toJsonValue(parsed.buttons) : Prisma.JsonNull,
        navigateAddress: parsed.navigateAddress ?? null,
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
  responses: string[];
  /** Files the engine sends with this reply (metadata.send_attachments). */
  attachments?: ChatAttachmentRef[];
  /** Final reply buttons (model + engine fallback). */
  buttons?: LlmReplyButton[];
  /** Emoji reaction on the speaker's message (metadata.show_icon). */
  showIcon?: string;
  /** Line map from this turn's show_dump REPLACE (for next-turn BY LINE). */
  lastNumberedDump?: LastNumberedDumpLine[];
}): Promise<ChatTurnMessageIds> {
  const [first = "", ...rest] = input.responses;
  const buttons = input.buttons?.length
    ? toReplyButtons({ buttons: input.buttons })
    : [];
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
      text: first,
      actions: Prisma.JsonNull,
      buttons: buttons.length > 0 ? toJsonValue(buttons) : Prisma.JsonNull,
      ...(input.attachments?.length
        ? { attachments: toJsonValue(input.attachments) }
        : {}),
      ...(dumpLines.length > 0 ? { raw: toJsonValue(nextRaw) } : {}),
    },
  });
  const extra = rest.map((text, index) => ({
    id: randomUUID(),
    conversationId: input.conversationId,
    author: "assistant",
    speaker: input.assistantSpeaker,
    text,
    actions: Prisma.JsonNull,
    buttons: Prisma.JsonNull,
    createdAt: new Date(input.saved.assistantAt.getTime() + index + 1),
  }));
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
 * everyone else it involved — who asked for it and everyone it pings. Reports only
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
        ? `התזכורת «${change.label}» בוטלה על ידי ${actorName}${change.fireAt ? ` (היתה ל-${change.fireAt})` : ""}.`
        : `התזכורת «${change.label}» עודכנה על ידי ${actorName}${change.fireAt ? ` — עכשיו ל-${change.fireAt}` : ""}.`;
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
   * The turn runs and is billed on the worker↔worker conversation; the speaker
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
  /** Validated metadata.send_attachments — the channel sends these after the reply. */
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
  const turnSpeaker = consultFrom ? `${consultFrom} (בשם ${speaker})` : speaker;
  const consultEnvelope = consultFrom
    ? [
        `CONSULT: ${consultFrom} is another digital worker on this team. ${consultFrom} is asking you on behalf of ${speaker}, who is the speaker for permissions and saved data.`,
        `Answer the question fully and directly in response. Your response is passed back to ${consultFrom} and shown to ${speaker} as your answer — write it so ${speaker} can read it as is.`,
        `Do not handoff and do not message ${consultFrom} back. If you lack what you need to answer, say what is missing in response.`,
        `This conversation with ${consultFrom} is shared by everyone ${consultFrom} asks for. Earlier turns may have been on behalf of other people — answer only for ${speaker}, from this turn's data, and never reveal another person's details.`,
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
        "GUEST MODE: The SPEAKER is a WhatsApp guest (אורח) — not you. You are לוסי-אורח.",
        "Never say אני אורחת / אני רק אורחת / I'm a guest. Speak TO them (second person) or use impersonal Hebrew.",
        "Your purpose: help them register as a Workee member (their own account + לוסי). Collect first name, surname, username, password; when all four are known emit metadata.register with those fields. Until then register=null and ask for what is missing.",
        "Also allowed: answer about lists/filings already shared with them in this turn's EMPLOYEE_SAVED_DATA (scope=shared). Show items, say if empty, confirm a named shared list exists.",
        "Forbidden while guest: shopping adds, tasks, reminders, messages, directory, filings mutates, handoff, jokes/weather/market/mashov/places/jewish/routes as the main topic.",
        "Off-topic outside shared lists or registration → guide them back to shared lists or signing up. Empty lists/filing/reminders/messages/directory (register only when complete).",
        "Add/update/delete/buy/remind/send while guest → response: «אפשר רק לצפות ברשימות ששותפו איתך — בלי להוסיף או לשנות. אפשר להירשם כדי לקבל חשבון משלך.» Empty mutate arrays.",
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
          ? "GUEST MODE: shared-list Q&A + registration (metadata.register). Never claim you are the guest. You are לוסי-אורח."
          : "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
        "EMPLOYEE_SAVED_DATA is the speaker's visible saved items. WORKER_SAVED_DATA is YOUR lists and tasks. Do not invent items.",
        "LIVE DATA ONLY (lists / status / clocks / jobs): answer «הצג רשימת…», מה המטלות/הקניות שלי, status dumps, reminders, OPEN_JOBS inventory ONLY from this turn's injected blocks (EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, OPEN_JOBS, active_reminders, SPEAKER_CONTACTS, TEAM_SCHEDULES, SESSION_CLOCK; RECENT_OUTBOUND only for that outbound). Soft-deleted/done rows are never injected — absence means gone. FORBIDDEN: listing titles from earlier assistant/user messages or from your previous «מחקתי…» / «ברשימת המטלות…» reply if they are not in this turn's JSON — including after a delete when they tap הצג. Empty section → one empty sentence; never re-show chat-history-only titles. Exact button commands «הצג רשימת X» / «הצג תזכורות»: lists/reminders empty; the server may replace response with a live dump. EXCEPTION: BY LINE NUMBER — after a numbered dump, spoken indices map dump titles → ids in THIS turn's JSON, then any supported ACTION (תמחק / תשני / הוסף תזכורת / תשלחי את N…); FORBIDDEN show_dump on that turn.",
        guestSpeaker
          ? ""
          : "BY LINE NUMBER: after a numbered dump, «3» / «ל3» / «הציגי 1» / «מה זה 1» → prefer LAST_NUMBERED_DUMP id for that n; else title stem on LAST dump line N → id from this turn → ACTION (filings dump → filing). Shopping/tasks dump order = personal then co-share then assign across shells. FORBIDDEN treating N as JSON array index when that picks a different title. Numbering restarts per section/day — ASK if several 1. sequences. AFTER a dump «ל3» is a line index not 03:00. ASK if ambiguous. FORBIDDEN show_dump on line-index turns.",
        guestSpeaker
          ? ""
          : "SPEAKER_ADDRESS is how to address this speaker (male/female/unknown). Always follow it for second-person Hebrew. filing is durable memory + explicit saves — use family/job silently; address gender prefers SPEAKER_ADDRESS. מה התיוקים שלי → prefer codes/docs/explicit תתיקי; מה את זוכרת עלי → memory rows. Do not claim you lack a fact that appears there.",
        guestSpeaker
          ? ""
          : "SPEAKER_CONTACTS is the speaker's personal phone book. Names there resolve without asking for a number.",
        guestSpeaker
          ? ""
          : "RECENT_OUTBOUND is the latest reminder/scheduled message YOU already sent to this speaker. If they ask about מה ששלחת / הסיכום / ההודעה האחרונה / אפשר להוסיף… about that digest, use that text and talk to THIS speaker. Do not claim you sent nothing when it is listed. Do not resend unless they ask. FORBIDDEN: invent עמית (or any other person) as who to ask/send — example names are not real; only message someone the speaker named this turn. Snooze / תזכיר לי שוב / את זה / בעוד X about that block → NEW self-nudge for this speaker from RECENT_OUTBOUND.item/text (three ACTIONS). Bare «בעוד שעה» right after that outbound = snooze the same item. Do not revive the old done clock — add a new one. Missing delay → ASK מתי?",
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
          : "SHAREABLE STATUS ASK (מה אני צריך לקנות / הציגי רשימות הקנייה / מטלות / תיוקים / הצג רשימת מטלות|קניות|אנשי קשר): pick ONE category. For shopping|tasks|contacts|filings set metadata.show_dump = shopping|tasks|contacts|filings and lists=[] — the server replaces response with the live dump. ABOUT X («מה מיכל צריכה לקנות» / מטלות של טל) → same show_dump + show_dump_about=X. Filings/contacts = two-section share-only (אישיים→משותפים with (עם …); never assign). Bare FULL DUMP («מה יש לי» / הציגי הכל) → show_dump=full (not a category). Shopping lines in any model-written leftover ALWAYS «שם - כמות».",
        guestSpeaker
          ? ""
          : "SHAREABLE STATUS ASK ABOUT X (מה X צריך/צריכה לקנות / מטלות של X / תיוקים של X): metadata.show_dump + show_dump_about=X or [X,Y] for X או Y (union). Optional section/partner/assignee (arrays = OR within field). Server applies visibility (owners see X's lists; others only rows already visible involving X). Empty → engine empty sentence. כל מה ששמור ל־X → show_dump=full (+ show_dump_about=X).",
        guestSpeaker
          ? ""
          : "APPLY FEEDBACK: after saves/removes ALWAYS name the object and list (e.g. «מחקתי את החלב מרשימת הקניות»). FORBIDDEN: bare «בסדר, מחקתי!» / «נמחק». Claim past-tense success ONLY for actions in THIS turn's metadata. MULTI-INTENT CONFIRM: כן after an offer of several mutations → re-emit EVERY offered ACTION this turn, not a subset (incl. every lists delete_list). DELETE CLARIFY follow-up (which item/list/scope) → emit only that resolved delete with ids from THIS turn; unambiguous deletes do not wait for כן. FORBIDDEN same-turn jobs.answer.",
        guestSpeaker
          ? ""
          : `If asked what you still need to do/check, or which tasks / work you have (${WORKER_INVENTORY_ASKS}): INVENTORY → metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED); lists=[]; no reminders clock; buttons=[]. Server replaces with your tasks dump + ממתינים from OPEN_JOBS (omit if empty). FORBIDDEN show_dump=tasks alone (speaker book); FORBIDDEN «אין לי מטלות» / «אין לי כלום» when WORKER_SAVED_DATA / OPEN_JOBS has rows; FORBIDDEN writing inventory lines yourself. Do NOT RAISE. Never emit metadata.query. FORBIDDEN: treating «תזכורות» asks (${SPEAKER_CLOCK_ASKS}) as inventory — those are speaker ping clocks (show_dump=reminders).`,
        "USER-FACING LANGUAGE: echo the speaker's words for any saved thing (תזכורות / מטלות / קניות / תיוק). Never rename their category or explain storage. Never say schema words (sections, clocks, metadata, list_name).",
        "Status / דוח / show a list / «הצג רשימת X» / «הצג תיוקים»: LIVE DATA ONLY. SHAREABLE STATUS ASK shopping|tasks|contacts|filings / ABOUT X / exact «הצג רשימת …» / «הצג תיוקים» → metadata.show_dump (+ show_dump_about for X) + empty lists; server replaces response. SHOW DUMP SECTION: bare → show_dump only; אישית → personal; משותפת → shared; עם X → partner=X; באחריות שלי → assignee=self; באחריות מיכל → assignee=מיכל; date range → show_dump_from + show_dump_to YYYY-MM-DD. OR WITHIN FIELD: X או Y on same dimension → string[] (assignee/partner/about); AND across fields; אישית או משותפת → omit section; FORBIDDEN cross-shape OR — ask or full dump. FORBIDDEN same-as-bare for אישית/משותפת. Bare FULL DUMP («מה יש לי» / הציגי הכל / סיכום מלא / כל מה ששמור) → metadata.show_dump=full; lists=[]; server replaces (FORBIDDEN model-written overview). SAVE VERB: תייקי/תתייקי → lists add filing only; תשמרי without list → infer or ASK; TOPIC-ONLY «הוסיפי באג» → NUMBERED which-list ask if ≥2 באגים* titles (else ask destination); never invent/auto-pick custom list_name from topic. Deletes: unique target+scope → remove/delete_list NOW with ids; unclear → ASK, delete mutates empty. SHARE-ONLY FACTS: filing/contacts/directory co-share; partners may mutate/unshare by id. Contacts alter_list participants OK; shopping/tasks whole-list share refused.",
        `Ping clocks (${SPEAKER_CLOCK_ASKS}) → metadata.show_dump = reminders; lists/reminders/buttons=[]. Server replaces response with the live clocks dump. FORBIDDEN: answering any of these from WORKER_SAVED_DATA / OPEN_JOBS.`,
        "WHEN / TODAY / SOON (מה לעשות היום / מחר / יום שלישי / השבוע / בעוד שעתיים): SESSION_CLOCK. אני/שלי → metadata.show_dump=tasks + show_dump_from/to YYYY-MM-DD; lists=[]; server replaces. מה את צריכה ביום X → show_dump=tasks + show_dump_about=YOUR display name + from/to. FORBIDDEN model-written agenda. Multi-day (השבוע) → from=first to=last of the window.",
        "SHOW MY LISTS / הציגי את הרשימות שלי: metadata.show_dump=\"full\"; lists=[]; no reminders clock; buttons=[]. Same engine as FULL DUMP (server replaces). FORBIDDEN writing the overview yourself. Exact «הצג רשימת X» stays category/custom dump.",
        "FULL DUMP / מה יש לי / הציגי הכל / הצג הכל / מה שמור לי / כל מה ששמור עלי / סיכום מלא: metadata.show_dump = \"full\"; lists=[]; no reminders clock; buttons=[]. Server replaces response with the live flat-list overview (EMPLOYEE_SAVED_DATA + SPEAKER_CONTACTS). FORBIDDEN writing the overview in response yourself. FULL DUMP DETAIL RULE (server): ONLY מטלות enumerate items (1. 2. 3. under one «מטלות:» header; assign «(באחריות X · מאת Y)»; co-share «(A, B)»; LINKED REMINDER on task lines). קניות COUNTS ONLY breakdown under «קניות:» — אישיות / «(A, B)» / «(באחריות X · מאת Y)» (all involved on co-share); רשימות אחרות = «*name* (A, B) — N פריטים» (all involved, e.g. «(מיכל, טל)»; no «עם»). תזכורות פעילות: NUMBERED 1. 2. 3. (never •) for clocks NOT already on a task LINKED REMINDER line. SHAREABLE STATUS ASK / הצג רשימת X stay category dumps. Hint once: לפירוט רשימה: הצג רשימת …. תיוקים (one «תיוקים:» + «(A, B)»); אנשי קשר (one «אנשי קשר:» from EMPLOYEE_SAVED_DATA only — not SPEAKER_CONTACTS); ספר הטלפונים (one «ספר הטלפונים:» from SPEAKER_CONTACTS; co-share «(A, B)»; empty → ריק). FORBIDDEN: skipping ספר הטלפונים when SPEAKER_CONTACTS is non-empty; FORBIDDEN filling ספר הטלפונים from list_type contacts or calling the phone book «אנשי קשר». No schema jargon.",
        "PHONE BOOK ALONE / ספר הטלפונים / הציגי את ספר הטלפונים: metadata.show_dump=\"phone_book\"; lists=[]; server replaces from SPEAKER_CONTACTS. FORBIDDEN model-written phone book; FORBIDDEN confusing with אנשי קשר (contacts list).",
        "Show a named list / הציגי את רשימת X / שיעורי נהיגה של מאיה: enumerate that list's items from EMPLOYEE_SAVED_DATA — one • line per item with the live value only (never «שם + שם חדש» / update drafts). Never reply with only the owner name — owner is whose list it is; the answer is the items. Speak Hebrew only — never list_name / list_type / metadata. items=[] → say the list is empty.",
        "SHARED LISTS: use scope + shared_with from EMPLOYEE_SAVED_DATA. Shared → say משותפת and name shared_with partners; never «של עמית» alone if the speaker is in shared_with. הציגי רשימות משותפות → only scope=shared. scope=shared_items shopping/tasks → status header «קניות/מטלות של <owner>» (FORBIDDEN משותפת עם). Named-list add/update/remove — LIST NAME MATCH (identical-unique → mutate; very similar one → confirm; several / token in ≥2 titles / topic-only «הוסיפי באג» → NUMBERED which-list ask; FORBIDDEN pick by topic). «רשימת קניות משותפת» / כן after that offer → shopping + list_name \"\" (FORBIDDEN custom with list_name קניות / מטלות / אנשי קשר).",
        "מה יש לי עם X / מה יש לי משותף עם X / מה משותף לי ול־X / מה משותף עם X / מה יש לנו עם X / מה אנחנו חולקים עם X: metadata.show_dump=\"full\"; show_dump_section=shared; show_dump_partner=X; lists=[]. Server dump (partner-filtered). FORBIDDEN model-written with-X overview.",
        "Bold in response: single *asterisks* only (WhatsApp). Never **double** asterisks. Item urgency: wrap the whole numbered line in «…» (WhatsApp bolds the whole row). very_urgent also appends ‼️ after the closing guillemet. FORBIDDEN: writing דחוף / דחוף מאוד on the line.",
        guestSpeaker
          ? ""
          : "lists update: put the NEW value under the real column name (שם / שם מטלה / …). Never emit \"שם חדש\" or \"X חדש\" as a separate key.",
        guestSpeaker
          ? ""
          : "Dates in saved items: if a field still says היום/מחר, speak the concrete calendar date (YYYY-MM-DD) when answering. When saving, always emit YYYY-MM-DD, not היום.",
        guestSpeaker
          ? ""
          : "Past deletes / already-fired / מה נמחק / מתי נשלחה / מה שלחנו: say you only have live saved data — do not invent history. Active scheduled sends and clocks → answer from this turn's EMPLOYEE_SAVED_DATA / active_reminders.",
        guestSpeaker
          ? ""
          : "FOLLOW-UP TO YOUR QUESTION: the server keeps no draft — your previous turn in this conversation is the draft. When the speaker answers what you asked (time / hour HH:mm / ב־9 / 21:00, relative date היום/מחר/אתמול, calendar date YYYY-MM-DD or spoken date, weekday / day ראשון / יום רביעי, a duration/until you asked for, phone, name, message body, description, כן, or a pick from options you listed — «1» / «הראשונה» / an exact title), emit the COMPLETE action this turn with every field you already had plus the answer — resolve picks to ids from THIS turn's live facts, never invent or speak ids — never לא הבנתי. If you just asked for a date/day/time/start and they reply with only that kind of short answer (bare מחר / a weekday / a clock), that fills the draft — do NOT treat it as a new WHEN/TODAY / «מה יש לי» query and do NOT ask the same question again. Exception — REMINDER OFFER follow-up: if you already saved a timed speaker row and only asked whether/when to add a WhatsApp ping, their time/כן fills reminders (+ your להזכיר with that speaker row's תאריך/שעה לביצוע copied onto the worker item) only — never overwrite speaker שעה/תאריך לביצוע (APPOINTMENT VS PING). On כן to an offer, emit exactly that offered action (same targets) — if the offer was several mutations (lists remove/update/add, reminders, …), re-emit EVERY one this turn, not a subset. response may claim past-tense success ONLY for actions present in THIS turn's metadata. Cancel (לא / בטל / אל תשלחי / cancel / בעצם לא) → emit nothing for that draft and say you cancelled. If the open ask was a DELETE CLARIFY (which item/list/scope) → cancel ONLY that delete (ack that title); FORBIDDEN binding לא to AFTER ASSIGN / date+reminder / older offers. List/filing/directory deletes: unique target+scope+id → remove/delete_list NOW; unclear which → ASK then FOLLOW-UP with ids from THIS turn. Reminder deletes with reminder_id apply immediately (past tense).",
        guestSpeaker
          ? "If asked what you can do: «אני לוסי-אורח — אפשר לראות רשימות ששותפו איתך, ואפשר להירשם לחשבון Workee משלך.»"
          : "If asked what you can do: FULL catalog — lists (any/custom), share lists/filings, meetings+תיאום, standing tasks, day/week agenda, filings, phone book, messages now/later, checks&nudges, reminders, scheduled digests, handoff. Lead «אני יודעת לנהל כל רשימה». Saved data does not limit that answer. No git digests / schema jargon.",
        "LIVE FACTS (this turn only): Saved state — list/filing/reminder/contact rows, field values, urgency, dates, sharing, clocks, open jobs — comes ONLY from this turn's fact blocks in the user message (EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, RECENT_OUTBOUND, OPEN_JOBS, SESSION_CLOCK, SPEAKER_ADDRESS). Second-person Hebrew gender comes from SPEAKER_ADDRESS (not chat history). Earlier chat turns and your own prior replies are NOT a source for those values. If chat memory conflicts with this turn's JSON, the JSON wins. A field missing from the JSON (e.g. no urgency) means absent/normal — never resurrect it from an older turn. Chat history is only for the speaker's current intent and unfinished drafts (what they just answered), never for «what is saved». Items can also change outside this chat (a reminder fired, someone bought or removed an item, an edit on the site). Examples: (a) you said «אני צריכה להזכיר לך לקנות חלב», then the task is gone from WORKER_SAVED_DATA → «מה את צריכה לעשות» = nothing open; (b) after lists.update sets urgency to normal, a later «הצג מטלות» must NOT wrap that line or append ‼️ even if an earlier turn did.",
        guestSpeaker
          ? ""
          : "Ping clocks only → active_reminders; list NUMBERED 1. 2. 3. (never •). Empty active clocks does not mean you have no reminder jobs — those live in WORKER_SAVED_DATA.",
        guestSpeaker ? "" : ATTACHMENTS_RULE,
        guestSpeaker
          ? ""
          : "LAST CHECK before you answer: every entry in metadata.messages must have all five fields — targets, text, expects_reply, ask_summary, urgency (normal unless the speaker stressed it). expects_reply is true whenever the speaker waits for an answer, an agreement, or an action from that person (שאלה / בדיקה / תיאום / בקשה), false only for pure information. Never emit a messages entry without them.",
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
    // Closed UI button command (opaque equality) → synthesize show_dump if model omitted it.
    // Free-form never maps here — model must emit show_dump. Dump intent is ACTION-only.
    if (!(metadata.showDump?.trim() ?? "")) {
      const buttonText = stripWhatsAppReplyPrefix(input.message);
      let buttonDump = mapShowButtonCommandToDump(buttonText);
      if (!buttonDump) {
        const listsForAllowlist = await getEmployeeRecordSnapshot(
          input.employeeId,
        );
        buttonDump = mapShowButtonCommandToDump(
          buttonText,
          listsForAllowlist,
        );
      }
      if (buttonDump) {
        metadata = {
          ...clearMutatingMetadata(metadata),
          showDump: buttonDump,
        };
      }
    }
    // show_dump: display-only — drop spurious removes; mutates win over accidental show_dump.
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
        ? "אפשר רק לצפות ברשימות ששותפו איתך — בלי להוסיף או לשנות."
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
          registerNotice = `נרשמת בהצלחה כ־${registerResult.displayName}. מעכשיו תדברי עם לוסי בחשבון שלך (שם משתמש: ${registerResult.username}).`;
          recordWhatsAppEvent(
            "guest_register",
            `ok user=${registerResult.newUserId.slice(0, 8)} mirror=${registerResult.mirrorEmployeeId.slice(0, 8)}`,
          );
        } else if (registerResult.reason === "username_taken") {
          registerNotice = "שם המשתמש כבר תפוס — בחרי שם אחר.";
        } else if (registerResult.reason === "invalid_fields") {
          registerNotice =
            "לא הצלחתי לרשום — צריך שם פרטי, שם משפחה, שם משתמש וסיסמה תקינים.";
        } else {
          registerNotice = "לא הצלחתי להשלים את הרישום כרגע. נסי שוב בעוד רגע.";
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
          row.composeSource === "mashov") &&
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
    // Clock cancel soft-deletes the linked worker להזכיר — count it as a list
    // remove so reply correction does not claim «לא מצאתי את הפריט ברשימה».
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
    // itemKey later). Never fuzzy label — that wrote wrong links.
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
      // «תבדקי איתי» — speaker-targeted expects_reply opens a self-job (no relay).
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
          `לא הצלחתי לקבל תשובה מ${workerName} — המשימה נשארת פתוחה אצלי.`,
        );
        continue;
      }
      consultAnswers.push(`${workerName} עונה: ${said}`);
      await withoutFailingTurn("consult_memory_failed", async () => {
        await client.appendAssistantMessage?.(
          conversation.openaiConversationId,
          `${workerName} עונה: ${said}`,
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
    // forwarded relay, so they skip the "מאת X" attribution.
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
        `על איזו משימה?\n${jobResult.askWhich.map((ask) => `• ${ask}`).join("\n")}`,
      );
    }
    // Model often claims mutate success when that kind did not apply — correct.
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
          ? "ביטלתי את המחיקה."
          : metadata.confirm === true
            ? "בוצע."
            : "") ||
        listOpFallback ||
        (appliedListRemove || appliedListUpdate || appliedListAdd
          ? appliedFallback
          : "") ||
        reminderDeleteFallback ||
        (!appliedListOps && requestedListRemove && !appliedListRemove
          ? LIST_FIND_MISS
          : "") ||
        (!appliedListOps && requestedListUpdate && !appliedListUpdate
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
    // Never send an empty WhatsApp/web bubble (e.g. responses:[] + bad list shell ops).
    if (!parseLlmReply(workingReply).response.trim()) {
      workingReply = setEngineResponse(workingReply, EMPTY_REPLY_RETRY);
    }
    // The model already said «שיניתי/מחקתי» — correct it when the engine refused the list op.
    const listOpRefusal = formatListOpRefusals(listOpResults);
    if (listOpRefusal) {
      workingReply = setEngineResponse(
        workingReply,
        [formatListOpFallback(listOpResults), listOpRefusal].filter(Boolean).join("\n"),
      );
    }
    // Do not append apply-summary lines — the spoken reply is the model's response only.
    const noTimeSkipped = reminderResult.skipped.some(
      (row) => row.reason === "no_time",
    );
    if (subHourlyRepeat) {
      workingReply = setEngineResponse(workingReply, SUB_HOURLY_REFUSAL);
    } else if (noTimeSkipped || incompleteComposeClocks.length > 0) {
      workingReply = setEngineResponse(
        workingReply,
        "מתי לשלוח — עכשיו, בעוד X, או בשעה קבועה?",
      );
    }
    // Model / allowlist show_dump (+ section/partner/assignee/about) → live DB dump.
    // Never utterance-parse dump intent — ACTION fields only.
    let turnLastNumberedDump: LastNumberedDumpLine[] = [];
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
      const baseDumpOpts = {
        section: metadata.showDumpSection ?? null,
        partner: metadata.showDumpPartner ?? null,
        assignee: metadata.showDumpAssignee ?? null,
        assigneeSelfNames: speakerAliases,
        dateFrom: metadata.showDumpFrom ?? null,
        dateTo: metadata.showDumpTo ?? null,
        urgency: metadata.showDumpUrgency ?? null,
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
          if (resolved?.kind === "filings") {
            const dumpAddress = navigateAddressFromFilingsDump(
              snapshot.filing ?? [],
              opts,
            );
            if (dumpAddress && !parseLlmReply(workingReply).navigateAddress) {
              workingReply = setEngineNavigateAddress(workingReply, dumpAddress);
            }
          }
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
            // Digital worker lists live on that employee — never filter the speaker's book.
            // Current chat worker → same scope as WORKER_SAVED_DATA for this speaker.
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
              text = emptyListDumpSentence("מטלות", opts);
            }
          }
          if (text) {
            const header =
              aboutNames.length > 1
                ? `*${employeeDisplayName(aboutPerson)}*\n${text}`
                : text;
            blocks.push(header);
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
              ? `לא מצאתי את ${missing[0]}.`
              : `לא מצאתי את ${missing.join(" או ")}.`,
          );
        } else {
          const parts = [...blocks];
          if (missing.length > 0) {
            parts.push(
              missing.length === 1
                ? `לא מצאתי את ${missing[0]}.`
                : `לא מצאתי את ${missing.join(" או ")}.`,
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
    // Live weather ACTION → Open-Meteo fetch; engine replaces response (like show_dump).
    // Guests: weather as main topic stays forbidden — skip even if model emitted it.
    const weatherAction = guestSpeaker ? null : metadata.weather ?? null;
    if (weatherAction?.place.trim()) {
      const weatherText = await resolveWeatherReply({
        place: weatherAction.place,
        date: weatherAction.date,
        aspects: weatherAction.aspects,
      });
      workingReply = setEngineResponse(workingReply, weatherText);
    }
    // Live market ACTION → Yahoo Finance; guests skip (same as weather).
    const marketAction = guestSpeaker ? null : metadata.market ?? null;
    if (marketAction && marketAction.queries.length > 0) {
      const marketText = await resolveMarketReply({
        queries: marketAction.queries,
        aspects: marketAction.aspects,
      });
      workingReply = setEngineResponse(workingReply, marketText);
    }
    // Live Mashov ACTION → login from filings; guests skip.
    const mashovAction = guestSpeaker ? null : metadata.mashov ?? null;
    if (mashovAction) {
      const mashovSnapshot = await getEmployeeRecordSnapshot(input.employeeId);
      const mashovText = await resolveMashovReply({
        filings: mashovSnapshot.filing ?? [],
        child: mashovAction.child,
        aspects: mashovAction.aspects,
      });
      workingReply = setEngineResponse(workingReply, mashovText);
    }
    // Live places ACTION → Google Places; guests skip.
    const placesAction = guestSpeaker ? null : metadata.places ?? null;
    const pendingLoc = guestSpeaker
      ? null
      : getPendingLocation(input.employeeId);
    if (placesAction?.query.trim()) {
      const nearSpeaker = placesAction.near === "speaker";
      const placesText = await resolvePlacesReply({
        query: placesAction.query,
        place: placesAction.place,
        aspects: placesAction.aspects,
        nearSpeaker,
        lat: placesAction.lat ?? pendingLoc?.lat ?? null,
        lng: placesAction.lng ?? pendingLoc?.lng ?? null,
      });
      workingReply = setEngineResponse(workingReply, placesText);
      if (
        nearSpeaker &&
        pendingLoc &&
        !placesText.includes("שלח מיקום")
      ) {
        clearPendingLocation(input.employeeId);
      }
    }
    // Live Jewish / Shabbat ACTION → Hebcal; guests skip.
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
      });
      workingReply = setEngineResponse(workingReply, jewishText);
    }
    // Live routes ACTION → Google Routes TRANSIT / Places stop board; guests skip.
    const routesAction = guestSpeaker ? null : metadata.routes ?? null;
    const routesLinesBoard = Boolean(
      routesAction?.aspects?.includes("lines"),
    );
    if (
      routesAction?.origin.trim() &&
      (routesAction.destination.trim() || routesLinesBoard)
    ) {
      const pin = getPendingLocation(input.employeeId);
      const routesResult = await resolveRoutesReply({
        origin: routesAction.origin,
        destination: routesAction.destination,
        departure: routesAction.departure,
        arrival: routesAction.arrival,
        line: routesAction.line,
        headsign: routesAction.headsign,
        aspects: routesAction.aspects,
        originLat:
          routesAction.origin.toLowerCase() === "speaker"
            ? pin?.lat ?? null
            : null,
        originLng:
          routesAction.origin.toLowerCase() === "speaker"
            ? pin?.lng ?? null
            : null,
      });
      workingReply = setEngineResponse(workingReply, routesResult.text);
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
        !routesResult.text.includes("שלח מיקום")
      ) {
        clearPendingLocation(input.employeeId);
      }
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
    const tipTurn =
      (await withoutFailingTurn("tips_apply_failed", () =>
        resolveAndRecordTipsForTurn({
          userId: input.userId,
          speaker: employee,
          digitalEmployeeId: digital.id,
          appliedOps: tipOps,
          modelTipKeys: metadata.tips ?? [],
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
    let reply = replaceSpoken
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
    const modelButtons = parseLlmReply(reply).buttons ?? [];
    const speakerButtons = guestSpeaker
      ? modelButtons
      : ensureSpeakerShowButtons(metadata, modelButtons);
    if (
      speakerButtons.length > 0 &&
      (speakerButtons.length !== modelButtons.length ||
        speakerButtons.some(
          (button, index) => button.command !== modelButtons[index]?.command,
        ))
    ) {
      reply = setEngineButtons(reply, speakerButtons);
    }
    const outboundAttachments = guestSpeaker
      ? []
      : ((await withoutFailingTurn("attachments_send_failed", () =>
          resolveUsableAttachments(employee.id, metadata.sendAttachments ?? []),
        )) ?? []);
    const finalParsed = parseLlmReply(reply);
    const turnMessageIds = await syncTurnReplies({
      conversationId: conversation.id,
      assistantSpeaker,
      saved: messageIds,
      responses: finalParsed.responses,
      attachments: outboundAttachments.map(toChatAttachmentRef),
      buttons: speakerButtons,
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
