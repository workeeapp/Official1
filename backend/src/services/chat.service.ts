import { randomUUID } from "node:crypto";
import { Prisma, type ChatMessage as ChatMessageRow } from "@prisma/client";
import {
  REPLY_BUTTON_LABEL_MAX,
  digitalEmployees,
  emptyLlmMetadata,
  humanEmployees,
  isDigitalEmployee,
  isGuestEmployee,
  isGuestLucy,
  isProtectedEmployee,
  isSubHourlyRecurrence,
  GUEST_LUCY_NAME,
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
import { getEnv } from "../config/env.js";
import { ValidationError } from "../utils/errors.js";
import { prisma } from "../database/prisma.js";
import {
  isContextTooLargeError,
  isUniqueConstraintError,
  missingTableName,
  ServiceUnavailableError,
} from "../utils/errors.js";
import {
  applyEmployeeRecords,
  summarizeUnshareApply,
  EMPTY_REPLY_RETRY,
  LIST_FIND_MISS,
  formatAppliedMutationFallback,
  EMPLOYEE_SAVED_DATA_RULES,
  formatEmployeeContext,
  formatTeamSchedules,
  getEmployeeRecordSnapshot,
  getTeamSchedules,
  listOverdueTasksForSpeaker,
  listStaleUndatedTasksForSpeaker,
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
import {
  getEmployeeForUser,
  getEmployeeUserId,
  getProtectedLucyIdForUser,
  listEmployeesForUser,
} from "./employee.service.js";
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
  formatScheduleSkippedWithoutQueueNotice,
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
  savedItemNavsFromApplyResult,
  type SavedItemNav,
  showButtonsForNotify,
  type SharedListRef,
} from "./employee-targets.service.js";
import { phonesMatch } from "../utils/phone.js";
import {
  formatSessionClockContext,
  SESSION_CLOCK_RULES,
} from "../utils/relative-date.js";
import { formatSpeakerAddressContext } from "./speaker-address.js";
import {
  answerOpenJobForPair,
  applyJobActions,
  createJobsFromRelays,
  createScheduledJobsFromRelays,
  ensureOverdueTasksJob,
  ensureStaleUndatedTasksJob,
  formatOpenJobsContext,
  formatOpenJobsWaitingDump,
  listOpenJobsForViewer,
  markOverdueJobsOffered,
  markStaleUndatedJobsOffered,
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
  applyNestedReminderPackages,
  applyReminders,
  clocksEligibleForExactKeySoftLink,
  excludeNestedItemsFromSoftLinkCandidates,
  filterTopLevelRemindersAgainstNested,
  formatReminderApplyNotice,
  formatReminderDeleteFallback,
  itemsFromListMutationsForSoftLink,
  linkRemindersByItemId,
  linkRemindersToItems,
  linkRemindersToWorkerTasks,
  listLiveHumanItemsForReminderLink,
  reminderRepeatsSubHourly,
  SUB_HOURLY_REFUSAL,
  unionSoftLinkItemCandidates,
  type ReminderChange,
  type WorkerTaskRef,
} from "./reminder.service.js";
import { isExactKeySoftLinkEnabled } from "./reminder-soft-link.js";
import {
  formatRecentOutboundContext,
  listRecentReminderOutbounds,
} from "./recent-outbound.service.js";
import {
  applyDirectoryActions,
  formatSpeakerContacts,
  getContactBookShare,
  listContactsForEmployee,
  resolveExternalSharePartners,
} from "./contact.service.js";
import { registerGuestMember } from "./guest-register.service.js";
import {
  consumeWhatsAppInvite,
  createWhatsAppInvite,
  findPendingInviteByPhone,
  findPendingInviteForGuest,
  formatPendingInviteContext,
  saveContactReplyButton,
  type PendingInviteContext,
} from "./whatsapp-invite.service.js";
import {
  collectAppliedTipOps,
  formatAvailableTipsContext,
  resolveAndRecordTipsForTurn,
} from "./tips.service.js";
import {
  collectCelebrationRemoves,
  runDeleteCelebration,
} from "./delete-celebration.js";
import {
  appendEngineNotice,
  composeAssistantReply,
  deliverWhatsAppPhones,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
  applyLiveDomainReply,
  replaceSpokenForExecutionOverride,
  sendWhatsAppText,
  setEngineButtons,
  setEngineNavigateAddress,
  setEngineResponse,
  setEngineSpokenBubbles,
  itemOpenButtonLabel,
  setEngineWhatsappComposeUrl,
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
  liveDumpRowIdsFromSnapshot,
  shoppingRowsWithDetail,
  isTasksShowDumpKind,
  dumpFilterNames,
  mapShowButtonCommandToDumpTarget,
  navigateAddressFromFilingsDump,
  navigateAddressFromListDump,
  resolveShowDumpKind,
  restrictListMutatesToLastNumberedDump,
  undatedTasksOfferButton,
  type DumpNumbering,
  type LastNumberedDumpLine,
} from "./show-button-dump.js";
import {
  buildThisTurnVisibleRefs,
  resolveIntentRefs,
  type IntentMiss,
} from "./list-intent-refs.js";
import {
  buildApplyResult,
  captureRequestedFromMetadata,
  collectShowTurnStripDrops,
  type ApplyResult,
  type DumpGuardDrop,
  type ResultIntentMiss,
  type RequestedOp,
} from "./apply-result.js";
import {
  decideReplyFromApplyResult,
  ORDINARY_MUTATION_EMPTY_ACK,
} from "./apply-result-reply.js";
import {
  applySideFailureOverrides,
  sideFailureLines,
} from "./apply-failure-overrides.js";
import { decideEmptySpokenFallback } from "./empty-response-policy.js";
import {
  capturePendingShowDump,
  combineConfirmAndDump,
  restorePendingShowDump,
  withApplyResultDisplay,
  type PendingShowDump,
} from "./apply-result-display.js";
import { resolveWeatherMessages } from "./weather.js";
import { composeWeatherLiveTip } from "./reminder-compose.js";
import { resolveMarketReply } from "./market.js";
import { resolveMashovReply } from "./mashov.js";
import { resolveSmartschoolReply } from "./smartschool.js";
import { resolvePlacesReplyDetailed } from "./places.js";
import {
  resolveJewishReply,
  shouldSkipLiveJewishForCandleReminders,
} from "./jewish.js";
import {
  fillRoutesOdFromBoard,
  formatOpenItineraryFromBoard,
  mapRoutesOpenCommand,
  parseLastRoutesBoard,
  resolveRoutesReply,
  ROUTES_DISRUPTION_UNAVAILABLE_HE,
  ROUTES_NO_SAVED_BOARD_HE,
  ROUTES_OPEN_UNAUTHORIZED_CLARIFY_HE,
  ROUTES_RECALCULATE_NO_CONTEXT_HE,
  type LastRoutesBoard,
} from "./routes.js";
import { resolveFlightsReply } from "./flights.js";
import {
  clearPendingLocation,
  formatPendingLocationContext,
  getPendingLocation,
} from "./pending-location.js";
import {
  buildLastLiveLocation,
  formatLastLiveLocationContext,
  parseLastLiveLocation,
  type LastLiveLocation,
} from "./last-live-location.js";
import {
  fromPendingLocation,
  parseCoordinatePair,
  replyAsksForWhatsAppPin,
  resolveActionLocation,
  shouldClearPendingAfterSpeakerPinUse,
} from "./resolved-location.js";
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
  collectListLevelAttachmentIdsForDump,
  listFilesTapButton,
  withAttachmentRefs,
  type TurnAttachments,
} from "./attachment.service.js";
import {
  builtinListHebrew,
  isBuiltinListType,
  parseItemNavRef,
} from "./builtin-lists.js";
import {
  fillBlankCustomListNameFromSameTurnLinks,
  withLinkedListRefs,
} from "./list-item-list-link.service.js";

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
/** Tombstone: free-written numbered inventory without show_dump → wipe stale map. */
const STORED_LAST_NUMBERED_DUMP_CLEARED = "lastNumberedDumpCleared";
const STORED_LAST_ROUTES_BOARD = "lastRoutesBoard";
const STORED_LAST_LIVE_LOCATION = "lastLiveLocation";

function buildOpenAiRequest(input: {
  conversationId: string;
  message: string;
  liveFacts?: string;
  model: string;
  temperature: number;
  reasoningEffort?: ReasoningEffort;
  instructions: string;
  textFormat?: LlmJsonSchemaFormat;
}): Record<string, unknown> {
  return toResponsesCreateBody(input);
}

/** Exported for the LIVE_FULL production-path runner (seeded dump); unchanged. */
export function packStoredLlmRaw(
  request: unknown,
  response: unknown,
  lastNumberedDump?: LastNumberedDumpLine[],
  lastRoutesBoard?: LastRoutesBoard | null,
  lastNumberedDumpCleared?: boolean,
  lastLiveLocation?: LastLiveLocation | null,
): unknown {
  return {
    [STORED_LLM_REQUEST]: request,
    [STORED_LLM_RESPONSE]: response,
    ...(lastNumberedDump && lastNumberedDump.length > 0
      ? { [STORED_LAST_NUMBERED_DUMP]: lastNumberedDump }
      : {}),
    ...(lastNumberedDumpCleared
      ? { [STORED_LAST_NUMBERED_DUMP_CLEARED]: true }
      : {}),
    ...(lastRoutesBoard
      ? { [STORED_LAST_ROUTES_BOARD]: lastRoutesBoard }
      : {}),
    ...(lastLiveLocation
      ? { [STORED_LAST_LIVE_LOCATION]: lastLiveLocation }
      : {}),
  };
}

function unpackStoredLlmRaw(raw: unknown): {
  request: unknown;
  response: unknown;
  lastNumberedDump: LastNumberedDumpLine[];
  lastNumberedDumpCleared: boolean;
  lastRoutesBoard: LastRoutesBoard | null;
  lastLiveLocation: LastLiveLocation | null;
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
      lastNumberedDumpCleared: packed[STORED_LAST_NUMBERED_DUMP_CLEARED] === true,
      lastRoutesBoard: parseLastRoutesBoard(packed[STORED_LAST_ROUTES_BOARD]),
      lastLiveLocation: parseLastLiveLocation(
        packed[STORED_LAST_LIVE_LOCATION],
      ),
    };
  }
  // Legacy / unpacked response-only raw: still try board / location if present.
  const legacy =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  return {
    request: null,
    response: raw ?? null,
    lastNumberedDump: [],
    lastNumberedDumpCleared: false,
    lastRoutesBoard: legacy
      ? parseLastRoutesBoard(legacy[STORED_LAST_ROUTES_BOARD])
      : null,
    lastLiveLocation: legacy
      ? parseLastLiveLocation(legacy[STORED_LAST_LIVE_LOCATION])
      : null,
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
    const list_name =
      typeof rec.list_name === "string" && rec.list_name.trim()
        ? rec.list_name.trim()
        : typeof rec.listName === "string" && rec.listName.trim()
          ? rec.listName.trim()
          : undefined;
    out.push({
      n,
      id,
      kind,
      title_stem: title_stem || id,
      ...(section ? { section } : {}),
      ...(list_name ? { list_name } : {}),
    });
  }
  return out;
}

async function loadLastNumberedDumpForConversation(
  conversationId: string,
): Promise<LastNumberedDumpLine[]> {
  // Dump map is stored on the first assistant row of a show_dump turn. Later
  // raise/extra rows in the same turn have no raw map — scan newest-first.
  // A cleared tombstone (free-written numbered inventory) stops the scan so a
  // stale shopping map cannot win after a model-written custom-list lookalike.
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { raw: true },
  });
  for (const row of recent) {
    const unpacked = unpackStoredLlmRaw(row.raw);
    if (unpacked.lastNumberedDumpCleared) {
      return [];
    }
    if (unpacked.lastNumberedDump.length > 0) {
      return unpacked.lastNumberedDump;
    }
  }
  return [];
}

/** Test/helper: same rules as the conversation loader over packed raw rows. */
export function pickLastNumberedDumpFromAssistantRaws(
  rawsNewestFirst: unknown[],
): LastNumberedDumpLine[] {
  for (const raw of rawsNewestFirst) {
    const unpacked = unpackStoredLlmRaw(raw);
    if (unpacked.lastNumberedDumpCleared) {
      return [];
    }
    if (unpacked.lastNumberedDump.length > 0) {
      return unpacked.lastNumberedDump;
    }
  }
  return [];
}

/** Test helper: pack request/response + optional dump map / clear tombstone. */
export function packAssistantLlmRawForTests(input: {
  request?: unknown;
  response?: unknown;
  lastNumberedDump?: LastNumberedDumpLine[];
  lastNumberedDumpCleared?: boolean;
  lastRoutesBoard?: LastRoutesBoard | null;
  lastLiveLocation?: LastLiveLocation | null;
}): unknown {
  return packStoredLlmRaw(
    input.request ?? null,
    input.response ?? null,
    input.lastNumberedDump,
    input.lastRoutesBoard ?? null,
    input.lastNumberedDumpCleared === true,
    input.lastLiveLocation ?? null,
  );
}

/**
 * Newest-first scan for a saved trip board. Intervening assistant rows without
 * a board must not hide an earlier board (same pattern as dump loader).
 */
export async function loadLastRoutesBoardForConversation(
  conversationId: string,
): Promise<LastRoutesBoard | null> {
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { raw: true },
  });
  for (const row of recent) {
    const board = unpackStoredLlmRaw(row.raw).lastRoutesBoard;
    if (board) {
      return board;
    }
  }
  return null;
}

/**
 * Newest-first scan for LAST_LIVE_LOCATION. Intervening assistant rows without
 * a location (e.g. reminder ack) must not hide an earlier successful live use.
 */
export async function loadLastLiveLocationForConversation(
  conversationId: string,
): Promise<LastLiveLocation | null> {
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { raw: true },
  });
  for (const row of recent) {
    const loc = unpackStoredLlmRaw(row.raw).lastLiveLocation;
    if (loc) {
      return loc;
    }
  }
  return null;
}

/** Test helper: same newest-first scan over packed raw rows. */
export function pickLastLiveLocationFromAssistantRaws(
  rawsNewestFirst: unknown[],
): LastLiveLocation | null {
  for (const raw of rawsNewestFirst) {
    const loc = unpackStoredLlmRaw(raw).lastLiveLocation;
    if (loc) {
      return loc;
    }
  }
  return null;
}

/** Test helper: same newest-first scan for routes board. */
export function pickLastRoutesBoardFromAssistantRaws(
  rawsNewestFirst: unknown[],
): LastRoutesBoard | null {
  for (const raw of rawsNewestFirst) {
    const board = unpackStoredLlmRaw(raw).lastRoutesBoard;
    if (board) {
      return board;
    }
  }
  return null;
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
    ...(row.whatsappComposeUrl
      ? { whatsappComposeUrl: row.whatsappComposeUrl }
      : {}),
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

/** Protected Lucy (or name/nickname לוסי) — not the guest onboarding worker. */
function isLucyDigital(digital: PublicEmployee): boolean {
  if (digital.kind !== "digital" || isGuestLucy(digital)) {
    return false;
  }
  if (digital.protected) {
    return true;
  }
  const name = (digital.name ?? "").trim();
  const nickname = digital.nickname?.trim() ?? "";
  return name === "לוסי" || nickname === "לוסי";
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
  "ATTACHMENTS: files arrive as new_attachments under «[קבצים שהתקבלו בהודעה זו]» (you also see images); PENDING_ATTACHMENTS = recent unlinked files the speaker sent — context only, never a request (FILE INTENT); saved rows carry attachments; has_attachments is true ONLY when the list itself has files (list_attachment_ids / list attachments) — never because an item inside has files. ATTACH via items[].attachment_ids / filing|reminders attachment_ids / directory add|update attachment_ids (phone-book contact) / lists alter_list add_attachments / lists[].list_attachment_ids. DESTINATION LADDER (full recipe in system DECISION & FOCUS / ATTACHMENTS): תייקי|תשמרי|תצרפי are equivalent save verbs — NOT always filings. (A) filings — only לתיוקים / «תחת…» / «כ…» new title + attachment_ids; (B) list SHELL — alter_list add_attachments ONLY when לרשימה עצמה / ברמת הרשימה; (C) list ITEM — default when «ל־X» uniquely matches a custom list_name or shopping/tasks item: update/add item_id + attachment_ids (identify item from wording / active USER topic / LAST_NUMBERED_DUMP / live rows — FORBIDDEN last-mentioned latch; item unclear → ask which item; never ask list-vs-item); (D) phone-book contact — directory.update contact_id + attachment_ids («לאיש הקשר X» / phone book) — NEVER shopping/tasks/custom item, NEVER assign-only. «ל־X» person → assign ONLY with assign intent; «לאיש הקשר X» → path (D). THIS-TURN DESTINATION WINS: NEW clear destination in THIS USER message beats deferred prior-target complete — FORBIDDEN re-emitting prior row attachment_ids onto the old target. FILE INTENT: a file shows the speaker may want something done — never what, and never permission to do it. Act on a file only when THIS turn's request clearly refers to it, or the speaker is answering your explicit open question about it, or completing their own still-open «אשלח לך…» request (a completed save closes it — a later bare file is NOT for that target). Bare file / forward with no such instruction → ask what to do with it (empty mutates); several possible files or destinations → ask. CORRECTION («זה לא של X» / «הקובץ לא נשמר ל־Y») → move the exact file they mean: detach_attachment_ids on the wrong row + attachment_ids on the right row, ids from the saved rows' attachments in THIS turn's facts — FORBIDDEN substituting a PENDING or any other file. BY LINE attach («תצרפי ל־1-3») → update ×N dump item_ids + same attachment_ids; stale/missing dump → ASK. STABLE REFS: pronouns (לו/אליו) and ordinals (הראשון/השני) → active USER topic + LAST_NUMBERED_DUMP id (+ live match); FORBIDDEN last-mentioned latch alone; unclear → ASK. Document/image filing when create-filing is clear: short item_name + attachment_ids; item_info = optional SHORT summary only; item_description = find-helper only when useful — FORBIDDEN full OCR into item_info/description. Reminder with files → same ids on task and reminder. PAPERCLIP / LINK ICON / send_attachments / DEICTIC SHOW: same as system ATTACHMENTS. Never speak ids; never invent video/document content.";

export async function withAttachmentRefsSafe(
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
  for (const key of ["שם משימה", "name", "task", "item_name"] as const) {
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
  "מה את/ה צריך/ה לעשות / לברר, מה יש לך, מה יש לך לעשות, מה פתוח אצלך, על מה את/ה עובד/ת, המשימות שלך";

/** Speaker ping-clock asks (any «תזכורות» wording, including «שלך») → active_reminders, never WORKER. */
const SPEAKER_CLOCK_ASKS =
  "הצג תזכורות, הציגי את התזכורות שלך, מה התזכורות שלך, איזה תזכורות יש לך, איזה תזכורות פעילות, מתי יש תזכורת";

const STATUS_ADDRESSEE_RULE =
  "WHO A STATUS QUESTION IS ABOUT — read the person the speaker used: second person to YOU (לך / את / אתה / שלך / אצלך — «מה יש לך», «מה פתוח אצלך») = YOUR work → metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED; server dump + ממתינים). show_dump=tasks alone = the SPEAKER's book — FORBIDDEN for second-person inventory. First person (לי / אני / שלי — «מה יש לי») = the speaker's own rows (show_dump without about, or full). A name («מה יש לטל») = that person's rows via show_dump_about. FORBIDDEN free-writing «אין לי משימות» / «אין לי כלום» while WORKER_SAVED_DATA or OPEN_JOBS has a row — emit the dump ACTION.";

/** Shared with eval thin-custom envelope; Chat custom-prompt branch uses the same text. */
export const RESPONSES_RULE =
  "OUTPUT: your spoken reply is the top-level \"responses\" array (not a single \"response\" string). Each entry is an object {text, buttons?, navigate_address?} sent as its own message, in order. Put tap buttons and Waze on the bubble they belong to (POST-MUTATE SHOW / LIST/collab nav on confirm; כן/לא on the soft-reminder offer; navigate_address on the address line). After applied list/filing mutate YOU emit the matching LIST / collab nav on the confirm bubble (engine validates vs apply; may add one plain LIST safety-net if you omitted it; never invents collab). FORBIDDEN list/collab nav on soft-offer כן/לא or tips. After add|update, when the title uniquely opens that row → you MAY emit an item-show button ONLY for tasks|filing (reliable open commands); shopping/contacts/custom → no item-open from you. ITEM DUMP: show specific row(s) → show_dump + show_dump_ids (server replaces; FORBIDDEN writing the body; empty/mismatch ids → no-match, never full list). After remove → engine list nav only. New tasks add WITHOUT explicit «תזכירי לי» → TWO responses entries (confirm with optional item-open; engine adds list nav; then soft reminder offer with כן/לא). New tasks add WITH explicit reminder schedule same turn → ONE confirm (task+reminder under APPLY FEEDBACK) + optional item-open; FORBIDDEN soft-offer כן/לא. Usually one entry otherwise; use several only for independent messages (e.g. the answer, then a raise of an open job). Wherever these instructions say \"response\", they mean these entries' text. After an item MOVE (lists.remove + lists.add) → engine dest list-show only (never source+dest). metadata.show_icon (one emoji or null) attaches to the speaker's message and is sent/shown before spoken replies.";

const OPEN_JOBS_RULES = [
  "OPEN JOBS — expects_reply IS MANDATORY (critical): every message you send to another human for the speaker where the speaker is waiting for something back MUST carry expects_reply:true and ask_summary. That covers a question (מה שלומך / אם קנית חלב), a check (תבדקי עם ערן…), AND a request to do or arrange something (תתאמי פגישה עם ערן / תבקשי מערן לשלוח את הקובץ / תגידי לערן שיאשר). If the other person has to answer, agree, or act — expects_reply:true. Use false ONLY for pure information with nothing coming back (בוקר טוב / המערכת למעלה / תודה).",
  "SELF-CHECK («תבדקי איתי…» / check with me): when the speaker asks YOU to check with THEM (תבדקי איתי אם קניתי שוקו / check with me if I bought…), emit messages targeting the SPEAKER with expects_reply:true + ask_summary + urgency, lists:[]. text, ask_summary, and response MUST address the speaker in second person — convert their first person (קניתי / הכנתי / עשיתי) to second (קנית / הכנת / עשית). Example: עמית אומר «תבדקי איתי אם קניתי שוקו» → messages: [{ \"targets\": [\"עמית\"], \"text\": \"קנית שוקו?\", \"expects_reply\": true, \"ask_summary\": \"אם קנית שוקו?\", \"urgency\": \"normal\" }], lists: [], response: a short acknowledgement + the question NOW, in second person. FORBIDDEN when asker===subject: keeping first person in those fields, «<name> מחכה לתשובה», or third-party framing. «תבדקי איתי דחוף…» / «ממש דחוף» → same shape with urgency urgent / very_urgent; response notes the urgency like any other job. The server opens a self-job on you (לבדוק עם עמית: …) — never lists.add it. Do NOT claim you relayed a message to someone else; the ask lives in response. Urgency follow-ups run like any other OPEN_JOB. Later turns: OPEN_JOBS shows viewer_is=subject — raise/answer like any other job. On answer leave report_text empty (no third party). Never say «עמית ביקש ממני…» when asker===subject — a later raise is a separate entry that presents it as their own check, in second person.",
  "DEFERRED CHECK (תבדקי/תבררי … בעוד X / מחר ב־… / כל יום שני / כל 1 לחודש): same expects_reply messages entry PLUS in (seconds) OR date+time OR recurrence (same shape as reminders[].recurrence). lists:[]. response = when + EXACT OUTBOUND QUOTE of messages.text («אבדוק עם טל מחר ב־20:00 את ההודעה «עמית שואל אם אתה מקליט את המשחק?»») — do NOT ask or WhatsApp now; do NOT emit list_type reminders for this (the server schedules your לבדוק task with תאריך/שעה + clock). At fire the server clears the dates, sends the ask, and urgency follow-ups run like any open job. OPEN_JOBS may list scheduled=true / raisable=false until then — wait, do not raise early. Immediate check (no future clock on the messages entry) stays ask-now. URGENCY FOLLOW-UP after a deferred check: bare «דחוף» / «זה דחוף» / «ממש דחוף» → escalate that ONE job (URGENCY FOLLOW-UP) — never a second deferred check or lists add reminders.",
  "ask_summary = what the speaker wants from them, in the speaker's own words, WITHOUT the recipient's name: «לתאם פגישת עבודה ליום שלישי» / «אם קנית חלב?» — not «לתאם פגישה עם ערן».",
  URGENCY_RULE,
  "Example: עמית אומר «תתאמי פגישת עבודה עם ערן ליום שלישי בשעה 10» → messages: [{ \"targets\": [\"ערן\"], \"text\": \"עמית מבקש לתאם איתך פגישת עבודה ביום שלישי ב-10:00. מתאים לך שעה זו כדי שאקבע?\", \"expects_reply\": true, \"ask_summary\": \"לתאם פגישת עבודה ביום שלישי ב-10:00\", \"urgency\": \"normal\", \"book\": { \"title\": \"פגישת עבודה\", \"date\": \"<that Tuesday YYYY-MM-DD>\", \"time\": \"10:00\" } }], lists: []. The text states the slot AND ends with a yes/no question (מתאים לך…? / נוח לך שעה זו?). A statement alone is not enough. The server opens the job task on you — never add a lists task for it yourself. This is the only exception to «a tell/send never becomes a task» besides scheduled sends.",
  "book (on that messages entry): set it whenever the ask is to set up something the two of them will do together at a slot — פגישה, שיחה, שיחת עדכון, זום, ארוחה. title = the speaker's own words for it (שיחת עדכון), date = YYYY-MM-DD from SESSION_CLOCK, time = HH:mm. On a yes the server saves that item on BOTH people's tasks. Omit book for a plain question or a request that is not a shared slot (מה שלומך / תשלח את הקובץ).",
  "MEETING SLOT FIRST: תתאמי פגישה עם X needs a date+time (or all-day) BEFORE you message X. Speaker omitted them → ask the speaker in response, messages=[], lists=[]. Never ping X with «באיזה תאריך ושעה נוח לך?» while you still lack the slot, and never ask X for a time the speaker already gave. Follow-up «מחר ב-10» when no job is open yet → now message X WITH that slot (expects_reply true, ask_summary includes מחר ב-10:00). A new different request to the same person (תבדקי מה שלומו while a meeting job is already open) is another job — expects_reply + ask_summary, do not emit jobs.progress on the old row. Updating the SAME open job (new slot for that meeting) → jobs.progress on that job_id AND the update message; the server keeps that one row.",
  "OPEN_JOBS (injected when present) lists the jobs you still owe for THIS speaker: job_id, asker, subject, ask, task, viewer_is, state, raisable. Only those exist — never invent one. Several rows can be open at once. EVERY metadata.jobs entry MUST copy job_id from OPEN_JOBS — never omit it (missing job_id when several jobs are owed makes the server ask «על איזו משימה?» and drop the action, including counter). Two possible rows → ASK which OPEN_JOBS ask briefly, then on their pick emit the jobs action WITH that job_id. If OPEN_JOBS has rows you DO have work: say so even when WORKER_SAVED_DATA is empty; FORBIDDEN «אין לי משימות» / «אין לי כלום» — inventory → show_dump=tasks + show_dump_about=YOUR display name (both REQUIRED).",
  "PHRASING per viewer: when OPEN_JOBS is present, its header says how THIS speaker hears each job (viewer_is subject / asker / self-job) — never read a «לבדוק עם X: …» task label out loud as-is.",
  "ANSWER: a short reply from the subject (כן / לא / הכל בסדר תודה / תגידי לו ש…) answers the job whose ask it matches → metadata.jobs [{ action:\"answer\", job_id, answer_text: their words, report_text: your sentence for the asker }]. «לו / לה / להם» = that job's asker; «זה / על זה» = that job's ask. Two possible jobs → ASK which. Do NOT emit messages for the report — the server delivers report_text. report_text speaks about the subject in third person and quotes the ask, e.g. «ערן מוסר הכל בסדר, תודה — בקשר לשאלה שביקשת ממני לשאול אותו «מה שלומך?»». report_text is NEVER for the current speaker: if you are talking to the asker, leave it empty and use messages to reach the subject. If you are talking to the subject, report_text goes to the asker. Self-job answer → report_text empty; ack in response only.",
  "ANSWER BEATS DICTATED SEND (critical): when OPEN_JOBS has a matching subject job (viewer_is=subject / the raised check they are answering) and they say «תגידי שכן» / «תגידי לו/לה ש…» / «תמסרי ל־X ש…» / «תגידי למיכל שכן» meaning close that check — emit ONLY jobs.answer (+ report_text). FORBIDDEN treating it as DICTATED SEND / messages to the asker with body «כן» (that leaves the job open). Bare «כן»/«לא» after a raise = answer that job. Dictated send («תגידי לטל לקנות…») stays messages ONLY when no matching open check applies.",
  "WHO HEARS WHAT: response is only for the person in front of you. After you message someone else, response confirms to the asker with EXACT OUTBOUND QUOTE — «שלחתי לערן את ההודעה «עמית שואל אם קנית חלב?»» (character-for-character messages.text / reminders.text). FORBIDDEN: making the whole response the recipient-facing line alone (not bare «ערן, עמית שואל…» as the only content). REQUIRED: include that exact text inside את ההודעה «…». After the subject answers, response to THEM is only a short acknowledgement that the asker will be updated. The report sentence exists only in report_text; never copy it into response.",
  "COUNTER: the subject names a DIFFERENT slot than the one in ask (מתאים לי 15:00 / נזיז ל־21:00 instead of 11:00) → SAME TURN metadata.jobs [{ action:\"counter\", job_id from OPEN_JOBS, answer_text: the new slot in their words, date: YYYY-MM-DD from SESSION_CLOCK, time: \"21:00\", report_text: «טל רוצה לשנות את מועד הפגישה ליום רביעי בשעה 21:00. האם לאשר?» }], messages=[], lists=[]. job_id + date + time are required. If exactly one open schedule/coordinate job fits (לתאם / לקבוע), counter immediately — do not ask «על איזו משימה?» or list unrelated chores. If you already asked «הפגישה עם עמית?» and they say כן, emit that full counter with the previously spoken new slot AND that job_id — כן is not jobs.answer approving the old time. The server keeps ONE job, flips who must answer, and delivers report_text. Do not book yet. כן / מאשר / אוקיי on a book_on_yes job → answer AND lists add the meeting (תאריך לביצוע=book_date, שעה לביצוע=book_time, שעת סיום=book_end_time when present, targets=both people). «לא כרגע» is snooze, not counter. A full refusal → decline.",
  "RANGE BOOKINGS: OPEN_JOBS book_end_time = the end of the asked slot; book_window=true = the range is a window to pick a time in, false/absent = the meeting's own length. Agree to the whole slot on a duration booking → answer, and the meeting adds שעת סיום=book_end_time. Subject names one time («מתאים ב־11:00») inside a window, or different from book_time → COUNTER with time \"11:00\"; end_time only if they said an end, or a duration booking moved as a whole (keep its length: 10:00–12:00 → 11:00–13:00); otherwise end_time empty. Example: ask «לתאם פגישה ליום רביעי בין 10:00 ל־12:00», טל «מתאים ב־11:00» → jobs [{action:\"counter\", job_id, answer_text:\"מתאים ב־11:00\", date:<Wed>, time:\"11:00\", end_time:\"\", report_text:\"טל מציע ביום רביעי ב־11:00. לאשר?\"}]; the asker's כן → answer + the meeting at 11:00 on both.",
  "BOOK A MEETING when the job's ask is to schedule/coordinate anything shared at a slot (לתאם פגישה / שיחה / שיחת עדכון / לקבוע) AND the subject agrees (אוקיי תתאמי / כן אני פנוי / קבע): SAME TURN emit jobs.answer as above AND lists add list_type=tasks, targets=[asker name, subject name] (never YOU / לוסי), one item = the meeting itself — שם משימה MUST include all participants in parentheses matching targets (e.g. פגישה נוספת בנושא פורים (עמית, טל) or פגישת עבודה (עמית, ערן) — not לבדוק עם… and not a topic-only title). תאריך לביצוע = YYYY-MM-DD from SESSION_CLOCK for that weekday, שעה לביצוע = HH:mm when a time was named, יום שלם=false. Do NOT offer a shared save; they already agreed. messages=[]. Example: ערן «אוקיי תתאמי את הפגישה» on ask «לתאם פגישת עבודה ליום שלישי בשעה 10» → jobs:[{action:\"answer\", job_id, answer_text:\"אוקיי תתאמי את הפגישה\", report_text:\"ערן אישר — קבעתי פגישת עבודה ליום שלישי ב-10:00\"}], lists:[{action:\"add\", list_type:\"tasks\", targets:[\"עמית\",\"ערן\"], items:[{ \"שם משימה\":\"פגישת עבודה (עמית, ערן)\", \"תאריך לביצוע\":\"<that Tuesday YYYY-MM-DD>\", \"שעה לביצוע\":\"10:00\", \"יום שלם\":false }]}]. Time or all-day not agreed yet → jobs progress, ask the hour, lists=[]. A check/question job (מה שלומך / אם קנית חלב) stays answer-only — no lists.",
  "DECLINE (לא אספיק / לא רלוונטי) → action decline + report_text, job closes. «לא כרגע» / «אחר כך» with no hour is NOT a decline.",
  "PROGRESS (אתאם איתו מחר / לא כרגע with no hour) → action progress or snooze with no time. report_text empty. The asker is not told. The job stays open and stays raisable. A different clock time is COUNTER only — never progress.",
  `RAISING (mandatory when raisable=true and viewer_is=subject): after you answer what they just asked, raise one such job. Also raise it when they open (היי / מה נשמע) or switch to a new topic. A raise is ALWAYS its own entry in responses — never inside the answer entry. The answer entry is written as if no job were open (a greeting gets a normal greeting back); a normal raise is the NEXT entry, in your own words — a natural shift to the open job. Example shape: עמית «הי» with a raisable self-check «אם קנית חלב?» → responses: [<a greeting back>, <the self-check asked as their own check>]. A meeting raise entry is the question: it states who asked and the proposed slot and asks yes/no whether to book it. Do not stop at «אני צריכה לתאם איתך». Skip the raise while your own question is still unanswered — including an open DELETE CLARIFY (which item/list/scope to delete): that turn is ONE responses entry only; FORBIDDEN a second raise entry or any other yes/no in the same turn; the job stays raisable for a later turn after they answer. Also skip in the same reply where they just said לא כרגע. FORBIDDEN to RAISE when they ask what YOU need to do/check/list (${WORKER_INVENTORY_ASKS}) — that is INVENTORY only (see below). raisable=false (a clock is set, or scheduled=true deferred check not yet due) → wait, do not raise early. A row with urgency=urgent → the raise entry comes FIRST in responses, before the answer entry, and states the urgency up front (not as a by-the-way aside) — still FORBIDDEN in the same turn as an open DELETE CLARIFY. urgency=very_urgent → that first raise entry appears in EVERY reply while it is open, even right after לא כרגע (one short line) — except during an open DELETE CLARIFY.`,
  "OVERDUE TASKS (overdue_tasks=true on an OPEN_JOBS row): the server opened this self-job on a new conversation for speaker tasks whose last day passed. Raise ONLY when raisable=true (first offer this conversation) with varied Hebrew + buttons סגירה / עדכן מועד להיום (and הצג את המשימות when raise omits some overdue_titles). On «סגירה» → jobs.answer (report_text \"\") + lists.remove per overdue_item_ids. On «עדכן מועד להיום» → jobs.answer + lists.update תאריך לביצוע=\"היום\". On «הצג את המשימות» → show_dump=tasks + show_dump_ids=overdue_item_ids; lists=[]; jobs=[]; do NOT close. If overdue_offered / raisable=false → FORBIDDEN raise or re-ask; still accept those commands if they volunteer. FORBIDDEN opening another overdue job via messages; FORBIDDEN inventing item ids; still skip raise during DELETE CLARIFY / inventory.",
  "STALE UNDATED (stale_undated=true): undated speaker tasks at a 7/14/28/56… day milestone (only when no overdue_tasks). Raise ONLY when raisable=true with varied Hebrew (title + age); buttons סגירה + להוסיף תאריך; when stale_item_ids.length>1 ALSO הצג משימות (label=command). On «סגירה» → jobs.answer + lists.remove per ids. On «להוסיף תאריך» → ask for date(s) first (jobs.progress OK); when they give a date → lists.update תאריך לביצוע + jobs.answer. On «הצג משימות» → show_dump=tasks + show_dump_ids=stale_item_ids; do NOT close. If stale_offered / raisable=false → FORBIDDEN raise or re-ask; still accept those commands if they volunteer.",
  "SNOOZE: «תזכירי לי בעוד 10 דקות» / «בערב» about a raised OPEN_JOBS raise → ONLY metadata.jobs [{ action:\"snooze\", job_id, in: seconds }] or time HH:mm. The server moves that job's nudge clock (or creates one if none) — FORBIDDEN lists add reminders / lists three-action self-nudge / a second להזכיר for that job. «לא כרגע» / «אחר כך» with no time → snooze with no time (deferred, still raisable); asker not told. Vague hour → ask.",
  "CANCEL / STOP THE CHECK: «אל תשאלי יותר» / «תפסיקי» / «תבטלי את זה» / «תשכחי מזה» on a raised OPEN_JOBS row → jobs.close or decline with job_id + report_text (ends chat raises AND the nudge clock). response: a short acknowledgement that it is cancelled and the asker will be updated. No regret turn, no «זה דחוף בטוח?». FORBIDDEN lists remove reminders or clear_clock alone when they mean stop the whole check. «בטלי את התזכורת» only (clearly the WhatsApp ping, not the check) → clear_clock: asker closes the job + subject is told; subject only drops the clock and the job stays (asker not told). Silent full-cancel does not exist: «בטל אבל אל תגיד לו» → do NOT close yet; explain ending the check always updates the asker; ask cancel+notify or leave open. A report you deliver is the end of that job — never set expects_reply on it.",
  "CONSULT FOLLOW-UP: a «<worker> עונה: …» line in your earlier reply is a digital co-worker's answer, already shown to the speaker. If that worker asked for missing details (כמה אנשים / לאן בדיוק / מתי) and the speaker now gives them (3 אנשים / למנצ'סטר), pass them to that worker: messages to that worker, expects_reply:true, text restates the original topic plus the new details («לגבי טיסה ללונדון ביום שלישי: נוסעים 3 אנשים»), ask_summary with the full topic. Never answer it yourself, never «לא הבנתי», and never ask the speaker what the details are for.",
  `INVENTORY (${WORKER_INVENTORY_ASKS}): metadata.show_dump=tasks + show_dump_about=YOUR display name (nickname or name as Known employees know you) — BOTH REQUIRED every inventory turn; lists=[]; no reminders clock; buttons=[]. Same as «משימות של X» — server replaces with YOUR tasks dump (WORKER scope) + ממתינים from OPEN_JOBS (omit if empty; job shadows stripped from משימות). show_dump=tasks WITHOUT about = SPEAKER's tasks (WRONG for «מה יש לך»). FORBIDDEN: omitting show_dump_about; free-writing «אין לי משימות» / «אין לי כלום» while WORKER_SAVED_DATA or OPEN_JOBS has rows; writing inventory item lines yourself; RAISE that reply; saying job / job_id / expects_reply / OPEN_JOBS in response.`,
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
    input.worker.protected || workerName.includes("לוסי");
  return [
    `Current speaker: ${input.speaker}. You are ${workerName}.`,
    `Known employees: ${names}.`,
    "Follow ONLY your system instructions above for persona and capabilities. Do not invent Lucy's (or any other worker's) catalog if it is not in your prompt.",
    "EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, OPEN_JOBS, active_reminders, and RECENT_OUTBOUND in this turn's user message are facts — do not invent missing ones.",
    "LIVE DATA ONLY: list/status/clock/job answers use ONLY those injected blocks this turn. FORBIDDEN: naming items from earlier chat («מחקתי…» / prior «ברשימת המשימות…») if they are absent from this turn's JSON. Empty → one empty sentence.",
    input.speakerIsOwner
      ? "This speaker is the account owner and may see every human's live saved data in EMPLOYEE_SAVED_DATA."
      : "This speaker is not the account owner — answer only from their own live saved data (plus shared items visible to them).",
    feminine
      ? "First-person Hebrew is feminine only: מעבירה, מוסיפה, שומרת, שואלת."
      : "First-person Hebrew is masculine: מעביר, מוסיף, שומר, שואל.",
    "BY LINE NUMBER (canonical in system prompt): after a numbered dump, «3» / «תמחק את 3» / «שתף 1,2…» → LAST_NUMBERED_DUMP id or dump-line title stem → ACTION; FORBIDDEN JSON array index vs dump line; FORBIDDEN show_dump on line-index turns; ASK if several 1. sequences.",
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
/**
 * The complete instruction string sent to the model for one turn — the single
 * implementation shared by sendChatMessage and every evaluation runner, so an
 * eval can never score a different prompt than production sends.
 * (Extracted verbatim from sendChatMessage; Q1 parity.)
 */
/**
 * How to read this turn's fact blocks — fixed text, sent once in the
 * instructions (cached) instead of inside every facts block (Stage 2).
 */
const FACTS_RULES = [
  "FACTS RULES — how to read this turn's fact blocks (they carry data only):",
  "SESSION_CLOCK:",
  ...SESSION_CLOCK_RULES,
  "EMPLOYEE_SAVED_DATA / WORKER_SAVED_DATA:",
  ...EMPLOYEE_SAVED_DATA_RULES,
].join("\n");

export function buildLucyInstructions(input: {
  digital: PublicEmployee;
  employees: PublicEmployee[];
  speaker: string;
  speakerIsOwner: boolean;
  guestSpeaker: boolean;
  pendingInvite: PendingInviteContext | null;
  /** Consulting digital worker's name ("" when this is not a consult turn). */
  consultFrom: string;
}): string {
  const {
    digital,
    employees,
    speaker,
    speakerIsOwner,
    guestSpeaker,
    pendingInvite,
    consultFrom,
  } = input;
  const config = llmConfigForDigital(digital);
  const consultEnvelope = consultFrom
    ? [
        `CONSULT: ${consultFrom} is another digital worker on this team. ${consultFrom} is asking you on behalf of ${speaker}, who is the speaker for permissions and saved data.`,
        `Answer the question fully and directly in response. Your response is passed back to ${consultFrom} and shown to ${speaker} as your answer — write it so ${speaker} can read it as is.`,
        `Do not handoff and do not message ${consultFrom} back. If you lack what you need to answer, say what is missing in response.`,
        `This conversation with ${consultFrom} is shared by everyone ${consultFrom} asks for. Earlier turns may have been on behalf of other people — answer only for ${speaker}, from this turn's data, and never reveal another person's details.`,
      ].join("\n")
    : "";
  const attachLucyEngine = shouldAttachLucyRuntimeEngine(
    digital,
    employees,
    loadLlmConfig().systemMessage,
  );
  const guestModeInstructions = guestSpeaker
    ? [
        "GUEST MODE: The SPEAKER is a WhatsApp guest (אורח) — not you. You are לוסי-אורח.",
        "Never say אני אורח / אני רק אורח / I'm a guest. Speak TO them (second person) or use impersonal Hebrew.",
        pendingInvite
          ? [
              "PENDING_INVITE is active this turn.",
              `First message: tell them ${pendingInvite.askerName} wants to know: ${pendingInvite.askSummary}.`,
              "Then require registration before continuing that check: collect ONLY (1) first name (2) gender (זכר→male / נקבה→female). Surname optional if volunteered.",
              "FORBIDDEN until metadata.register succeeds: answering the ask substance, messaging the asker, or claiming the check is done.",
            ].join(" ")
          : "Your purpose: help them register as a Workee team member (then they talk with לוסי). Collect ONLY: (1) first name, (2) gender (זכר→male / נקבה→female). Surname optional if they volunteer it.",
        "FORBIDDEN: username, password, email, phone, login. If this chat earlier asked for username/password → stop; continue with name+gender only. When name+gender known emit metadata.register {name, gender} (+ surname if given); until then register=null and ask only for what is missing.",
        "Also allowed: answer about lists/filings already shared with them in this turn's EMPLOYEE_SAVED_DATA (scope=shared). Show items, say if empty, confirm a named shared list exists.",
        "Forbidden while guest: shopping adds, tasks, reminders, messages, directory, filings mutates, handoff, jokes/weather/market/mashov/smartschool/places/jewish/routes as the main topic.",
        "Off-topic outside shared lists or registration → guide them back to shared lists or signing up. Empty lists/filing/reminders/messages/directory (register only when complete).",
        "Add/update/delete/buy/remind/send while guest → say they can only view shared lists until they register. Empty mutate arrays.",
        "lists/filing/reminders/directory/messages/handoff must always stay []. Do not invent private data.",
      ].join("\n")
    : "";
  return attachLucyEngine
    ? [
        config.systemMessage,
        RESPONSES_RULE,
        FACTS_RULES,
        `The user is chatting as ${speaker}.`,
        guestModeInstructions ||
          workerTargetingInstructions(employees, speaker, digital),
        guestSpeaker ? "" : OPEN_JOBS_RULES,
        consultEnvelope,
        guestSpeaker
          ? "GUEST MODE: shared-list Q&A + registration (metadata.register). Never claim you are the guest. You are לוסי-אורח."
          : "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
        "EMPLOYEE_SAVED_DATA is the speaker's visible saved items. WORKER_SAVED_DATA is YOUR lists and tasks. Do not invent items.",
        "LIVE DATA ONLY (lists / status / clocks / jobs): answer «הצג רשימת…», מה המשימות/הקניות שלי, status dumps, reminders, OPEN_JOBS inventory ONLY from this turn's injected blocks (EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, OPEN_JOBS, active_reminders, SPEAKER_CONTACTS, TEAM_SCHEDULES, SESSION_CLOCK; RECENT_OUTBOUND only for that outbound). Soft-deleted/done rows are never injected — absence means gone. FORBIDDEN: listing titles from earlier assistant/user messages or from your previous «מחקתי…» / «ברשימת המשימות…» reply if they are not in this turn's JSON — including after a delete when they tap הצג. Empty section → one empty sentence; never re-show chat-history-only titles. Exact button commands «הצג רשימת X» / «הצג תזכורות»: lists/reminders empty; the server may replace response with a live dump. EXCEPTION: BY LINE NUMBER — after a numbered dump, spoken indices map dump titles → ids in THIS turn's JSON, then any supported ACTION (תמחק / תשני / הוסף תזכורת / תשלחי את N…); FORBIDDEN show_dump on that turn.",
        guestSpeaker
          ? ""
          : "BY LINE NUMBER: follow system BY LINE NUMBER / DECISION & FOCUS — LAST_NUMBERED_DUMP or dump-line stem → ACTION; filings dump → filing; share-by-index → update + dump ids + targets:[speaker, partner]; FORBIDDEN «שיתפתי» without those updates; FORBIDDEN JSON array index vs dump title; FORBIDDEN show_dump on line-index turns; AFTER a dump «ל3» is a line index not 03:00.",
        guestSpeaker
          ? ""
          : "SPEAKER_ADDRESS is how to address this speaker (male/female/unknown). Always follow it for second-person Hebrew. filing is durable memory + explicit saves — use family/job when it genuinely makes a reply more relevant (VOICE), never forced or recited; address gender prefers SPEAKER_ADDRESS. מה התיוקים שלי → prefer codes/docs/explicit תתיקי; מה את זוכרת עלי → memory rows. Do not claim you lack a fact that appears there.",
        guestSpeaker
          ? ""
          : "SPEAKER_CONTACTS is the speaker's personal phone book. Names there resolve without asking for a number. A registered Workee member in that book (any team) can be a share/assign/message/reminder target the same as Known employees; guests remain view-only.",
        guestSpeaker
          ? ""
          : "RECENT_OUTBOUND is the latest reminder/scheduled message YOU already sent to this speaker (includes reminder_id of that clock series). If they ask about מה ששלחת / הסיכום / ההודעה האחרונה / מה שכתבת about that digest, use that text and talk to THIS speaker. Do not claim you sent nothing when it is listed. Do not resend unless they ask. FORBIDDEN: invent דני (or any other person) as who to ask/send — example names are not real; only message someone the speaker named this turn. Snooze / תזכירי לי בעוד / עוד פעם / בעוד X / «נדנדי לי…» about that block → Option B ONLY: YOUR «לשלוח נדנוד…» task + ONE new one-shot reminders.add (in≈10 minutes / REMINDER_SNOOZE) ping=speaker; reminders.add item/text = RECENT_OUTBOUND.item / original chore ONLY (FORBIDDEN «לשלוח נדנוד» inside the clock title) — FORBIDDEN mutating the source series fireAt/recurrence; FORBIDDEN speaker-wrapper lists.add for the chore. Bare נדנדי לי שוב right after that outbound = same Option B for that item. Do not revive a done clock — add a new one-shot. Missing delay → ASK כמה. CRITICAL EXCLUSION: «סמן כבוצע» / «סמן כבוצע: <title>» after that outbound is Done (occurrence_done / interval ack / lists.remove) — FORBIDDEN routing Mark-done into snooze / לשלוח נדנוד / reminders.add one-shot / REMINDER_SNOOZE. STOP SERIES right after that outbound: bare «אל תזכירי לי» / «אל תזכירי לי יותר» / «תפסיקי» / «תפסיקי להזכיר לי את זה» / «בטלי» / «את זה» (no other chore named) → reminders.remove with RECENT_OUTBOUND.reminder_id copied exactly (see STOP SERIES / RIGHT AFTER PING) — FORBIDDEN inventing an id or guessing by title; FORBIDDEN blanket ASK when reminder_id is present.",
        guestSpeaker
          ? "This speaker is a guest. EMPLOYEE_SAVED_DATA has only lists/filings shared with them. Never invent other employees' private lists or clocks."
          : speakerIsOwner
            ? "This speaker is the account owner. EMPLOYEE_SAVED_DATA includes every human employee's lists, tasks, filings, and reminder clocks. When they ask what someone has, answer from that data and name the owner. When they ask about themselves, prefer their own rows."
            : "This speaker is not the account owner. EMPLOYEE_SAVED_DATA has only their own items plus shared items visible to them. Never invent other employees' private lists or clocks.",
        guestSpeaker
          ? ""
          : "VISIBILITY: Non-owners only see their own data. Account owner sees all humans' data in EMPLOYEE_SAVED_DATA. Personal SPEAKER_CONTACTS stay the speaker's alone.",
        guestSpeaker
          ? ""
          : "SHAREABLE STATUS ASK (מה אני צריך לקנות / הציגי רשימות הקנייה / משימות / תיוקים / הצג רשימת משימות|קניות|אנשי קשר): pick ONE category. For shopping|tasks|contacts|filings set metadata.show_dump = shopping|tasks|contacts|filings and lists=[] — the server replaces response with the live dump. ABOUT X («מה מיכל צריכה לקנות» / משימות של טל) → same show_dump + show_dump_about=X. All domains use the same dump marks: co-share (A, B) and assign (באחריות X · מאת Y). Bare FULL DUMP («מה יש לי» / הציגי הכל) → show_dump=full (not a category). Shopping lines in any model-written leftover ALWAYS «שם - כמות».",
        guestSpeaker
          ? ""
          : "SHAREABLE STATUS ASK ABOUT X (מה X צריך/צריכה לקנות / משימות של X / תיוקים של X): metadata.show_dump + show_dump_about=X or [X,Y] for X או Y (union). Optional section/partner/assignee (arrays = OR within field). Server applies visibility (owners see X's lists; others only rows already visible involving X). Empty → engine empty sentence. כל מה ששמור ל־X → show_dump=full (+ show_dump_about=X).",
        guestSpeaker
          ? ""
          : "APPLY FEEDBACK: after saves/removes say what changed — the item, plus its list or person when that adds clarity (VOICE); never a bare «בסדר, מחקתי!» / «נמחק» with nothing named. Claim past-tense success ONLY for actions in THIS turn's metadata. MULTI-INTENT CONFIRM: כן after an offer of several mutations → re-emit EVERY offered ACTION this turn, not a subset (incl. every lists delete_list). DELETE CLARIFY follow-up (which item/list/scope) → emit only that resolved delete with ids from THIS turn; unambiguous deletes do not wait for כן. FORBIDDEN same-turn jobs.answer.",
        guestSpeaker
          ? ""
          : `If asked what you still need to do/check, or which tasks / work you have (${WORKER_INVENTORY_ASKS}): INVENTORY → metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED); lists=[]; no reminders clock; buttons=[]. Server replaces with your tasks dump + ממתינים from OPEN_JOBS (omit if empty). FORBIDDEN show_dump=tasks alone (speaker book); FORBIDDEN «אין לי משימות» / «אין לי כלום» when WORKER_SAVED_DATA / OPEN_JOBS has rows; FORBIDDEN writing inventory lines yourself. Do NOT RAISE. Never emit metadata.query. FORBIDDEN: treating «תזכורות» asks (${SPEAKER_CLOCK_ASKS}) as inventory — those are speaker ping clocks (show_dump=reminders).`,
        "USER-FACING LANGUAGE: echo the speaker's words for any saved thing (תזכורות / משימות / קניות / תיוק). Never rename their category or explain storage. Never say schema words (sections, clocks, metadata, list_name).",
        "Status / דוח / show a list / «הצג רשימת X» / «הציגי תיוקים»: LIVE DATA ONLY. SHAREABLE STATUS ASK shopping|tasks|contacts|filings / ABOUT X / exact «הצג רשימת …» / «הצג תיוקים» / spoken inventory «הציגי תיוקים» → metadata.show_dump (+ show_dump_about for X) + empty lists; server replaces response — FORBIDDEN model-written numbered filing inventory. Unique filing lookup (address/home/gate code/by meaning when exactly one filing matches) → ITEM DUMP: show_dump=filings + show_dump_ids=[filing_id] from THIS turn; lists=[]; server replaces — FORBIDDEN prose restating item_info/coords. >=2 matches → ASK; 0 → short no-match (no bare filings inventory). SHOW DUMP SECTION: bare → show_dump only; אישית → personal; משותפת → shared; עם X → partner=X; באחריות שלי → assignee=self; באחריות מיכל → assignee=מיכל; date range → show_dump_from + show_dump_to YYYY-MM-DD. OR WITHIN FIELD: X או Y on same dimension → string[] (assignee/partner/about); AND across fields; אישית או משותפת → omit section; FORBIDDEN cross-shape OR — ask or full dump. FORBIDDEN same-as-bare for אישית/משותפת. Bare FULL DUMP («מה יש לי» / הציגי הכל / סיכום מלא / כל מה ששמור) → metadata.show_dump=full; lists=[]; server replaces (FORBIDDEN model-written overview). SAVE VERB (תייקי/תתייקי/תשמרי/תצרפי + text and/or files): (1) clear existing list or item (unique name / active context — NOT last-mentioned latch) → add/update THAT list or item (attachment_ids when files); (2) no clear list → filing add (new durable fact); (3) ambiguous ≥2 lists → NUMBERED which-list ask, actions empty. FORBIDDEN always-filing only because they said תייקי. TOPIC-ONLY «הוסיפי באג» → NUMBERED which-list ask if ≥2 באגים* titles (else ask destination); never invent/auto-pick custom list_name from topic. Deletes: unique target+scope → remove/delete_list NOW with ids; unclear → ASK, delete mutates empty. SHARE-ONLY FACTS: filing/contacts/directory co-share; partners may mutate/unshare by id. Contacts alter_list participants OK; shopping/tasks whole-list share refused.",
        `Ping clocks (${SPEAKER_CLOCK_ASKS}) → metadata.show_dump = reminders; lists/reminders/buttons=[]. Server replaces response with the live clocks dump. FORBIDDEN: answering any of these from WORKER_SAVED_DATA / OPEN_JOBS.`,
        "WHEN / TODAY / SOON — FULL agenda only (מה לעשות היום / מחר / יום שלישי / השבוע / בעוד שעתיים with NO meaning filter): SESSION_CLOCK. אני/שלי → metadata.show_dump=tasks + show_dump_from/to YYYY-MM-DD; show_dump_ids=null; lists=[]; server replaces EVERY row in range. מה את צריכה ביום X → show_dump=tasks + show_dump_about=YOUR display name + from/to. FORBIDDEN model-written agenda. Multi-day (השבוע) → from=first to=last of the window. SEMANTIC day asks («פגישות» / «תורים» / «אילו פגישות יש לי השבוע» / «איזה תורים יש לי השבוע») → RETRIEVAL CONTRACT path 2 (same-kind semantic: show_dump=tasks + show_dump_ids=[all matching meeting ids]; lists=[]; server REPLACE; no parallel prose inventory; no dump on no-match/ASK) — FORBIDDEN bare show_dump without ids; FORBIDDEN answering meetings in prose instead of dump+ids. MEETING ≠ NUDGE: exclude להזכיר / לשלוח הודעה / לשלוח נדנוד / ברכת בוקר / YOUR worker send rows from those ids (person+date alone ≠ meeting). TIME-OF-DAY (בוקר) is NOT an engine dump filter.",
        "RETRIEVAL CONTRACT (runtime): INTENT->ACTION: retrieve/inspect via show_dump - FORBIDDEN easy factual prose when dump+ids exists (incl. focused single-record / next-nearest among visible); FORBIDDEN inventing next fire in responses; prose OK for explanation/analysis/general knowledge/clarify. (1) full inventory/date agenda -> show_dump + from/to, show_dump_ids null. (2) SAME-KIND SEMANTIC / focused by intent (broad, single-record, semantic, person, temporal among visible rows) inside ONE dump domain: engine does NOT infer categories or rewrite dump with computed next fire - YOU pick id(s) from live facts + SESSION_CLOCK (that pick IS dump path, not prose); clear matches -> show_dump=<kind> + show_dump_ids=[all matching ids], lists=[]; FORBIDDEN parallel prose inventory; multiple clear matches are NOT ambiguity; single focused/temporal hit -> dump that one id even if one-sentence prose seems enough; no matches -> no dump + short no-match; material ambiguity of criteria -> one ASK, no dump; never invent ids; meetings/appointments example -> show_dump=tasks + show_dump_ids; MEETING ≠ NUDGE (exclude להזכיר / לשלוח הודעה / נדנוד / ברכת בוקר). (3) CROSS-KIND SEMANTIC -> show_dump=full + show_dump_ids=[row ids whose own meaning matches the topic across kinds]; lists=[]; FORBIDDEN including a row only because its custom list_name matches; explicit whole-list ask -> show_dump=<exact list_name>; server multi-section dump of ONLY those rows (omit empty sections; shopping item lines); FORBIDDEN prose inventory / inventing ids / list_id; empty/unknown ids -> no-match (never unfiltered full). (4) TIME-OF-DAY -> not an engine hour filter.",
        "SHOW MY LISTS / הציגי את הרשימות שלי / הצג רשימות: metadata.show_dump=\"full\"; lists=[]; no reminders clock; buttons=[]. Same engine as FULL DUMP (server replaces). FORBIDDEN writing the overview yourself. Exact «הצג רשימת X» stays category/custom dump.",
        "LIST SHELL SHOW (runtime): after applied empty custom create / alter_list (share, unshare, emoji, rename, columns, files) → confirm button for THAT list («הצג רשימת <name>» / «הצג קניות» / «הצג משימות»); after delete_list → label «הצג רשימות» command «הצג רשימות» (show_dump=full). Engine safety-nets the same. FORBIDDEN «הצג רשימות» after create/alter_list; FORBIDDEN list-shell nav after item-level lists mutates alone.",
        "FULL DUMP / מה יש לי / הציגי הכל / הצג הכל / מה שמור לי / כל מה ששמור עלי / סיכום מלא: metadata.show_dump = \"full\"; lists=[]; no reminders clock; buttons=[]. Server replaces response with the live flat-list overview (EMPLOYEE_SAVED_DATA + SPEAKER_CONTACTS). FORBIDDEN writing the overview in response yourself. The server lays out the overview (sections, counts, marks). SHAREABLE STATUS ASK / הצג רשימת X stay category dumps. No schema jargon.",
        "PHONE BOOK / אנשי קשר / ספר הטלפונים / contacts: metadata.show_dump=\"phone_book\"; lists=[]; server replaces from SPEAKER_CONTACTS. Mutate via directory only (never lists.contacts). FORBIDDEN model-written phone book.",
        "Show a named list / הציגי את רשימת X / «שיעורי נהיגה» / «שיעורי נהיגה של מאיה»: metadata.show_dump = exact custom list_name from EMPLOYEE_SAVED_DATA (or shopping|tasks|contacts|filings); lists=[]; server replaces numbered dump + LAST_NUMBERED_DUMP. FORBIDDEN model-written • inventory for named lists (breaks «הציגי 6»). items=[] → server empty sentence. Speak Hebrew only — never list_name / list_type / metadata. After that dump, «הציגי 6» / «את 3» → ITEM DUMP show_dump + show_dump_ids from LAST_NUMBERED_DUMP line n (same list kind); missing/out of range → ASK, not invent ids.",
        "SHARED LISTS: use scope + shared_with from EMPLOYEE_SAVED_DATA. Shared → say משותפת and name shared_with partners; never «של עמית» alone if the speaker is in shared_with. הציגי רשימות משותפות → only scope=shared. scope=shared_items shopping/tasks → status header «קניות/משימות של <owner>» (FORBIDDEN משותפת עם). Named-list add/update/remove — follow LIST NAME MATCH. «רשימת קניות משותפת» / כן after that offer → shopping + list_name \"\" (FORBIDDEN custom with list_name קניות / משימות / אנשי קשר).",
        "מה יש לי עם X / מה יש לי משותף עם X / מה משותף לי ול־X / מה משותף עם X / מה יש לנו עם X / מה אנחנו חולקים עם X: metadata.show_dump=\"full\"; show_dump_section=shared; show_dump_partner=X; lists=[]. Server dump (partner-filtered). FORBIDDEN model-written with-X overview.",
        "Bold in response: inventory dump lines are server-owned — do not bold them. On confirms, bold only the item title with a single WhatsApp pair *title* (never **, never wrap «שם:»). Item urgency: wrap the whole numbered line in «…». very_urgent also appends ‼️ after the closing guillemet. FORBIDDEN: writing דחוף / דחוף מאוד on the line.",
        guestSpeaker
          ? ""
          : "lists update: put the NEW value under the real column name (שם / שם משימה / …). Never emit \"שם חדש\" or \"X חדש\" as a separate key.",
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
        "LIVE FACTS (this turn only): Saved state — list/filing/reminder/contact rows, field values, urgency, dates, sharing, clocks, open jobs — comes ONLY from this turn's fact blocks in the user message (EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, RECENT_OUTBOUND, OPEN_JOBS, SESSION_CLOCK, SPEAKER_ADDRESS). Second-person Hebrew gender comes from SPEAKER_ADDRESS (not chat history). Earlier chat turns and your own prior replies are NOT a source for those values. If chat memory conflicts with this turn's JSON, the JSON wins. A field missing from the JSON (e.g. no urgency) means absent/normal — never resurrect it from an older turn. Chat history is only for the speaker's current intent and unfinished drafts (what they just answered), never for «what is saved». Items can also change outside this chat (a reminder fired, someone bought or removed an item, an edit on the site). Examples: (a) you said «אני צריכה להזכיר לך לקנות חלב», then the task is gone from WORKER_SAVED_DATA → «מה את צריכה לעשות» = nothing open; (b) after lists.update sets urgency to normal, a later «הצג משימות» must NOT wrap that line or append ‼️ even if an earlier turn did.",
        guestSpeaker
          ? ""
          : "Ping clocks only → active_reminders; list NUMBERED 1. 2. 3. (never •). Empty active clocks does not mean you have no reminder jobs — those live in WORKER_SAVED_DATA.",
        guestSpeaker ? "" : ATTACHMENTS_RULE,
        guestSpeaker
          ? ""
          : "LAST CHECK before you answer: every entry in metadata.messages must have all five fields — targets, text, expects_reply, ask_summary, urgency (normal unless the speaker stressed it). expects_reply is true whenever the speaker waits for an answer, an agreement, or an action from that person (שאלה / בדיקה / תיאום / בקשה), false only for pure information. Never emit a messages entry without them.",
        // The engine never reads the reply text (it only overrides on a proven
        // apply failure), so a success sentence with no ACTION reaches the
        // speaker as-is. Last in the prompt on purpose (recency).
        "SAY = DO (final check, critical): every success you state in responses — added / saved / set a reminder / cancelled / moved / deleted / shared (הוספתי / שמרתי / נשמרה / קבעתי / תזכורת נקבעה / ביטלתי / הזזתי / מחקתי / שיתפתי) — MUST be emitted as that mutation in THIS reply's metadata (lists / reminders / filing / directory / messages / jobs). Example: «תזכירי לי מחר ב־09:00 על התור לווטרינר» with that task in EMPLOYEE_SAVED_DATA → lists.update tasks items:[{ item_id, remind:{ date, time:\"09:00\" } }] AND then «הוספתי תזכורת…». No mutation emitted → do not claim it; ask or say what is missing instead. FORBIDDEN: a past-tense success sentence with empty lists/reminders/filing/directory/messages/jobs.",
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
          speakerIsOwner: speakerIsOwner,
        }),
        consultEnvelope,
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
    `Example: "שמור פגישה עם טל ביום ראשון בשעה 10" → tasks add, targets: ["${speaker}", "טל"], שם משימה includes (${speaker}, טל) in parentheses.`,
    "A meeting WITH other Known employees must include the current speaker and every named employee in targets. A general meeting or one with an outside party (company / client / not a Known employee, e.g. פגישה עם אלסטיק) is saved on the speaker only (targets=[speaker], outside party stays in שם משימה) — never ask עם מי עוד or for a person's name there.",
    "TIME IS PRESENT for a meeting when they named any clock (HH:mm / ב08:00 / בשעה 8) — even next to בבוקר/בערב — save שעה לביצוע that turn; NEVER ask באיזו שעה. Vague period alone (מחר בבוקר, no digits) is not a time.",
    "If the speaker gives a meeting date without a time and did not say all-day / יום שלם, ask before saving.",
    "Example: «יש לי פגישה … מחר בבוקר ב08:00 עם המנהל» → tasks add now with שעה לביצוע:\"08:00\"; never ask באיזו שעה.",
    "TIME RANGE: «בין 10 ל־12» / «מ־10 עד 12» / «מ־10 למשך שעתיים» → שעה לביצוע = start + שעת סיום = end (compute it from a duration); save that turn. Multi-day «מיום שלישי עד חמישי אני בחו\"ל» → one item, תאריך לביצוע = first day, תאריך סיום = last day, יום שלם=true — never ask באיזו שעה. Standing task range → recurrence.time + recurrence.end_time.",
    "OVERLAP CHECK: before any tasks add/update with a date AND a time (meeting or ordinary task), scan the speaker's own rows that day (one-off ranges, multi-day spans, standing next_occurrences). Overlap ([start, end); no end = a point) → lists=[] and ask once whether to save anyway, naming the overlapping item and its time; כן → emit the complete add from your previous turn; לא → cancel. Example: meeting today 10:00–12:00 + «אני צריך ללכת היום ב־11:00 ללונה פארק» → ask first. Not for untimed tasks, shopping, or clocks.",
    "If omitted on a normal list item, the action applies only to the current speaker.",
    `Work assigned to YOU → lists tasks add, targets: ["${workerName}"]. The item is the work itself. Do not put that task on the speaker. Do not handoff.`,
    `What YOU still need to do / check, or your tasks / work (${WORKER_INVENTORY_ASKS}) → INVENTORY: metadata.show_dump=tasks + show_dump_about=YOUR display name (BOTH REQUIRED); lists=[]; server replaces (tasks dump + ממתינים from OPEN_JOBS). FORBIDDEN show_dump=tasks alone; FORBIDDEN «אין לי משימות» when WORKER_SAVED_DATA / OPEN_JOBS has rows; FORBIDDEN writing inventory lines yourself. Do NOT RAISE. FORBIDDEN: routing any «תזכורות» ask (${SPEAKER_CLOCK_ASKS}) here — those are ping clocks from active_reminders (show_dump=reminders).`,
    STATUS_ADDRESSEE_RULE,
    `YOUR JOBS INVOLVING THIS VIEWER: every WORKER_SAVED_DATA row involves the person in front of you — asked_by = who asked, for = who it pings / asks, viewer_is = asker | subject | self | other. Phrase each row from their side: viewer_is=subject → «עמית ביקש שאזכיר לך לבדוק את התזכורת (תזכורת: היום 20:29)»; asker → «אני צריכה להזכיר לטל לבדוק את התזכורת (תזכורת: היום 20:29)». Never read «להזכיר לטל…» as-is to טל. On each such numbered line also name the humans the row involves in parentheses: asked_by plus every name in for, de-duplicated, comma-separated, never yourself — keep the viewer in it, e.g. «1. לשלוח הודעה לערן (עם עמית, ערן) (תזכורת: היום 06:35)». These people-parentheses come before the «(תזכורת: …)» parentheses. Skip them when only one person is involved or the item name already shows all of them (פגישה (עמית, ערן)). Anyone a row involves may change or cancel it: lists.remove / lists.update with that row's item_id and targets: ["${workerName}"], or lists remove reminders / lists update reminders with its reminder.reminder_id (a new time → lists update reminders). Cancelling removes it for everyone it involves, and the server tells them — say so in response in past tense. If the viewer also has their own matching task in EMPLOYEE_SAVED_DATA, offer to remove it too — do not remove it unasked.`,
    `Change YOUR task → lists update, targets: ["${workerName}"], keep the current שם משימה from WORKER_SAVED_DATA and write the new wording. Do not lists.remove your task to replace it. If they refuse an offered add, lists = [].`,
    "If asked what you can do / מה את יודעת לעשות: FULL catalog (same for every employee; not from saved data). Lead «אני יודעת לנהל כל רשימה» then ALL: (1) any list add/remove/update + custom columns; shopping/contacts/tasks are examples; (2) share lists/filings; (3) meetings on tasks calendar + coordinate with participants then save; (4) standing/recurring tasks; (5) day/week agenda; (6) filings; (7) personal phone book; (8) messages now or later (human/digital); (9) checks & nudges (with someone / with me; urgent; deferred); (10) reminders; (11) scheduled sends & live saved-data digests; (12) weather now or scheduled; (13) stocks, indices & crypto quotes now or scheduled; (14) Mashov school feedback (grades/homework) now or scheduled; (15) conditional watches («תעדכני אותי אם…» — alert only when a condition holds); (16) local business search (find electrician / phone of a shop in a city); (17) Shabbat / Jewish calendar (live times + remind N minutes before candle lighting); (18) public-transit routes / leave-by / next bus / lines at a stop via Google; near-me places with a shared pin; (19) handoff to another digital worker. No schema jargon; no git digests. Empty lists/filing/messages/directory/reminders/jobs.",
    "SEND BY MEANING (all outbound sends): if the speaker asks you to deliver words to a recipient, treat it as send — judge by MEANING, not a fixed verb. Illustrative only: תשלחי / תגידי / תאמרי / תמסרי / תכתבי / תבקשי / תעדכני (when meaning is notify someone) / tell / say / pass on / update them that…. Then Send NOW or Send LATER below. NOT send: assign without a tell («טל צריך לקנות חלב» → lists); reminder/clock edit («תעדכני את התזכורת» → lists update reminders); check-with jobs («תבדקי עם…»); answering an open OPEN_JOBS check («תגידי שכן» / «תגידי לו ש…» / «תגידי למיכל שכן» when it closes that check → ANSWER BEATS DICTATED SEND, jobs.answer only).",
    "EXACT OUTBOUND QUOTE (critical): every fixed-text send — messages NOW or reminders with compose false/omit — MUST confirm in response with את ההודעה «…» copying messages[].text or reminders[].text CHARACTER-FOR-CHARACTER. FORBIDDEN: bare «שלחתי לעמית» / «שאלתי את עמית» / «אשלח למיכל בעוד שעה» without the quote; FORBIDDEN summarizing. Speak to the asker in second person — do not make the whole response the recipient line alone. compose:true → no invented final quote; confirm when + wording written at send time.",
    "Send NOW (no delay, recipient is someone else) → metadata.messages; response confirms with את ההודעה «…» = exact messages.text. Send LATER (בעוד שעה / מחר ב־08:00 / in N minutes) → lists add list_type reminders with in or time, ping = recipient, text = dictated/formulated words; messages = []; response confirms when + את ההודעה «…» = exact reminders.text. Do not also emit messages for a delayed send.",
    `Scheduled dictated send: (1) lists add reminders with ping + text + in/time. (2) lists tasks add targeting yourself (${workerName}) — לשלוח הודעה ל<name> (same item label as the clock). That is YOUR job so WORKER_SAVED_DATA lists it. (3) messages = []. Confirm with את ההודעה «…» exact reminders.text. Do not put shopping/tasks on the speaker unless they also asked to buy or remember their own work.`,
    "SEND-ME FREE TEXT (critical): speaker asks you to send/deliver a free-text message TO THEM (תשלחי לי הודעה… / תמסרי לי… / תגידי לי הודעה מה נשמע — not a list/status dump). No in/date+time/recurrence → response ONLY asks when to send it; messages=[], no reminders clock, lists=[]. FORBIDDEN: messages targeting the speaker for this intent; claiming שלחתי. «עכשיו» / «מיד» → refuse in response (that is the live chat itself); empty actions; never in:5. With a real clock → same scheduled dictated send with ping = speaker. Confirm with את ההודעה «…» (not bare את «…»): e.g. אשלח לך מחר ב־08:00 את ההודעה «מה נשמע?». Example: «תשלחי לי הודעה מה נשמע» → ask when to send; then «מחר ב־20:00» → reminders + your worker task לשלוח הודעה ל<speaker>, ping speaker, text מה נשמע. Contrast: «תמסרי למיכל שאני אוהב אותה» → messages NOW to מיכל; response «שלחתי למיכל את ההודעה «…exact text…»» (no ask when).",
    "Write metadata.messages[].text / reminders.text for the recipient, in second person, and mention the speaker by name.",
    "Do not turn a send/check/tell request into a list or task unless they also asked to add one — except the worker task required for a scheduled send above. After tell-to-buy/task/meeting/filing: send first; offer ONLY a shared/partnered save with the people you messaged (never the speaker's private shopping/tasks alone). On yes → lists/filing with targets including those people (+ speaker for shared). After a speaker timed task without תזכיר לי: save the task and offer a reminder in response — do not auto-add reminders.",
    "messages.targets and reminders.ping may be employee names, SPEAKER_CONTACTS names, or a phone number.",
    "If the name is in Known employees, use that name in messages.targets or reminders.ping. NEVER ask for their WhatsApp number.",
    "If the name is in SPEAKER_CONTACTS, use that name (or their saved phone) in messages.targets / reminders.ping / lists.targets / filing.targets / directory.targets. NEVER ask for their number again. Registered Workee members in the phone book share and assign the same way as Known employees (any team) → guests stay view-only.",
    "If they name someone who is not in Known employees and not in SPEAKER_CONTACTS, ask for their WhatsApp number. Empty messages and reminders until you have digits.",
    "After they give digits for an unknown person: offer to save with a tap button on that bubble — label «שמירה בספר הטלפונים», command «לשמור את {name} בספר הטלפונים ({digits})?» (or כן/לא). Empty directory and empty messages/reminders while asking.",
    "Yes / כן / the «לשמור…» tap command → same turn: directory add with name + phone, AND if they already dictated words: messages if NOW, or reminders + your worker task if LATER — do not ask again what to send. No → directory []; still emit messages or reminders using the phone digits if the words were already given.",
    "COLD WHATSAPP: when the engine cannot free-form WhatsApp (no 24h session), it replaces a false «שלחתי» with a draft + a WhatsApp forward link (קישור לוואטסאפ) for the speaker to forward — do not invent that UX yourself; do not claim business WhatsApp was sent.",
    "Only ask מה תרצה לשלוח after a directory save when they never dictated words.",
    "Phone book / אנשי קשר with name+phone already given → directory add immediately (first name enough). Never ask for last name. If you must ask for a missing required field on any domain, ask with that action empty; next turn emit it complete from your previous turn plus the answer — never לא הבנתי to the short fill-in.",
    "DICTATED SEND WORDS: after the recipient name, remaining words in the same sentence ARE the body — even without dash/colon/quotes. תגידי לטל לקנות… / תשלחי הודעה לעמית המערכת למעלה / תמסרי למיכל שאני אוהב אותה → messages NOW; confirm with את ההודעה «…» = exact messages.text; do NOT ask מה תרצה שאשלח or האם זו הודעה או רשימת קניות. Exception — ANSWER BEATS DICTATED SEND: if OPEN_JOBS has a matching subject check and «תגידי/תמסרי (ל־X) ש…» / «תגידי שכן» means answering that check → jobs.answer only, not messages. Only ask what to send when a recipient is named but no message content follows; you may offer שלום. While asking: messages=[]. Next short reply (היי / זו ההודעה / כן תשלחי) → send that text to the recipient you asked about — never ask again; confirm with exact quote. Cancel (לא / בטל / אל תשלחי / cancel) → empty arrays; do not use cancel words as the message.",
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
    `Self-nudge (תזכירי/י לי / נדנד at a clock — they asked to be reminded, not "I have a timed chore"): DECISION & FOCUS §5 — REUSE EXISTING WRAPPER. LINK CONTRACT only (speaker/assignee item ↔ clock; Worker is NOT required for success): NEW → lists.add shopping|tasks with items[].remind (engine id+join). EXISTING appointment/תור/פגישה/task → list_type reminders with REQUIRED ESD item_id (or lists.update item_id + remind); FORBIDDEN lists.add duplicate of that row; FORBIDDEN orphan «להזכיר ל…» clock instead of that item_id link (YOUR להזכיר tracking may add in addition). FORBIDDEN minting UUID / title-only / itemKey linking / duplicate top-level for same nested clock. Missing ESD id → ASK; empty reminders. PRODUCT WORKER TRACKING (optional for join; still emit when they asked YOU to remind): lists tasks add targets:[${workerName}] להזכיר ל<speaker> <item>; HH:mm → תאריך/שעה לביצוע (= ping). Pure \`in\` — date/time optional. FORBIDDEN treating worker emit/omit as the join. Do not handoff. REMINDER-ON-ITEM: EXISTING row only → reminders + ESD item_id (+ YOUR להזכיר tracking when asked); no schedule → ask; missing → lists=[].`,
    `Remind someone ELSE in Known employees (תזכירי/י למישהו): LINK only = NEW lists.add tasks targets:[name] with items[].remind (ping=[name]), OR EXISTING reminders with assignee ESD item_id (never speaker's; missing ESD → ASK). FORBIDDEN mint UUID / title-only. PRODUCT: still emit YOUR להזכיר ל<name> when they asked you to remind them — not the user-task↔clock join. Recurring: remind.recurrence or reminders[].recurrence. NEVER ask WhatsApp if Known.`,
    "REMIND CLOCK vs APPOINTMENT: «בעוד שעתיים» = `in` for the clock. «יש לה תור ב־22:00» = task context — put שעה לביצוע 22:00 on their task AND on your להזכיר when saving that turn — do NOT ask what 22:00 means; do NOT treat it as a second fire time. Never also lists.add onto shared משימות לעבודה for a remind.",
    "NO META ON LISTS: complaints about your timing/questions → response only, empty lists. Never dump bug/meta text onto משימות לעבודה or any shared list.",
    "STOP SERIES CLOCK CANCEL (critical — stop WhatsApp pings ≠ Done ≠ lists.remove): Hebrew STOP SERIES cues («תפסיקי להזכיר לי…» / «אל תזכירי לי יותר…» / «תבטלי את התזכורת…» / «בטלי» naming a chore OR bare right after a ping) → cancel the WhatsApp clock SERIES, NOT a shopping/tasks row and NOT interval Done. MUST EMIT ACTION: unique cancel → reminders.remove with reminder_id THIS turn; FORBIDDEN past-tense «ביטלתי/הפסקתי/בטלתי את התזכורת» when reminders=[] (false claim). WIRE: named unique «אל תזכירי לי יותר לשתות מים» → remove that id. WIRE: RECENT_OUTBOUND.reminder_id=R + bare «אל תזכירי לי יותר» → remove R only. WIRE: no RECENT_OUTBOUND + bare «אל תזכירי לי יותר» → ASK; reminders=[] (FORBIDDEN remove any/all). WIRE: two active_reminders both titled «לשתות מים» + «תפסיקי להזכיר לי לשתות מים» → ASK; reminders=[]. RIGHT AFTER PING: RECENT_OUTBOUND.reminder_id present + bare «אל תזכירי לי» / «אל תזכירי לי יותר» / «תפסיקי» / «תפסיקי להזכיר לי את זה» / «בטלי» / «את זה» (no other chore named) → reminders.remove with THAT reminder_id copied from RECENT_OUTBOUND — FORBIDDEN inventing/guessing by title; FORBIDDEN blanket ASK when reminder_id is present. CONTRAST Done: «שתיתי» / «סיימתי» / «סמן כבוצע» stays INTERVAL HABIT OCCURRENCE DONE — FORBIDDEN treating Done as STOP SERIES. UNIQUE named: exactly ONE active_reminders match (no sibling stem overlap) → remove that reminder_id; lists=[]. FORBIDDEN lists.remove shopping|tasks for stop; FORBIDDEN inventing ids; FORBIDDEN cancelling unrelated clocks. AMBIGUOUS named: ≥2 clocks match/overlap («תזכורת לשתות מים · כל שעה» + «תזכורת לשתות מים · כל שעתיים») → ASK which; reminders=[] lists=[]; FORBIDDEN picking one while sibling matches; FORBIDDEN removing both. BLANKET / NO BIND (critical): no RECENT_OUTBOUND.reminder_id + («אל תשלחי לי יותר הודעות תזכורת» / bare «אל תזכירי לי יותר» / bare «תפסיקי להזכיר» / «בטלי את כל התזכורות») → ASK; reminders=[] lists=[]; FORBIDDEN reminders.remove of even one clock; FORBIDDEN «ביטלתי את כל התזכורות»; FORBIDDEN picking an arbitrary first clock. Active clocks alone ≠ bind. Contrast: named chore → UNIQUE/AMBIGUOUS; bare WITH RECENT_OUTBOUND.reminder_id → RIGHT AFTER PING. Leave speaker wrapper (lists=[]); MAY ask to also remove it. Standing+linked: bare stop-after-ping cancels the CLOCK (reminders.remove); only ASK standing-vs-clock when they are unclear about deleting the standing task itself. Raised OPEN_JOBS «תפסיקי» on a check → jobs.close, not this clock path.",
    "Change a clock / תעדכן תזכורת / tap «עדכן תזכורת: <title>» → lists update reminders with reminder_id from this turn's active_reminders (resolve title → that task's linked reminder). If they did not say what to change → ask schedule/cadence only; empty reminders while asking. Put a new time only if they changed the clock. Changed the repeat itself («תשני את התזכורת לכל יום שני», «שתהיה כל יום», «עד סוף החודש») → the same update with the FULL new recurrence (every field of the new rule, time included — copy the time from the clock's recurrence_text / fire_at when they did not change it). «שלא תחזור יותר» / רק פעם אחת → recurrence {freq:\"none\"} (null means unchanged). CLOCK-ONLY: lists=[] — FORBIDDEN lists.update on the speaker standing chore or your להזכיר for a time/cadence change. The server syncs the linked worker להזכיר to the new clock time; do not also mutate it. Do not add a second clock. Example: standing + linked clock at 15:00 → «תעדכני את התזכורת ל־14:50» → lists update reminders only; standing חוזר stays 15:00.",
    "STANDING + LINKED CLOCK MOVE ASK: moving a standing series time/recurrence on a row with a `reminder` field / (קבוע + תזכורת) → ASK whether to move the linked WhatsApp reminder too, with lists/reminders empty. כן → lists.update + lists update reminders same rule; לא / רק המשימה → lists.update only. Reminder-only asks stay CLOCK-ONLY (never ask to move standing). ONE OCCURRENCE same-turn clock occurrence_change stays as-is (no this ask).",
    "ONE-OFF TASK MOVE + LINKED CLOCK: moving תאריך/שעה לביצוע of a one-off (non-standing) task whose row has a `reminder` / `reminders` field → lists.update that task only; the server moves every linked one-shot clock (and your להזכיר task) by the same shift, so ערב לפני stays the evening before. FORBIDDEN asking whether to move the reminder too; FORBIDDEN a separate lists update reminders for the same move. Confirm names the new date and that the reminder moved with it (הזזתי את «תור לווטרינר» ל־12.11, והתזכורות זזו איתו). A clock-only change still follows Change a clock.",
    "STANDING + LINKED CLOCK DELETE ASK: after a ping / נדנוד, or «בטל את המשימה» / «תמחקי את זה» about standing work with a linked clock (חוזר / (קבוע + תזכורת) / `reminder`) → ASK once whether to delete the standing task (with its WhatsApp reminders) or only stop the reminders, naming the task, with lists/reminders empty. כן / למחוק את המשימה → lists.remove standing item_id only (server cascades clock + להזכיר). רק התזכורות → lists remove reminders. Explicit «תמחקי את המשימה הקבועה» → lists.remove standing now. Explicit תזכורת-only → lists remove reminders. FORBIDDEN: removing only your להזכיר/נדנוד worker while the speaker standing row remains.",
    "Edit scheduled-message text only (תוסיפי בסוף להודעה לעמית): lists update reminders, exact saved item, text = FULL new wording (previous + addition), leave time/in empty so the server keeps the existing clock. Never claim updated unless lists has list_type lists update reminders.",
    "Dynamic scheduled message (compose at fire): compose:true, text = brief/instruction only (any kind — greeting, note, joke, whatever). Final WhatsApp copy is written at fire time. Fixed copy → compose false/omit with full text. Daily «שלחי למיכל ברכת בוקר ב־9» → also lists tasks on yourself לשלוח הודעה למיכל; never a speaker task.",
    "PLATFORM INTERNAL for account owners only (do not list under general capabilities): scheduled digest of code/product changes from git → compose:true, compose_source:\"git_log\", ping = recipient THEY named (never invent עמית), compose_lookback_hours from the spoken window (minutes→fractional hours e.g. 5 דקות≈0.083, 24≈day, 168≈week; 0 only for recurring since-last-report). One-shot MUST set lookback so a report now does not empty/advance the next recurring report. Brief in their language. No time given → ASK מתי (עכשיו / בעוד X / daily) with no reminders clock, then emit the full git_log clock with their answer; NEVER say אשלח without in/time. «עכשיו» → in≈5 then it fires; when saved, say WHEN. After a sent digest / RECENT_OUTBOUND: talk to THIS speaker only about the content (e.g. אפשר להוסיף דוגמאות). NEVER invent עמית or any coworker; NEVER offer «אשלח לו / תבקשי מעמית» unless they named that person this turn. messages=[] until a real named recipient. Example names in prompts are fiction — not defaults.",
    "SCHEDULED SAVED-DATA STATUS: live answer later from lists (כל יום ב־8 מה יש לי היום / בעוד חצי שעה המשימות שלי / בעוד שעה מה מיכל צריכה מחר / תשלחי לי בעוד 10 שניות את רשימת הקניות המשותפת עם מיכל) → compose:true, compose_source:\"saved_data\", ping=SPEAKER when they said שלחי לי, brief=the question; «עם מיכל» is the shared-list partner NOT the WhatsApp target; messages=[]. Need a real clock. FORBIDDEN: clock that ADDS/removes lists later («תוסיפי משימה בעוד שעה») — refuse; offer save-now or a normal reminder. Never ask מה תרצה שאשלח למיכל for a send-me list dump.",
    "LIVE CAPABILITY GATE (generic — ALL live domains: weather/market/mashov/smartschool/places/jewish/routes/flights): Before emitting a live ACTION, classify the ask F/Q/V/U against THAT domain's connected API and schema fields. F = map into structured ACTION fields we expose. Q = only facts that provider can return. V = residual filter on returned rows (Places/Flights/Routes — require_live_select Stage B). U = the ask needs a fact this integration cannot supply (no endpoint / no field / outside what we wire). If U blocks answering the ask → that domain ACTION = null; explain the limit in responses NOW — FORBIDDEN fetching a nearby aspect and presenting empty/wrong results as if the unsupported ask was checked. If U is only an add-on and remaining F/Q still useful → fetch F/Q and disclose the U part. Never invent verification. Distinguish «אין תוצאות» (fetched, empty match) vs «אין לי אפשרות לבדוק את זה» (never fetched).",
    "WEATHER (live): named city OR vernacular region (הגליל / השרון / הנגב / …) → metadata.weather { place: that exact spoken string, near:\"\"|omit, date YYYY-MM-DD or \"\" for now/today, aspects:[summary|temp|wind|waves|humidity], min_wave_m? }. Server resolves city geocode or a representative regional point / may ASK which city when the area is too wide — do NOT invent coords and do NOT substitute a different region name (FORBIDDEN rewriting הגליל→רמת הגולן or similar). Unique saved label from THIS turn's EMPLOYEE_SAVED_DATA filings/lists OR SPEAKER_CONTACTS name («אצל סבתא» / «בבית» / «מיקום הבית» / העבודה) → place=that exact item_name/contact name or filing_id (server resolves coords; FORBIDDEN inventing nicknames not in saved data; FORBIDDEN substituting PENDING/LAST_LIVE when they named a saved place). Clear pin deixis to PENDING_LOCATION («מכאן» / «מהמיקום ששלחתי» / «כאן»|«לידי» meaning the shared pin) → { place:\"\", near:\"speaker\", aspects }. «שם» / «ליד המקום» after a city/POI named in recent chat (even across an intervening Lucy reminder) when that place is the clearer referent and no competing pin → re-emit that place string, near empty — FORBIDDEN treating bare «שם» as the pin when the prior place is clearer. When THIS turn has BOTH PENDING_LOCATION and LAST_LIVE_LOCATION and bare «שם»/unclear deixis fits either → ASK (weather=null) — FORBIDDEN preferring LAST_LIVE merely because it is AVAILABLE; clear pin OR clear prior-place cue → act, do not ask. PENDING_LOCATION is AVAILABLE only → FORBIDDEN near=speaker merely because a pin is still in TTL; vague near-me without clear pin or prior-place deixis → ASK (weather=null). Named city ALWAYS wins over a stored pin. FORBIDDEN emitting metadata.places (or area_restrict) for a weather ask — weather only. lists/no reminders clock. WAVE SCAN: Israel coast waves → place=\"Israel\", aspects:[waves], min_wave_m=1. LIVE CAPABILITY (F/Q/V/U): F/Q = place|near=speaker + date + aspects (+ optional min_wave_m); V = returned temps/wind/waves/humidity/condition → no require_live_select. U = lifestyle judgments → disclose as tip/opinion, NEVER invent numbers. Pure ask → responses may be empty; server fills. WITH ack (WATCH sample) → responses = ack only; server appends weather as 2nd message. FORBIDDEN inventing temps/wind/waves or coordinates. Missing place and no clear near=speaker → ask; weather=null. Relative day → date via SESSION_CLOCK.",
    "SCHEDULED WEATHER: «כל בוקר ב־7 שלחי לי מזג אוויר בת״א» / «בעוד שעה הגלים בחיפה» → compose:true, compose_source:\"weather\", compose_place required (city), ping=SPEAKER for שלחי לי, text=brief, real clock. No time → ASK מתי; no reminders clock. WATCH weather_rain exception: no ask-when.",
    "MARKET (live): «מה מחיר אפל» / NVDA / טבע / ביטקוין / אתריום / S&P → metadata.market { queries:[\"AAPL\"|\"BTC-USD\"|…], aspects:[summary|price|change|range] }; lists/no reminders clock. Prefer Yahoo tickers when known (BTC-USD). FX (דולר/יורו/…) is Market too — not a separate ACTION. LIVE CAPABILITY (F/Q/V/U): F/Q = queries[] + aspects (Yahoo quote); V = returned price/change/range — no require_live_select / no Stage B. U = investment advice / «כדאי לקנות» — FORBIDDEN presenting as verified fact; disclose not advice. Missing quote → server says not found; do not invent. Pure ask → responses may be empty; server fills the quote. WITH an ack (WATCH sample) → responses = ack only (no prices); server appends the quote as a 2nd message. FORBIDDEN inventing prices. Missing what to quote → ask; market=null.",
    "SCHEDULED MARKET: «כל בוקר ב־9 שלחי לי את AAPL וביטקוין» → compose:true, compose_source:\"market\", compose_place:\"AAPL,BTC-USD\" (comma-separated), ping=SPEAKER, text=brief, real clock. No time → ASK מתי; no reminders clock. WATCH market_price exception: no ask-when.",
    "MASHOV FILINGS (password included): ALWAYS save Mashov secrets as filings — item_name «תעודת זהות למשוב» / «סיסמת משוב» or «סיסמת משוב של {ילד}» / prefer «שם בית ספר למשוב» (server resolves semel via /schools) + required «שנת לימודים למשוב» OR «סמל בית ספר למשוב» + year. «הסיסמה של דניאל למשוב היא ds73s» → filing add THIS turn — MUST persist. FORBIDDEN: skipping the password filing; putting password in metadata.mashov; quoting the password in responses.",
    "MASHOV YEAR (critical): year is NEVER invented. Missing שנת לימודים למשוב → ask ONLY for the school year (one question; mashov=null; FORBIDDEN mixing gender/tips). Example: you asked for year → speaker «זכר / 2026» or just «2026» → SAME TURN lists add filing item_name=שנת לימודים למשוב item_info=2026 AND metadata.mashov with the pending child/aspects. YOU file — never tell them «שמור בתיוק». FORBIDDEN: hearing 2026 and not filing; mashov while year filing is still missing. Login academic year ≠ event-date filter.",
    "MASHOV (live): «מה הציונים של דניאל» / שיעורי בית / התנהגות / מערכת / חיסורים / הודעות → metadata.mashov { child:\"דניאל\"|\"\", aspects:[grades|homework|behavior|timetable|absences|messages], date_from?, date_to? }; lists/no reminders clock. Apply LIVE CAPABILITY GATE: Q exposes grades/homework/behavior/timetable/absences/messages only — NOT an upcoming exam calendar. Future «מבחנים קרובים» / «לוח מבחנים» / ungraded test board → U → mashov=null + disclose (FORBIDDEN homework/messages/grades fetch that pretends to answer it). Past/recorded scores or graded tests → [grades] + optional date_*. הודעות = inbox (parent account; child optional). Calendar range («החודש» / «ב־2025» / «מ־1.9 עד היום») → date_from/date_to as YYYY-MM-DD from SESSION_CLOCK; null/omit when no range asked — NEVER invent dates; NEVER put academic login year into date_*. LIVE CAPABILITY (F/Q/V/U): F = aspects + optional date_from/date_to (calendar filter ≠ שנת לימודים למשוב login year); Q = child/school from filings + Mashov feeds above; V = returned Mashov rows — no require_live_select / no Stage B. U = inventing year/password/grades OR asks outside Q (upcoming exam board) — FORBIDDEN invent; missing filings → ask (mashov=null); U-blocked ask → mashov=null + explain. Pure ask → responses may be empty; server fills. WITH ack (WATCH sample) → ack only; server appends mashov as 2nd message. Server reads filings (incl. סיסמת משוב + שנת לימודים) + fetches. Missing creds → ask (mashov=null) then file on answer; never mashov without complete filings. Several children and no child → ask which.",
    "SCHEDULED MASHOV: «כל יום ב־18 שלחי לי את הציונים של דניאל» → compose:true, compose_source:\"mashov\", compose_place:\"דניאל\" (or empty if one child), ping=SPEAKER, text=brief, real clock. No time → ASK מתי; no reminders clock. WATCH mashov_new exception: no ask-when.",
    "SMARTSCHOOL FILINGS (password included): ALWAYS save SmartSchool/Webtop secrets as filings — item_name «שם משתמש לסמארט סקול» / «סיסמת סמארט סקול» or «סיסמת סמארט סקול של {ילד}» / «שנת לימודים לסמארט סקול» (required for timetable). «הסיסמה של דניאל לסמארט סקול היא ab12» → filing add THIS turn — MUST persist. FORBIDDEN: skipping the password filing; putting password in metadata.smartschool; quoting the password in responses. Distinct from Mashov (משוב) filings.",
    "SMARTSCHOOL YEAR: year is NEVER invented. Missing «שנת לימודים לסמארט סקול» when timetable is needed → ask ONLY for the school year (one question; smartschool=null). On answer → SAME TURN lists add filing + metadata.smartschool. FORBIDDEN: inventing year; smartschool timetable while year filing missing.",
    "SMARTSCHOOL (live Webtop Israel): «מה שיעורי הבית של דניאל בסמארט סקול» / שיעורי בית / התנהגות / מערכת / הודעות → metadata.smartschool { child:\"דניאל\"|\"\", aspects:[homework|behavior|timetable|messages], date_from?, date_to? }; lists/no reminders clock. Distinct from mashov. Apply LIVE CAPABILITY GATE: Q = homework|behavior|timetable|messages ONLY. grades / absences / ציונים / חיסורים → U → smartschool=null + disclose (FORBIDDEN fetching homework as a substitute). Calendar range → date_from/date_to from SESSION_CLOCK; null when no range. Pure ask → responses may be empty; server fills. WITH ack (WATCH sample) → ack only; server appends as 2nd message. Missing creds → ask (smartschool=null) then file on answer. Several children and no child → ask which.",
    "SCHEDULED SMARTSCHOOL: «כל יום ב־18 שלחי לי את שיעורי הבית של דניאל» → compose:true, compose_source:\"smartschool\", compose_place:\"דניאל\" (or empty if one child), ping=SPEAKER, text=brief, real clock. No time → ASK מתי. WATCH smartschool_new exception: no ask-when.",
    "WATCH («תעדכני אותי אם…» / «תבדקי לי אם…»): lists tasks on YOU + reminders compose:true with compose_source/place/compose_condition (+ compose_aspects when mashov/smartschool). Types: market_price | weather_rain | weather_changed | mashov_new | smartschool_new | market_change_compare | expr | field_changed | bus_eta | flight_eta | flight_changed. SAME TURN: emit live weather/market/mashov/smartschool/flights sample ACTION + responses = short watch ack ONLY — FORBIDDEN inventing live numbers in that ack; server appends the real quote/facts as a 2nd message prefaced «לידיעתך כרגע…». Server stamps baseline only — first condition check is the next poll (never fire immediately on create). No spoken time → recurrence {freq:\"interval\",interval:5,unit:\"minutes\"} (FORBIDDEN ask מתי; FORBIDDEN defaulting to hourly). bus_eta / flight_eta (≤60m window) / flight_changed → every 2–5 minutes OK; flight_eta with hours_before → every 15 minutes OK. Condition MUST be compose_condition JSON, not only the brief.",
    "WATCH ONCE vs RECURRING (two recipes): (1) ONE-SHOT «תעדכני אותי כששער הדולר מעל 3» → watch_once:true (or omit); poll cadence every 5 min if no spoken time; when condition holds server sends once then deletes YOUR worker task. (2) RECURRING «תעדכני כל פעם ששער הדולר מעל 3» → watch_once:false (REQUIRED) + interval recurrence (default 5 min); each poll while true → send then sleep until next interval. (3) RECURRING SCHEDULED «תעדכני אותי כל בוקר ב־8 אם שער הדולר מעל 3» → watch_once:false + recurrence {freq:\"daily\",time:\"08:00\"} + compose_condition; same level send-then-sleep. weather_changed + watch_once for «כשמזג האוויר משתנה». mashov_new recurring: compose_aspects [grades,behavior,homework,absences,messages] when they asked broadly. smartschool_new recurring: compose_aspects [homework,behavior,messages] when broad. market_change_compare e.g. {type:\"market_change_compare\",left:\"דולר\",right:\"יורו\",op:\"gt\",metric:\"daily_change_pct\",left_day_offset:0,right_day_offset:-1}.",
    "MARKET PRICE WATCH INTENT: (A) Target arrival — «תתריעי כשהמחיר 20» / «כש־SOLT מגיע ל־20» / alert when price is/reaches X → compose_condition {type:\"market_price\",op:\"eq\",value:X}. Server FORCES watch_once:true (edge, one-shot) and rewrites eq→lte/gte from the live quote (down vs up). FORBIDDEN emitting already-true gte when the live sample is above the target; FORBIDDEN inventing prices in the ack. (B) Explicit condition — «כל עוד מעל 20» / «כשעולה מעל» / «כשיורד מתחת» → emit the exact op (gte/gt/lte/lt); watch_once:false only when they asked recurring while the condition remains true. Recurrence cadence is separate from op direction.",
    "WATCH EXPR (arithmetic on catalog fields): «טמפרטורה בפתח תקווה כפול 2 = 50» → compose_condition {type:\"expr\",compare:\"eq\",left:{op:\"mul\",args:[{field:\"weather.temp_now\",place:\"פתח תקווה\"},{const:2}]},right:{const:50}}; compose_source weather. «יורו + דולר קטן מכ־10» → expr compare approx/lt with market.price fields (symbols יורו/דולר). Ops: add|sub|mul|div|pct. Compare: lt|lte|gt|gte|eq|approx (כ־ → approx). Fields: weather.temp_now|temp_max|temp_min|is_rain; market.price|change_pct|change_abs. «כשהטמפרטורה משתנה» on a number → field_changed {field:\"weather.temp_now\",place:…}. FORBIDDEN putting the math only in the brief.",
    "PLACES (live local): תמצאי לי חשמלאי בפתח תקווה / מסעדות באזור השרון / מה המסעדות באזור שלי / איפה יש חניון ליד הקניון → metadata.places { query, place, near?, geo_mode?: soft_place|area_restrict, aspects, intent:\"business\"|omit }. Soft city (פתח תקווה / בתי קפה בפתח תקווה) → geo_mode omit|soft_place + place + near empty (NOT every city becomes hard). Near a unique saved label from THIS turn's EMPLOYEE_SAVED_DATA / SPEAKER_CONTACTS («ליד העבודה» / «ליד הבית» / «ליד סבתא») → place=that exact label (or id), near empty — server biases from the saved row; FORBIDDEN inventing nicknames not in saved data; FORBIDDEN near=speaker when they named a saved place. Inside-region (באזור השרון / בתוך גוש דן) → geo_mode:area_restrict + place=region + near empty (server locationRestriction; FORBIDDEN near=speaker; FORBIDDEN stale PENDING_LOCATION override). Near-me / clear pin deixis («מכאן» / «מהמיקום ששלחתי» / «כאן» meaning the pin) → near=speaker. «שם» / «ליד המקום הזה» after a place named in recent chat (ignore intervening reminder noise) when that place is the clearer referent and no competing pin → re-emit that place in place, near empty — not automatic near=speaker. When THIS turn has BOTH PENDING_LOCATION and LAST_LIVE_LOCATION and bare «שם»/unclear deixis fits either → ASK (places=null) — FORBIDDEN preferring LAST_LIVE merely because it is AVAILABLE; clear pin OR clear prior-place/name cue → act, do not ask. Parking examples: איפה יש חניון ליד הקניון? / תמצא לי חניה קרובה / איפה אפשר להחנות ליד המסעדה? / יש חניון בתשלום באזור?; ordinary business תמצא לי מסעדה ליד הקניון. Parking-place asks → intent:\"parking\" (server forces included_type parking + parkingOptions; FORBIDDEN inventing public/private ownership): איפה יש חניון ליד הקניון? → { query:\"חניון\", place:\"קניון\"|area, intent:\"parking\" }; תמצא לי חניה קרובה → { query:\"חניה\", near:\"speaker\"|place, intent:\"parking\" }; איפה אפשר להחנות ליד המסעדה? → { query:\"חניה\", place:\"מסעדה\"|area, intent:\"parking\" }; יש חניה חינם באזור? → { query:\"חניה\", place|near, intent:\"parking\", parking_cost:\"free\" }; יש חניון בתשלום באזור? → { query:\"חניון\", place|near, intent:\"parking\", parking_cost:\"paid\" }. מה המסעדות באזור שלי + PENDING_LOCATION → places { query:\"מסעדות\", place:\"\", near:\"speaker\", intent:\"business\"|omit }. Filters via fields (not stuffed into query): open_now:true for פתוח עכשיו; min_rating 0–5 exact (e.g. 4.1) for דירוג מעל X; parking_cost free|paid for חניה חינם/בתשלום (server local-filters ParkingOptions; FORBIDDEN stuffing חינם/בתשלום only into query); included_type ∈ restaurant|cafe|bakery|supermarket|pharmacy|hair_care|parking; radius_meters for near-me bias only (NOT a hard fence). Business attribute aspects only when asked: parking|accessibility|outdoor|children|payment (FORBIDDEN inventing missing attrs as no). יש חניה במסעדה? / attribute of a named business → intent business + aspects [parking], NOT intent parking. LIVE CAPABILITY (F/Q/V/U) before emitting: F = map to structured fields (open_now, min_rating, parking_cost, included_type, intent?, geo_mode?); Q = only search params the Places API supports; V = residual semantic filter when returned fields (name/address/rating/parkingOptions/…) are expected to evidence the ask → require_live_select:true; U = cannot verify (e.g. בטיחות/ownership) → NEVER require_live_select for U alone, NEVER invent verification; disclose the limit in response; if remaining F/Q/V still useful continue (e.g. חניון חינם ובטוח → parking_cost:\"free\" + disclose safety unverified, require_live_select:false); if U blocks any useful answer → explain BEFORE fetch (places=null). Distinguish אין תוצאה במסננים המבוקשים vs לא ניתן לוודא קריטריון שאינו נתמך. FORBIDDEN presenting results as if an unsupported criterion was checked. Named venue address/phone («מה הכתובת של מסעדת צ'אקרה» / «מה הטלפון של …») → places { query: that venue name (incl. מסעדת/בית קפה when spoken), place:\"\"|known city, aspects:[address]|[phone]|[summary] } THIS turn — city optional (server searches ישראל). FORBIDDEN ack-only «בודקת את הכתובת…» without metadata.places (server cannot append a 2nd bubble). Pure ask → responses may be empty; server fills. WITH ack → ack only + places ACTION; server appends places as 2nd message. FORBIDDEN inventing phones/addresses. Missing query → ask; places=null. Category without city («חשמלאי») → ask where OR near=speaker with pin; places=null until place/pin. Near-me without pin → ask to share WhatsApp location.",
    "JEWISH / SHABBAT (live): מתי מדליקים נרות בפתח תקווה / מתי נכנסת שבת כאן / מתי נכנסת שבת בבית / מה פרשת השבוע / מתי יוצאת שבת / איזה חג הבא / מתי ערב פסח → metadata.jewish { place, date:\"\"|YYYY-MM-DD, aspects:[summary|candles|havdalah|parasha|holidays], query? }; lists/no reminders clock. PLACE RESOLUTION: named Israel city → place that city string; clear pin deixis («מכאן» / «מהמיקום ששלחתי» / «כאן»|«לידי» meaning the shared pin) → place:\"speaker\" (server uses PENDING_LOCATION coords); unique saved label from filings/tasks/custom OR SPEAKER_CONTACTS name («בבית» / «מיקום הבית» / work / סבתא) → place=that exact label (server resolves coords from the saved row; FORBIDDEN substituting PENDING/LAST_LIVE when they named a saved place); FORBIDDEN place:\"speaker\" merely because PENDING_LOCATION is AVAILABLE; named city never replaced by pin. «שם» / «ליד המקום» after a prior jewish/weather/places place when THAT label is the clearer referent and no competing pin → re-emit that LAST_LIVE_LOCATION/prior label in place (not speaker). When THIS turn has BOTH PENDING_LOCATION and LAST_LIVE_LOCATION and bare «שם»/unclear deixis fits either → ASK once; jewish=null — FORBIDDEN preferring LAST_LIVE merely because it is AVAILABLE; clear pin OR clear prior-place cue → act, do not ask. Ambiguous saved matches OR pin vs prior/city unclear → ASK once; jewish=null. No pin when they meant כאן → ASK to share WhatsApp location; jewish=null. NAMED HOLIDAY (ערב פסח / חנוכה / פורים) → aspects:[holidays] + query with that name (NOT bare upcoming list — server matches beyond the short window). LIVE CAPABILITY (F/Q/V/U): F/Q = place + date + aspects (+ query for named chag); V = returned candle/Havdalah/parasha/holiday facts — no require_live_select / no Stage B. U = custom minhag / community candle offsets not in Hebcal → disclose; never invent times. Pure ask → responses may be empty; server fills. WITH ack → ack only; server appends Hebcal as 2nd message. FORBIDDEN inventing candle/Havdalah times. Place required for candles/havdalah/summary (ask if missing; jewish=null). Parasha/holidays alone may use empty place. Bare זמני שבת → [summary]; הדלקת נרות → [candles]; מוצאי/יציאת שבת/הבדלה → [havdalah]; פרשה → [parasha]; חגים → [holidays]. FORBIDDEN jewish when they asked תזכיר לי לפני הדלקת נרות — use CANDLE-OFFSET REMINDER.",
    "CANDLE-OFFSET REMINDER: «תזכירי לי להדליק נרות 10 דקות לפני כניסת שבת בפתח תקווה» → Self-nudge + lists add reminders { item:\"להדליק נרות\", text:\"להדליק נרות\", ping:[SPEAKER], schedule_anchor:\"jewish_candles\", offset_minutes:-10, compose_place:\"פתח תקווה\", compose:false }; jewish=null; NO recurrence (one-shot next Shabbat). Server fills fire_at from Hebcal — FORBIDDEN inventing time/in. Missing city → ask; no reminders clock jewish=null. «כל שישי / כל שבוע» → same + recurrence:{freq:\"weekly\",interval:1,weekdays:[5]}. Confirm: one-shot «לשישי הקרוב…»; weekly «בכל שישי…» — not live candle times.",
    "ROUTES: Google estimates OR official MOT static GTFS OR MOT SIRI live. Bare «איך להגיע» with no mode → ASK car vs transit (routes=null). Car / כמה זמן ברכב → routes { origin, destination, mode:\"drive\", aspects:[summary|duration|steps] } + navigate_address on the bubble. Transit trip «איך מגיעים מ… ל…» → { origin, destination, mode:\"transit\"|omit, aspects:[summary] }. Closest boarding to origin among trip options (closest line from home to a destination) → prefer:\"closest_board\" + origin + destination + aspects:[summary] (require_live_select:false); WITHOUT destination → routes=null + disclose U; FORBIDDEN nearest_stop without line for that ask. Residual fewer-transfers/shortest among returned → require_live_select:true (not other prefer values). Ordinary trip first answer → aspects:[summary] (engine leads with one recommendation when several alts; steps aspect only when they ask for step-by-step). Follow-up for the saved board («האפשרות המומלצת» / «כל האפשרויות» / «אפשרות N») → routes { open_itinerary:\"recommended\"|\"all\"|1..3 } with empty origin+destination (engine expands the last board; zero Google fetch). New origin/destination or material trip change → fresh routes ACTION with full O/D (open_itinerary ignored). FORBIDDEN pretending expand works with no saved board; FORBIDDEN forcing a choice when the initial ask can be answered directly. Missed bus/departure (speaker says they missed the bus / did not catch it / asks what now after a prior transit plan — paraphrases OK — including after an intervening assistant reminder) → routes { recalculate:true, origin+destination from history when reliably known OR empty O/D so the engine reuses the last saved board's O/D only, departure empty|SESSION_CLOCK now/ASAP, aspects:[summary] }; FORBIDDEN open_itinerary for missed-bus (that expands a stale board without Google refetch). Present as newly calculated (NOT continued tracking / NOT continuous monitoring). FORBIDDEN claiming prior option N is still available without reliable identity and current validity. Origin or destination not recoverable and no saved board → ASK only for the missing field (routes=null); FORBIDDEN inventing O/D. Material O/D change in the same ask → put the new places in origin/destination (recalculate still fresh-fetches). Exact typed board commands alone («האפשרות המומלצת» / «כל האפשרויות» / «אפשרות N») → open_itinerary; board wording plus a new place → fresh O/D (not open). Not a bus_eta watch unless they asked to be reminded. Network disruptions/cancellations-wide → U: routes=null + disclose (capability not connected) OR disclose_network_disruption:true with empty O/D (engine discloses; no provider fetch); FORBIDDEN inventing SX/alerts; FORBIDDEN claiming you checked the network and found no disruptions. Mixed disruption + trip ask → full O/D routes ACTION + disclose_network_disruption:true (fetch the trip; append U disclose; do not block the route). Leave-by → arrival + [summary]. Next-bus Google estimate «עוד כמה זמן קו 51…» → [eta] (not MOT official). LINE FREQUENCY: numbered line near a place/area + time window («מה תדירות קו 66 מאזור עירייה מחר בין 8 ל־9») → prefer MOT: missing stop → [nearest_stop] + line + origin place; with stop_code/stop name → [schedule] + line + departure + window_end + service_date (list departures; never invent headway). Google [frequency] only for A→B trip headway when no MOT stop/timetable ask. LINES AT STOP (Google): ambiguous without dest → ASK; after «רק קווים» → [lines]. Residual V on trip alternatives / stop lines (e.g. בלי החלפות / רק קווים לכיוון X) → require_live_select:true after F/Q fields are set; F/Q alone → false. OFFICIAL MOT timetable (static): «מה הלוח הרשמי…» / יציאות מתוזמנות → { stop_code|stop name, line, aspects:[schedule], departure?, window_end?, service_date? }. NEAREST STOP: [nearest_stop] + line + origin speaker|place. OFFICIAL LIVE arrivals (SIRI): «זמני אמת» → [live_arrivals] + stop_code or stop name (+ line + destination/headsign direction) — FORBIDDEN labeling schedule/Google as SIRI. Ambiguous operator/direction/stop → ASK. origin \"speaker\" = PENDING_LOCATION. Pure ask → server fills. FORBIDDEN inventing times or line lists.",
    "BUS WATCH: «תזכירי לי 10 דקות לפני שקו 51 מגיע לתחנת X לכיוון Y» → Self-nudge + reminders { compose:true, text:brief or empty, compose_condition:{type:\"bus_eta\",origin,destination,line,headsign?,minutes_before:10}, every_count:2, every_unit:\"minutes\" }. Missing destination → ask; no clock. Server polls Google Routes ETA periodically (NOT MOT SIRI live); quiet-skip until ETA ≤ N and on transient poll failures; after repeated poll failures the server sends one honesty notice (no invented ETA) then quiet again — NOT continuous realtime monitoring; FORBIDDEN claiming live stream tracking. Sub-hour refuse does NOT apply to bus_eta.",
    "FLIGHTS (live AviationStack, default TLV/נתב״ג): «איזה טיסות אל על לפריז מחר» → metadata.flights { airport:\"\"|TLV, direction:\"departures\", airline:\"אל על\", city:\"פריז\", date:YYYY-MM-DD, aspects:[board] }. «מתי נוחתת הקרובה מרומא» → flights { direction:\"arrivals\", city:\"רומא\", aspects:[next] }. «איזה טיסות נוחתות בחצי שעה» → flights { direction:\"arrivals\", within_minutes:30, aspects:[board] }. «נחיתות אחרי 19:00» → { direction:\"arrivals\", time_from:\"19:00\", aspects:[board] }; «בין 8 ל־10» → time_from+time_to HH:mm Jerusalem; «לפני 22:00» → time_to. «נחיתות של חברות אירופאיות» → direction arrivals + airlines:[concrete IATA/names from world knowledge] (e.g. LH,AF,BA,KL,LX,OS,AZ,IB,SN,TP,AY,SK,DY,EW,U2,FR,W6,A3,RO,BT,JU,…) — FORBIDDEN asking «איזו חברה» when the region/group is clear; server ORs airlines client-side; require_live_select:false when airlines[] fully expresses the group. LIVE CAPABILITY (F/Q/V/U): F → airline/airlines/city/flight/date/within_minutes/time_from/time_to/direction; Q → only AviationStack-supported search params (date is client-side filter); V → residual semantic when board fields (airline/status/gate/times/city) evidence the ask → require_live_select:true; U → cannot verify from API (e.g. «טיסה נוחה» / seat comfort) — disclose, never Stage B for U alone; continue with useful F/Q/V or explain before fetch if blocked. Distinguish no-match vs unable-to-verify. «מתי נוחתת טיסה מספר 3242CXD» → flights { flight:\"3242CXD\", direction:\"arrivals\", aspects:[summary] } — flight AS SPOKEN. Pure ask → responses may be empty; server fills. WITH ack → ack only; server appends board as 2nd message. FORBIDDEN inventing times/gates/status. Missing needed filter → ask; flights=null.",
    "FLIGHT ETA WATCH: «תודיעי לי 30 דקות לפני ההמראה של LY831» → Self-nudge + reminders { compose:true, compose_condition:{type:\"flight_eta\",airport:\"TLV\",direction:\"departures\",flight:\"LY831\",minutes_before:30,hours_before:0}, every_count:2–5, every_unit:\"minutes\", watch_once:true }. «30 שעות לפני שהטיסה נוחתת» → direction:\"arrivals\", hours_before:30 (or minutes_before:1800), interval 15 minutes. Missing flight (and no airline+city) → ask; no clock. Server quiet-skips until ETA ≤ threshold. Sub-hour refuse waived for flight_eta.",
    "FLIGHT CHANGED WATCH: «תעדכני אם יש שינויים בטיסה שלי LY831» → Self-nudge + reminders { compose:true, compose_condition:{type:\"flight_changed\",airport:\"TLV\",direction:\"arrivals\"|\"departures\",flight:\"LY831\"}, recurrence:{freq:\"interval\",interval:5,unit:\"minutes\"}, watch_once:false } + same-turn flights sample + ack. Server fingerprints status/delay/gate/times; baseline on create; send when fp changes. Sub-hour refuse waived.",
    "Ambiguous words: if a request hinges on a Hebrew word with several common senses (e.g. עדות = ethnic communities / אשכנזי־ספרדי vs courtroom testimony), ASK which meaning before saving. Do not assume בית משפט. For בדיחות על עדות without משפט/בית משפט, prefer ethnic communities or ask.",
    "Reminder item is an infinitive: להתאמן, לקנות חלב. Never claim saved unless reminders has add/update with a clock (new) or update of an existing clock (text/time).",
    "Before lists add reminders: only if this turn's active_reminders already has the SAME work by meaning, ASK מצאתי תזכורת קיימת ל«…». לעדכן אותה או להוסיף עוד אחת? Same time or the same every-N cadence alone is never a match (בדיחה על עדות כל שעה ≠ חביתה כל שעה → just add both). Unrelated clocks never trigger that ask. Do not invent that one exists. Empty reminders while asking.",
    "RELATED TO THESE items (קשורות למשימות האלה / לפריטים שמחקנו): answer only active clocks that match those items by meaning. If none, say none. Never list unrelated active clocks. Never invent past deletes or completed history — the system does not load it.",
    "Ask until the reminder schema is complete. Empty reminders while you ask. date empty or YYYY-MM-DD.",
    "RECURRING CLOCK → reminders[].recurrence {freq, interval, unit, weekdays, month_day, month, time, until, count}; leave every_count/every_unit/weekdays empty. freq: interval (every N minutes/hours) | daily | weekly (weekdays 0=Sun … 6=Sat) | monthly (month_day) | yearly (month + month_day). Minimum repeat is every 5 minutes — ALLOWED: «כל 5 דקות» / «כל N דקות» (N≥5) → Self-nudge NOW with recurrence {freq:\"interval\",interval:N,unit:\"minutes\"}; «כל שעה» / «כל N שעות» (N≥1) → unit:\"hours\". FORBIDDEN: refuse text when they said כל 5 דקות / כל שעה / שעתיים. Refuse ONLY too-fast («כל דקה» / «כל 2 דקות» / «כל 4 דקות» / seconds) → no actions, answer «אי אפשר לקבוע חזרה כל פחות מ־5 דקות או בשניות. הכי תכוף שאפשר הוא כל 5 דקות.» (a one-time «בעוד 10 דקות» is fine; «כל חצי שעה» = 30 minutes OK). «עד שאקנה» with no calendar end → open-ended hourly (no until). daily/weekly/monthly/yearly need time HH:mm — missing → ask באיזו שעה? with reminders empty. until = inclusive last day YYYY-MM-DD from SESSION_CLOCK calendar (עד סוף החודש → last day of this month; עד דצמבר → Dec 31). count = total sends including the first. A stated start (החל מעוד 10 ימים / החל מ־23.10 / מהשבוע הבא) → YYYY-MM-DD from calendar in reminders[].date (standing task: lists item recurrence.start) — never drop it. Every-N rule (interval > 1) with no start → ask which occurrence is first.",
    "Examples: «תזכירי לי כל 5 דקות לשתות מים» → Self-nudge + reminders interval 5 minutes — save NOW. «תזכירי לי כל שעה לקנות חלב עד שאקנה» → shopping add + לוסי להזכיר + reminders interval 1 hours — save NOW, never refuse. «כל ראשון, שלישי וחמישי ב־8:00 תזכירי לי לקחת כדור» → {freq:\"weekly\",interval:1,weekdays:[0,2,4],time:\"08:00\"}. «כל 1 לחודש ב־9 לשלם ארנונה» → {freq:\"monthly\",interval:1,month_day:1,time:\"09:00\"}. «כל יום ב־20:00 עד סוף החודש» → {freq:\"daily\",interval:1,time:\"20:00\",until:\"<last day of this month>\"}. «כל יום ב־8 תשלחי לי את המשימות שלי» → compose:true, compose_source:\"saved_data\", ping=speaker, text=«מה המשימות שלי היום», recurrence {freq:\"daily\",interval:1,time:\"08:00\"}.",
    "YEARLY OFFER: yearly facts (יום הולדת / נישואין / אזכרה / מנוי שנתי) — offer first; on כן (+ time) birthday of a Known employee is an all-day yearly tasks event + linked reminder (ping=speaker, about=[that person]); FORBIDDEN reminders-only yearly birthday. «גם יום לפני» → event stays on birthday day; ping fires day before. No person → tasks all-day + reminder, about=[].",
    "STANDING TASK WITH TIME — CLOCK OFFER: «אני צריך לקחת סירופ כל 3 ימים ב־12:00» without תזכירי לי → THIS turn lists standing only (no reminders clock), confirm, then OFFER a WhatsApp reminder on the same recurrence. On כן → lists add reminders same recurrence (or a different ping time they named) + your להזכיר task with שעה לביצוע = standing chore time (not the ping if different); no second speaker standing row; FORBIDDEN lists.update standing time to the ping (APPOINTMENT VS PING). Skip offer if all-day (no recurrence.time) or they already said תזכירי לי / שתזכירו לי (full self-nudge now). Later move of that standing series → STANDING + LINKED CLOCK MOVE ASK (not auto-cascade). Ambiguous cancel after a ping → STANDING + LINKED CLOCK DELETE ASK.",
    "Delete reminder / STOP SERIES: lists remove reminders with reminder_id from this turn's active_reminders when the named series is unique (see STOP SERIES CLOCK CANCEL). Server applies immediately — no confirm step. Past-tense response naming them. Blanket stop-all with no named series → ASK; empty reminders. Never lists.remove for a stop-clock ask.",
    "BY LINE NUMBER: follow system BY LINE NUMBER / DECISION & FOCUS — LAST_NUMBERED_DUMP or dump-line stem → ACTION; after תיוקים dump line N = that filing; FORBIDDEN show_dump on line-index turns; FORBIDDEN JSON array index vs dump title; AFTER a dump «ל3» is a line index not 03:00. Examples: תמחק את 3 → unique → remove NOW; ambiguous → ASK; שתף 1,2 עם מיכל → update×2 with dump ids + targets:[speaker, מיכל].",
    "Delete many / bulk-clear (A1 — system BULK/DELETE): count matching shells for that list_type in THIS turn's facts. Exactly ONE unambiguous relevant shell (personal OR one shared/named) → lists.remove NOW only item_ids in THAT shell; past tense; FORBIDDEN expanding to other shells/list_types/related entities. ≥2 shells → ASK which (personal vs shared/title); lists=[] until pick; then remove only chosen shell. Never lists=[] when exactly one matching shell has rows. FORBIDDEN wiping unrelated custom lists or other people's lists.",
    "WHOLE-LIST DELETE («מחקי רשימ(ה/ות)…» / «כל רשימות המשתתפים» / naming list titles as lists): each explicitly named list with a unique list_id → one lists delete_list NOW per list — never lists.remove. A name with several possible matches, unresolved list, or unclear scope → ASK; lists=[]. Contrast: emptying built-in rows («כל המשימות/הפריטים») → lists.remove per item_id — never wipe unrelated custom lists.",
    "DELETE BY DAY: תמחקי את הפגישה / המשימה ביום חמישי / מחר / ביום X → from this turn's EMPLOYEE_SAVED_DATA tasks whose תאריך לביצוע is that day (SESSION_CLOCK), lists.remove list_type tasks with that row's item_id (never omit) plus the EXACT שם משימה. Never lists=[] + «לא מצאתי» when such a row is present. Several that day → ASK which (exact titles). Shared twins → every matching item_id. A multi-day row (תאריך לביצוע … תאריך סיום) counts for every day in its span.",
    "RANGES IN ANSWERS: a row with שעת סיום (or a standing occurrence with end_time) shows as «10:00–12:00», never only the start. A multi-day row (תאריך לביצוע … תאריך סיום) matches EVERY day inside its span — «מה יש לי ביום רביעי» lists «בחו\"ל (שלישי–חמישי)». Scan spans before «אין לך…».",
    "MUTATE BY ID: lists/filing/reminders/directory remove|update need item_id / filing_id / reminder_id / contact_id from THIS turn. DELETE WHEN CLEAR (rows): unique target → remove NOW with item_id; responses: a non-empty past-tense confirmation naming what was deleted; FORBIDDEN empty responses; FORBIDDEN alter_list/delete_list for a single item (those are only for the whole list); FORBIDDEN same-turn jobs.answer; FORBIDDEN «האם מאשר?» when the target is unique. ASK WHEN UNCLEAR (≥2 candidates / which domain / מחק הכל) → delete mutates empty; one responses entry; FORBIDDEN a raise. WHOLE-LIST: each explicitly named list with unique list_id → delete_list NOW (one per list); a name with several matches or unresolved → ASK, lists=[]. Update with id applies immediately. Never invent or speak ids.",
    "CLEAR ALL CONTACTS / PHONE BOOK: «תמחקי את כל אנשי הקשר» / «מחק את כל ספר הטלפונים» → ASK first (which domain / confirm wipe); directory=[] lists=[]. If SPEAKER_CONTACTS has rows this turn, FORBIDDEN claiming the book is empty — ask whether they meant ספר הטלפונים (name that contacts exist). Never wipe-all without a clarifying ask.",
    "Speaker still needs → EMPLOYEE_SAVED_DATA lists. Your tasks / your reminder jobs (להזכיר ל…) → WORKER_SAVED_DATA (+ OPEN_JOBS). Ping clocks only → active_reminders. Empty clocks ≠ you have no work. Never emit metadata.query.",
    "LIST ITEM URGENCY: on lists add/update set item urgency = normal | urgent | very_urgent by MEANING (same as messages) — never ask. normal by default; urgent when they stress it (דחוף / בהקדם); very_urgent when hard (ממש דחוף / דחוף מאוד / מיד). Clean title without urgency words. Shopping/tasks/contacts/custom alike.",
    "URGENCY IN RESPONSE: when a saved item has urgency (urgent / very_urgent — normal is omitted from EMPLOYEE_SAVED_DATA), wrap that entire numbered line in guillemets so the whole row is bold. urgent → «1. לשתות מים מחר». very_urgent → the same wrap plus ‼️ after the closing guillemet: «1. לשתות מים מחר» ‼️. 📎 and «(תזכורת: …)» stay inside the wrap. FORBIDDEN: the words דחוף / דחוף מאוד on the line. Never wrap or mark normal/missing. מה יש לי דחוף / מה דחוף → metadata.show_dump=tasks (or full) + show_dump_urgency=urgent; lists=[]; server replaces.",
    "Status / דוח / what someone needs to buy or do / show a list: LIVE DATA ONLY — never resurrect titles from earlier chat after a delete. Bare «מה יש לי» / «הציגי הכל» / סיכום מלא / כל מה ששמור → metadata.show_dump=full; lists=[]; server replaces response (FORBIDDEN model-written overview; shopping COUNTS + tasks detail + phone book). SHAREABLE STATUS ASK / ABOUT X / «הצג רשימת משימות|קניות»: metadata.show_dump = shopping|tasks|…; one flat dump header + row marks (co-share (A, B); assign (באחריות X · מאת Y)); filings two-section; about X = speaker↔X co-share. Current field values only — never dump שם חדש / update drafts. Inventory dump lines are server-owned — do not bold them. On confirms, bold only the item title with a single WhatsApp pair *title* (never **, never wrap «שם:»). Urgency: wrap the whole item line in «…»; very_urgent also appends ‼️ after the closing guillemet. FORBIDDEN to write דחוף / דחוף מאוד on that line. Shared lists: use scope/shared_with. Custom list titles follow LIST NAME MATCH. APPLY FEEDBACK: name object+list after mutates.",
    "Answer in your response from this turn's saved data. The server does not write that answer — except known false delivery / list-type wording fixes. It does not append a mutation summary.",
    "After any save/send/remove, state clearly in response what you did — that text is what the user sees.",
    "If the speaker says they bought or already have a shopping item, remove it from shopping. Finished chore / past-tense Done (סיימתי / הלכתי / שתיתי / לקחתי / סידרתי / tap «סמן כבוצע: <title>» / bare «סמן כבוצע» right after RECENT_OUTBOUND): look up THIS turn's EMPLOYEE_SAVED_DATA + active_reminders. Unique active interval-habit clock (recurrence.freq=interval / every-N) matching that title → short ack ONLY; lists=[] reminders=[] — FORBIDDEN lists.remove / reminders.remove (series stays). Unique one-off task/shopping → lists.remove that item_id (cascade linked one-shot). Standing חוזר/next_occurrences → occurrence_done (not remove). Several matches → ASK; empty mutates. Mark-done button = same path. FORBIDDEN treating Mark-done as Option B snooze (נדנדי לי / לשלוח נדנוד / reminders.add one-shot / REMINDER_SNOOZE). Never call a tasks item תזכורת בוואטסאפ.",
    "STANDING TASK DONE: if that task row has חוזר / next_occurrences, «סיימתי / עשיתי / הלכתי» OR «סמן כבוצע: <that title>» means done for THIS occurrence — never lists.remove (it would delete the whole series and its clock). Emit lists.update list_type tasks with that item_id and occurrence_done = YYYY-MM-DD of the occurrence they did (true = today; «הלכתי אתמול» → yesterday from calendar); nothing else on the item. Response: acknowledge and name the next occurrence AFTER that day from next_occurrences. done_dates on the row = already marked; do not list those occurrences again. lists.remove only on an explicit delete of the standing task («תמחקי את המשימה», «אני כבר לא הולך»). Unclear → ask whether they finished this occurrence or want the standing task deleted, with lists empty. Tasks without חוזר: remove as usual.",
    "STANDING TASK — ONE DATE CHANGED: cancelling or moving a single occurrence («ב־23.10 אני לא צריך לאסוף» / «ב־23.10 לאסוף ב־11:00») → lists.update list_type tasks with that item_id and occurrence_change { date: YYYY-MM-DD (one of next_occurrences), cancel: true } or { date, time: \"HH:mm\" }; nothing else on the item. A linked repeating clock for the same work → same turn lists update reminders with its reminder_id and the same occurrence_change. Never occurrence_done, lists.remove, a recurrence change, or a new one-off task for this. Only that date vs. every week unclear → ask whether the change is only for that date or for every <weekday>, naming both, with lists empty. Response names the date and that the other occurrences stay.",
    "list_type: shopping = things to buy (לקנות חלב). tasks = work to do (להכין חביתה, לשתות מים, לקחת ילדים). On remove/update, match the list_type of the saved row in EMPLOYEE_SAVED_DATA. response must say משימות for tasks and קניות for shopping.",
    "PERSONAL TASK DEFAULT: «תוסיפי לי משימה» / «משימה ל…» / «לטפל ב…» without naming a custom list → list_type tasks, list_name empty, targets [] (built-in personal משימות). Detail/פירוט stays on that personal item. FORBIDDEN: dumping it onto a shared custom list like משימות לעבודה just because it exists or sounds work-related — only when they explicitly named that list. Also FORBIDDEN: saving chat/meta/bug commentary as a list row.",
    "NAMED LIST MUTATE: when they name a list (לרשימת X / במשימות לעבודה), add/update/remove on list_type custom + that list_name from EMPLOYEE_SAVED_DATA — personal or shared. Guests still cannot mutate. Do not refuse because shared; do not switch to built-in tasks/shopping.",
    "LIST NAME MATCH (custom / titled lists only): resolve against THIS turn's EMPLOYEE_SAVED_DATA list_name (personal or shared). Built-in קניות/משימות/אנשי קשר → fixed list_type, list_name \"\" unless they named a custom title. Match by MEANING — the speaker need not repeat the exact title; an exact title or a description that fits («הרשימה של ערב הפוקר») both refer to a list. (1) ONE clearly matching list → mutate NOW, no confirm. (2) TWO OR MORE plausible lists (e.g. spoken token in ≥2 titles: באגים / באגים לקוד; two poker-evening lists) → lists=[] and ASK which as NUMBERED 1. 2. 3. (3) No sufficiently clear match → lists=[] and ASK — never guess. For (2)/(3) list the candidates as NUMBERED 1. 2. 3. (exact list_name; personal vs משותפת עם X); never pick first/shared/looks-like. Example shape: a short question asking which list they meant, then «1. באגים» / «2. באגים לקוד (משותפת עם עמית)». After they answer with the title OR a line index («2» / «ל2») → map to the LAST list-pick ask line → exact list_name from EMPLOYEE_SAVED_DATA. Out-of-range index → re-ask; FORBIDDEN inventing numbers. FORBIDDEN: inventing list_name or picking by topic alone — a topic that refers to no list («הוסיפי באג») is not a list description (TOPIC-ONLY handling). Server will not fix a wrong list_name.",
    "SPEAKER_ADDRESS (this turn's fact block): always conjugate second-person Hebrew to gender male|female. If gender: unknown → do what this turn asks FIRST (every complete ACTION — lists / reminders / filing / messages / show_dump — emitted THIS turn, reply phrased gender-neutrally), then you may ask once how they would like to be addressed (male or female) as a separate LAST responses entry (skip while another question of yours is open); on answer → filing add «לשון פנייה» (item_info זכר/נקבה) — the server stores address gender for next turns. FORBIDDEN: empty actions or deferring any complete same-turn action (a durable filing/save such as «תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב», a reminder on an existing task such as «תזכירי לי מחר ב־09:00 על התור לווטרינר», anything) until gender is answered, and FORBIDDEN asking about the request itself because gender is unknown. Never ignore SPEAKER_ADDRESS.",
    "Durable personal memory — file with lists add list_type filing in the same turn (do not only say אזכור): לשון פנייה/מגדר, משפחה, כתובת/עיר (street+city without the word כתובת still counts — רחוב שחם פתח תקוה), מצב משפחתי, השכלה, מקצוע, מקום עבודה, pets/school (health incl. allergies / diet → SENSITIVE: consent first). SAVE VERB (תייקי/תתייקי/תשמרי/תצרפי — text and/or files): follow ATTACHMENTS DESTINATION LADDER — unique custom list_name defaults to ITEM attach (ask which item if unclear; list shell only when explicitly «לרשימה עצמה» / «ברמת הרשימה»); filings only when «לתיוקים» / «תחת…» / «כ…»; FORBIDDEN filing only because «תייקי». LIST NAME MATCH on named lists. TOPIC-ONLY / NO LIST NAMED («הוסיפי באג: …» / «תשמרי את הבאג»): lists=[] — if ≥2 list_names contain באג/באגים → ASK which as NUMBERED 1. 2. 3. candidates (they may reply with the index); else ASK filings/shopping/tasks/named list. FORBIDDEN auto-picking a באגים* list by topic. Do NOT auto-file soft plans. Put detail in item_info (product תיאור); item_description = optional find-helper (מידע לחיפוש) after ANY code/ID/doc/car-number/gate-code/ת.ז/file filing when description empty (bare «מספר הרכב 703…» counts — not only תתייק); never after soft auto-memory (לשון פנייה/משפחה/כתובת…). Find filings by name+info+description. מה התיוקים שלי → explicit saves; מה את זוכרת עלי → memory. Prefer SPEAKER_ADDRESS for address gender.",
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

/** Exported for the LIVE_FULL production-path runner (seeded dump); unchanged. */
export async function getOrCreateConversation(
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
  _register?: LlmMetadata["register"],
): unknown {
  return value;
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
        whatsappComposeUrl:
          parsed.responseBubbles[0]?.whatsappComposeUrl ?? null,
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
  /** Files on bubble 1 (metadata.send_attachments / item dump). */
  attachments?: ChatAttachmentRef[];
  /**
   * Optional attachments per bubble index (0 = first). Merged with
   * `attachments` on index 0. Used for celebration image on bubble 2+.
   */
  bubbleAttachments?: Array<ChatAttachmentRef[] | undefined>;
  /** Emoji reaction on the speaker's message (metadata.show_icon). */
  showIcon?: string;
  /** Line map from this turn's show_dump REPLACE (for next-turn BY LINE). */
  lastNumberedDump?: LastNumberedDumpLine[];
  /**
   * Free-written numbered inventory this turn (no show_dump) → tombstone so the
   * loader does not fall back to an older shopping/tasks map.
   */
  clearLastNumberedDump?: boolean;
  /** Successful Google A?B trip board (omit to preserve prior on dump-only writes). */
  lastRoutesBoard?: LastRoutesBoard;
  /** Successful live place use (omit to preserve prior on dump-only writes). */
  lastLiveLocation?: LastLiveLocation;
}): Promise<ChatTurnMessageIds> {
  const bubbles =
    input.bubbles.length > 0 ? input.bubbles : [{ text: "" }];
  const [first, ...rest] = bubbles;
  const firstButtons = first?.buttons ?? [];
  const firstNavigate = first?.navigateAddress ?? null;
  const firstComposeUrl = first?.whatsappComposeUrl ?? null;
  const showIcon = input.showIcon?.trim() || null;
  const attachmentsFor = (index: number): ChatAttachmentRef[] => {
    const fromMap = input.bubbleAttachments?.[index] ?? [];
    if (index === 0) {
      return [...(input.attachments ?? []), ...fromMap];
    }
    return fromMap;
  };
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
  const hasFreshDump =
    input.lastNumberedDump != null && input.lastNumberedDump.length > 0;
  const clearDump = !hasFreshDump && input.clearLastNumberedDump === true;
  const dumpLines = hasFreshDump
    ? input.lastNumberedDump
    : clearDump
      ? []
      : unpacked.lastNumberedDump;
  const boardToStore =
    input.lastRoutesBoard !== undefined
      ? input.lastRoutesBoard
      : unpacked.lastRoutesBoard;
  const liveLocToStore =
    input.lastLiveLocation !== undefined
      ? input.lastLiveLocation
      : unpacked.lastLiveLocation;
  const shouldRewriteRaw =
    hasFreshDump ||
    clearDump ||
    input.lastRoutesBoard != null ||
    input.lastLiveLocation != null;
  const nextRaw = shouldRewriteRaw
    ? packStoredLlmRaw(
        unpacked.request,
        unpacked.response,
        dumpLines,
        boardToStore,
        clearDump,
        liveLocToStore,
      )
    : existingAssistant?.raw;
  const firstAttachments = attachmentsFor(0);
  await prisma.chatMessage.update({
    where: { id: input.saved.assistant },
    data: {
      text: first?.text ?? "",
      actions: Prisma.JsonNull,
      buttons:
        firstButtons.length > 0 ? toJsonValue(firstButtons) : Prisma.JsonNull,
      navigateAddress: firstNavigate,
      whatsappComposeUrl: firstComposeUrl,
      ...(firstAttachments.length
        ? { attachments: toJsonValue(firstAttachments) }
        : {}),
      ...(shouldRewriteRaw ? { raw: toJsonValue(nextRaw) } : {}),
    },
  });
  const extra = rest.map((bubble, index) => {
    const entryButtons = bubble.buttons ?? [];
    const bubbleFiles = attachmentsFor(index + 1);
    return {
      id: randomUUID(),
      conversationId: input.conversationId,
      author: "assistant" as const,
      speaker: input.assistantSpeaker,
      text: bubble.text,
      actions: Prisma.JsonNull,
      buttons:
        entryButtons.length > 0 ? toJsonValue(entryButtons) : Prisma.JsonNull,
      navigateAddress: bubble.navigateAddress ?? null,
      whatsappComposeUrl: bubble.whatsappComposeUrl ?? null,
      ...(bubbleFiles.length
        ? { attachments: toJsonValue(bubbleFiles) }
        : {}),
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

/**
 * Server-sent assistant message on the speaker's thread (stored + remembered in
 * the model conversation). Exported for the LIVE_FULL production-path runner
 * (automated-message turns); unchanged.
 */
export async function pushRelayMessage(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  speaker: string;
  text: string;
}): Promise<ChatThreadNotification> {
  const targetUserId =
    (await getEmployeeUserId(input.employeeId)) ?? input.userId;
  const digitalEmployeeId =
    targetUserId === input.userId
      ? input.digitalEmployeeId
      : ((await getProtectedLucyIdForUser(targetUserId)) ??
        input.digitalEmployeeId);
  const conversation = await getOrCreateConversation(
    targetUserId,
    input.employeeId,
    digitalEmployeeId,
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
    digitalEmployeeId,
    message,
    raw,
  };
  publishChatEvent(
    targetUserId,
    input.employeeId,
    digitalEmployeeId,
    notification,
  );
  return notification;
}

/** Exported for the LIVE_FULL production-path runner (seeded dump); unchanged. */
export async function saveAssistantMessage(input: {
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
  // Cross-account partners get the notice on their own User + Lucy thread.
  const targetUserId =
    (await getEmployeeUserId(input.target.id)) ?? input.userId;
  const digitalEmployeeId =
    targetUserId === input.userId
      ? input.digitalEmployeeId
      : ((await getProtectedLucyIdForUser(targetUserId)) ??
        input.digitalEmployeeId);
  const conversation = await getOrCreateConversation(
    targetUserId,
    input.target.id,
    digitalEmployeeId,
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
    digitalEmployeeId,
    message,
    raw,
  };
  publishChatEvent(
    targetUserId,
    input.target.id,
    digitalEmployeeId,
    notification,
  );
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

async function loadConversationWithMessages(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
) {
  return prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: {
        userId,
        employeeId,
        digitalEmployeeId,
      },
    },
    include: {
      messages: {
        orderBy: [{ createdAt: "asc" }, { author: "desc" }],
      },
    },
  });
}

/**
 * When viewing לוסי, also include same-speaker לוסי-אורח onboarding messages
 * so host web Chat With Lucy shows pre-registration WhatsApp history.
 */
export async function getChatHistory(
  userId: string,
  employeeId: string,
  digitalEmployeeId?: string,
): Promise<ChatHistoryResponse> {
  await getEmployeeForUser(userId, employeeId);
  const digital = await requireDigitalChatPartner(userId, digitalEmployeeId);

  const conversation = await loadConversationWithMessages(
    userId,
    employeeId,
    digital.id,
  );

  if (conversation) {
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
  }

  const mergeGuestLucy =
    isProtectedEmployee(digital) && !isGuestLucy(digital);
  let guestLucyMessages: ChatMessageRow[] = [];
  if (mergeGuestLucy) {
    const guestLucy = await prisma.employee.findFirst({
      where: {
        userId,
        kind: "digital",
        OR: [{ name: GUEST_LUCY_NAME }, { nickname: GUEST_LUCY_NAME }],
      },
      select: { id: true },
    });
    if (guestLucy && guestLucy.id !== digital.id) {
      const guestConvo = await loadConversationWithMessages(
        userId,
        employeeId,
        guestLucy.id,
      );
      if (guestConvo && !isIdleSince(
        guestConvo.messages.at(-1)?.createdAt ?? guestConvo.updatedAt,
      )) {
        guestLucyMessages = guestConvo.messages;
      }
    }
  }

  if (!conversation && guestLucyMessages.length === 0) {
    return emptyHistory(employeeId, null, null, digital.id);
  }

  if (!conversation) {
    const history = toHistoryResponse(employeeId, {
      digitalEmployeeId: digital.id,
      openaiConversationId: "pending",
      updatedAt: guestLucyMessages.at(-1)?.createdAt ?? new Date(),
      messages: guestLucyMessages,
    });
    return { ...history, conversationId: null };
  }

  if (guestLucyMessages.length === 0) {
    return toHistoryResponse(employeeId, conversation);
  }

  const seen = new Set(conversation.messages.map((row) => row.id));
  const merged = [
    ...guestLucyMessages.filter((row) => !seen.has(row.id)),
    ...conversation.messages,
  ].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    // Match DB order: author desc as secondary when timestamps tie.
    return b.author.localeCompare(a.author);
  });

  return toHistoryResponse(employeeId, {
    digitalEmployeeId: digital.id,
    openaiConversationId: conversation.openaiConversationId,
    updatedAt: conversation.updatedAt,
    messages: merged,
  });
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

/** Already-loaded per-turn context sources (production loaders fill them). */
export interface TurnContextParts {
  guestSpeaker: boolean;
  consultFrom: boolean;
  viewerId: string;
  addressGender: Parameters<typeof formatSpeakerAddressContext>[0];
  speakerSnapshot: EmployeeRecordSnapshot;
  workerSnapshot: EmployeeRecordSnapshot | null;
  speakerContacts: Parameters<typeof formatSpeakerContacts>[0];
  contactBookShare: Parameters<typeof formatSpeakerContacts>[1];
  teamSchedules: Parameters<typeof formatTeamSchedules>[0];
  recentOutbound: Parameters<typeof formatRecentOutboundContext>[0];
  openJobs: Parameters<typeof formatOpenJobsContext>[0];
  lastNumberedDump: Parameters<typeof formatLastNumberedDumpContext>[0];
  pendingAttachments: Parameters<typeof formatPendingAttachmentsContext>[0];
  pendingLocation: Parameters<typeof formatPendingLocationContext>[0];
  lastLiveLocation: Parameters<typeof formatLastLiveLocationContext>[0];
  pendingInvite: Parameters<typeof formatPendingInviteContext>[0] | null;
  tipsContext: string;
  /**
   * Stage 2: the fixed SESSION_CLOCK / SAVED_DATA reading rules ride in the
   * system instructions (FACTS RULES), so the facts blocks carry data only.
   * Set only when buildLucyInstructions attaches the Lucy engine.
   */
  rulesInInstructions?: boolean;
}

/**
 * The live facts block sent ahead of the speaker's message each turn — one
 * composer (order + guest/consult gating) shared by sendChatMessage and the
 * LIVE_FULL eval harness so the two can never drift.
 */
export function composeTurnContext(parts: TurnContextParts): string {
  const guest = parts.guestSpeaker;
  const factsOnly = { rulesInInstructions: parts.rulesInInstructions === true };
  return [
    formatSessionClockContext(undefined, factsOnly),
    guest ? "" : formatSpeakerAddressContext(parts.addressGender),
    formatEmployeeContext(parts.speakerSnapshot, "EMPLOYEE_SAVED_DATA", factsOnly),
    guest || !parts.workerSnapshot
      ? ""
      : formatEmployeeContext(parts.workerSnapshot, "WORKER_SAVED_DATA", factsOnly),
    guest
      ? ""
      : formatSpeakerContacts(parts.speakerContacts, parts.contactBookShare),
    guest ? "" : formatTeamSchedules(parts.teamSchedules),
    guest ? "" : formatRecentOutboundContext(parts.recentOutbound),
    guest ? "" : formatOpenJobsContext(parts.openJobs, parts.viewerId),
    guest ? "" : formatLastNumberedDumpContext(parts.lastNumberedDump),
    guest || parts.consultFrom
      ? ""
      : formatPendingAttachmentsContext(parts.pendingAttachments),
    guest ? "" : formatPendingLocationContext(parts.pendingLocation),
    guest ? "" : formatLastLiveLocationContext(parts.lastLiveLocation),
    parts.pendingInvite ? formatPendingInviteContext(parts.pendingInvite) : "",
    parts.tipsContext,
  ]
    .filter(Boolean)
    .join("\n\n");
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
  /** Cold invite context for לוסי-אורח (register-first check-with). */
  pendingInvite?: PendingInviteContext;
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
  const externalPartners = guestSpeaker
    ? []
    : await resolveExternalSharePartners(
        speakerContacts,
        new Set(humans.map((row) => row.id)),
      );
  const humansForPlan = [...humans, ...externalPartners];
  const contactBookShare = guestSpeaker
    ? null
    : await getContactBookShare(input.employeeId);
  const recentOutbound = guestSpeaker
    ? []
    : await listRecentReminderOutbounds({
        userId: input.userId,
        employeeId: input.employeeId,
      });
  if (
    conversation.needsContext &&
    !guestSpeaker &&
    !consultFrom &&
    isLucyDigital(digital)
  ) {
    await withoutFailingTurn("overdue_job_failed", async () => {
      const overdue = await listOverdueTasksForSpeaker(input.employeeId);
      if (overdue.length > 0) {
        await ensureOverdueTasksJob({
          userId: input.userId,
          digitalEmployeeId: digital.id,
          speaker: { id: input.employeeId, name: speaker },
          overdue,
        });
        return;
      }
      const stale = await listStaleUndatedTasksForSpeaker(input.employeeId);
      await ensureStaleUndatedTasksJob({
        userId: input.userId,
        digitalEmployeeId: digital.id,
        speaker: { id: input.employeeId, name: speaker },
        stale,
      });
    });
  }
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
  const lastLiveLocationCtx = guestSpeaker
    ? null
    : await loadLastLiveLocationForConversation(conversation.id);
  // Same snapshots injected into EMPLOYEE_SAVED_DATA / WORKER_SAVED_DATA — reused
  // later for stage-2 saved_data membership (thisTurnVisibleRefs), not a fresh DB exists check.
  const speakerSnapshot = await withAttachmentRefsSafe(
    await getEmployeeRecordSnapshot(input.employeeId),
  );
  const workerSnapshot = guestSpeaker
    ? null
    : await withAttachmentRefsSafe(
        await getEmployeeRecordSnapshot(digital.id, {
          scopeItemsToViewerId: input.employeeId,
        }),
      );
  const pendingAttachments =
    guestSpeaker || consultFrom
      ? []
      : (
          (await withoutFailingTurn("attachments_pending_failed", () =>
            listPendingAttachments(input.employeeId),
          )) ?? []
        ).filter(
          (fact) =>
            !input.attachments?.facts.some(
              (fresh) => fresh.attachment_id === fact.attachment_id,
            ),
        );
  const tipsContext =
    (await withoutFailingTurn("tips_context_failed", () =>
      formatAvailableTipsContext({
        userId: input.userId,
        speaker: employee,
        digitalEmployeeId: digital.id,
      }),
    )) ?? "";
  const context = composeTurnContext({
    guestSpeaker,
    consultFrom: Boolean(consultFrom),
    viewerId: input.employeeId,
    addressGender: employee.addressGender,
    speakerSnapshot,
    workerSnapshot,
    speakerContacts,
    contactBookShare,
    teamSchedules: guestSpeaker ? [] : await getTeamSchedules(input.employeeId),
    recentOutbound,
    openJobs,
    lastNumberedDump,
    pendingAttachments,
    pendingLocation: guestSpeaker ? null : getPendingLocation(input.employeeId),
    lastLiveLocation: lastLiveLocationCtx,
    pendingInvite: input.pendingInvite ?? null,
    tipsContext,
    rulesInInstructions: shouldAttachLucyRuntimeEngine(
      digital,
      employees,
      loadLlmConfig().systemMessage,
    ),
  });
  const instructions = buildLucyInstructions({
    digital,
    employees,
    speaker,
    speakerIsOwner: employee.isOwner === true,
    guestSpeaker,
    pendingInvite: input.pendingInvite ?? null,
    consultFrom,
  });
  // Live facts go to the model for THIS turn only (llm-client sends them ahead
  // of the message and stores just the message): the model conversation keeps
  // what was said, never one stale facts snapshot per earlier turn.
  const liveFacts = context;
  const message = [
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
      liveFacts,
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
        liveFacts,
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
        liveFacts,
        model: config.model,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        instructions,
        textFormat: config.responseFormat,
      });
      turn = await client.createResponse({
        conversationId: conversation.openaiConversationId,
        message,
        liveFacts,
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
    // Closed show commands (opaque equality): button «הצג רשימת X» plus free-typed
    // aliases («הצג X» / «הצג רשימת X» when that custom list exists). Synthesize show_dump
    // so LAST_NUMBERED_DUMP refreshes even if the model free-wrote inventory.
    // Unmatched free-form still requires model-emitted show_dump.
    // N1 item-open taps (opaque item reference) always win over the model's
    // own reading of the tap — the reference is the authoritative target.
    if (
      !(metadata.showDump?.trim() ?? "") ||
      parseItemNavRef(stripWhatsAppReplyPrefix(input.message)) !== null
    ) {
      const buttonText = stripWhatsAppReplyPrefix(input.message);
      // N1 item-open taps resolve custom-list rows from the live snapshot.
      let buttonDump = parseItemNavRef(buttonText)
        ? null
        : mapShowButtonCommandToDumpTarget(buttonText);
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
          ...(buttonDump.ids?.length
            ? {
                // Exact rows only — drop any filters the model attached to its
                // own reading of the tap.
                showDumpIds: buttonDump.ids,
                showDumpSection: null,
                showDumpPartner: null,
                showDumpAssignee: null,
                showDumpAbout: null,
                showDumpFrom: null,
                showDumpTo: null,
                showDumpDateScope: null,
                showDumpUrgency: null,
              }
            : {}),
          ...(buttonDump.dateScope === "undated"
            ? {
                showDumpDateScope: "undated" as const,
                showDumpFrom: null,
                showDumpTo: null,
              }
            : {}),
          ...(buttonDump.dateFrom
            ? {
                showDumpFrom: buttonDump.dateFrom,
                showDumpTo: buttonDump.dateTo ?? buttonDump.dateFrom,
              }
            : {}),
        };
      }
    }
    // Exact transit board open commands (recommended / all / «אפשרות N») — deterministic
    // even if the model omitted open_itinerary or emitted an incompatible full search.
    // Mixed-intent free text does not match mapRoutesOpenCommand (model-driven).
    if (!guestSpeaker) {
      const routesOpenCmd = mapRoutesOpenCommand(
        stripWhatsAppReplyPrefix(input.message),
      );
      if (routesOpenCmd != null) {
        metadata = {
          ...metadata,
          routes: {
            origin: "",
            destination: "",
            departure: "",
            arrival: "",
            line: "",
            headsign: "",
            stopCode: "",
            agency: "",
            serviceDate: "",
            windowEnd: "",
            mode: "transit",
            aspects: ["summary"],
            requireLiveSelect: false,
            prefer: "",
            openItinerary: routesOpenCmd,
            recalculate: false,
            discloseNetworkDisruption: false,
          },
        };
      }
    }
    // Result-A: immutable requested AFTER parse shaping, BEFORE strip/resolve/H drops.
    const applyResultRequested = captureRequestedFromMetadata(metadata);
    const showDumpBeforeStrip = metadata.showDump;
    const metadataBeforeStrip = metadata;
    // show_dump: display-only — drop spurious removes; mutates win over accidental show_dump.
    metadata = stripShowTurnMutates(metadata);
    // Result-C: mutate+show — strip drops showDump; keep pending for post-apply dump.
    const pendingShowDump: PendingShowDump | null = capturePendingShowDump({
      showDumpBefore: showDumpBeforeStrip,
      before: metadataBeforeStrip,
      afterStrip: metadata,
    });
    const stripDropAccount = collectShowTurnStripDrops({
      requested: applyResultRequested,
      showDumpBefore: showDumpBeforeStrip,
      afterStrip: {
        lists: metadata.lists,
        listOps: metadata.listOps,
        filing: metadata.filing,
        reminders: metadata.reminders,
        directory: metadata.directory,
      },
    });
    const stripMissesForResult: ResultIntentMiss[] = stripDropAccount.misses;
    const unclassifiedStripDropsForResult: RequestedOp[] =
      stripDropAccount.unclassified;
    // Same-turn blank custom create + unambiguous host linked_lists name → fill listName.
    metadata = fillBlankCustomListNameFromSameTurnLinks(metadata);
    // Stage-2 intent gate: explicit mutate_source (dump_line / saved_data) before H.
    // Missing mutate_source is never inferred as saved_data — those rows stay for H.
    let intentPassThroughIds: ReadonlySet<string> | undefined;
    let intentMissesForResult: IntentMiss[] = [];
    let dumpGuardDropsForResult: DumpGuardDrop[] = [];
    const turnVisibleRefs = guestSpeaker
      ? null
      : buildThisTurnVisibleRefs(speakerSnapshot, workerSnapshot);
    if (!guestSpeaker) {
      const intentResolved = resolveIntentRefs(metadata.lists ?? [], {
        dump: lastNumberedDump,
        visibleRefs: turnVisibleRefs!,
      });
      metadata = { ...metadata, lists: intentResolved.lists };
      intentMissesForResult = intentResolved.misses;
      intentPassThroughIds =
        intentResolved.passThroughIds.size > 0
          ? intentResolved.passThroughIds
          : undefined;
    }
    // Hard guard H: dump binds line refs; explicit add + ESD-grounded ids pass.
    // Stale/invented ids (not on dump, not Stage-2 passThrough, not this-turn
    // visible refs) are dropped. Apply still owns existence/permissions.
    const dumpRestricted = guestSpeaker
      ? {
          lists: metadata.lists ?? [],
          droppedOutsideDump: false,
          droppedItems: [] as DumpGuardDrop[],
        }
      : restrictListMutatesToLastNumberedDump(
          metadata.lists ?? [],
          lastNumberedDump,
          {
            ...(intentPassThroughIds
              ? { passThroughIds: intentPassThroughIds }
              : {}),
            ...(turnVisibleRefs && turnVisibleRefs.size > 0
              ? { groundedIds: new Set(turnVisibleRefs.keys()) }
              : {}),
          },
        );
    dumpGuardDropsForResult = dumpRestricted.droppedItems ?? [];
    if (dumpRestricted.droppedOutsideDump) {
      metadata = { ...metadata, lists: dumpRestricted.lists };
    }
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
            employees: humansForPlan,
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
          employee.id,
        );
    const filingOwners = guestSpeaker
      ? undefined
      : await loadFilingOwners(
          input.userId,
          filingActionIds(metadataForApply.filing ?? []),
          employee.id,
        );
    const plan = planTargetedActions({
      actor: employee,
      employees: humans,
      workers: digitalEmployees(employees),
      externalPartners,
      metadata: metadataForApply,
      sharedLists,
      itemOwners,
      filingOwners,
    });
    const relays = planRelayDeliveries({
      actor: employee,
      sender: digital,
      employees: [...employees, ...externalPartners],
      messages: guestSpeaker ? [] : resolveRelayMessages(metadata.messages ?? []),
    });

    const collectedEvents: SharedItemEvent[] = [];
    const listMutations: ListItemMutation[] = [];
    const filingMutations: FilingMutation[] = [];
    const shareMisses: ShareApplyMiss[] = [];
    const nestedRemindMisses: Array<{
      reason: string;
      op: string;
      listType: string;
      listName?: string;
      itemLabel: string;
      detail?: string;
      remindLabels?: string[];
    }> = [];
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
      nestedRemindMisses.push(...applied.nestedRemindMisses);
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
        ? "אפשר רק לצפות ברשימות ששותפו איתך — בלי להוסיף או לשנות."
        : "";
    let registerNotice = "";
    let pendingInviteContinue: Awaited<
      ReturnType<typeof continueInviteAfterRegister>
    > | null = null;
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
          registerNotice = `נרשמת בהצלחה, ${registerResult.displayName}. מעכשיו אפשר לדבר עם לוסי ישירות.`;
          recordWhatsAppEvent(
            "guest_register",
            `ok employee=${registerResult.employeeId.slice(0, 8)}`,
          );
          pendingInviteContinue = await withoutFailingTurn(
            "invite_continue_failed",
            () =>
              continueInviteAfterRegister({
                hostUserId: input.userId,
                guestEmployeeId: registerResult.employeeId,
                guestDisplayName: registerResult.displayName,
                guestPhone: employee.phone,
              }),
          );
          if (pendingInviteContinue?.guestAck) {
            registerNotice = `${registerNotice}\n${pendingInviteContinue.guestAck}`;
          }
        } else if (registerResult.reason === "invalid_fields") {
          registerNotice =
            "חסר לי שם או לשון פנייה (זכר/נקבה) — כתבו לי אותם ונשלים את הרישום.";
        } else {
          registerNotice = "לא הצלחתי להשלים את הרישום כרגע. נסו שוב בעוד רגע.";
          recordWhatsAppEvent(
            "guest_register",
            `fail reason=${registerResult.reason}`,
          );
        }
      }
      metadata = redactMetadataSecrets(metadata);
    }
    const incomingReminders = guestSpeaker ? [] : metadata.reminders ?? [];
    // Nested items[].remind: joins written in atomic/package paths (NEW contract).
    // Exact-key soft-link is legacy-only — see clocksEligibleForExactKeySoftLink.
    const atomicNestedSaved = listMutations.flatMap((row) =>
      row.nestedClocksApplied && row.nestedSavedClocks
        ? row.nestedSavedClocks
        : [],
    );
    const atomicNestedItemIds = listMutations
      .filter((row) => row.nestedClocksApplied)
      .map((row) => row.itemId);
    // Existing-item nested remind still uses post-list package (unchanged).
    const nestedPackages = guestSpeaker
      ? []
      : listMutations
          .filter(
            (row) =>
              row.action === "update" &&
              (row.listType === "shopping" || row.listType === "tasks") &&
              Array.isArray(row.pendingReminds) &&
              row.pendingReminds.length > 0 &&
              !row.nestedClocksApplied,
          )
          .map((row) => ({
            itemId: row.itemId,
            ownerEmployeeId: row.employeeId,
            listType: row.listType,
            itemLabel: row.itemLabel || row.itemKey,
            reminds: row.pendingReminds ?? [],
            nestedCompensate: row.nestedCompensate,
          }));
    const nestedResult =
      nestedPackages.length > 0
        ? await applyNestedReminderPackages({
            userId: input.userId,
            actor: employee,
            employees: humansForPlan,
            contacts: speakerContacts,
            packages: nestedPackages,
          })
        : {
            saved: [],
            skipped: [],
            failedItemIds: [] as string[],
            nestedItemIds: [] as string[],
            fingerprintsByReminderId: new Map<string, string>(),
          };
    nestedResult.saved.push(...atomicNestedSaved);
    nestedResult.nestedItemIds.push(...atomicNestedItemIds);
    // Dual-path dedup: fingerprints of clocks actually saved in the atomic txn.
    for (const clock of atomicNestedSaved) {
      const fp =
        typeof clock.fingerprint === "string" ? clock.fingerprint.trim() : "";
      if (fp && clock.id) {
        nestedResult.fingerprintsByReminderId.set(clock.id, fp);
      }
    }
    // Nested package failure compensated the list row — drop that mutation from
    // success accounting so we never report full success for a rolled-back add.
    if (nestedResult.failedItemIds.length > 0) {
      const failed = new Set(nestedResult.failedItemIds);
      for (let i = listMutations.length - 1; i >= 0; i -= 1) {
        const row = listMutations[i];
        if (
          row &&
          failed.has(row.itemId) &&
          Array.isArray(row.pendingReminds) &&
          row.pendingReminds.length > 0
        ) {
          listMutations.splice(i, 1);
        }
      }
    }
    const filteredIncoming = filterTopLevelRemindersAgainstNested({
      topLevel: incomingReminders,
      nestedSaved: nestedResult.saved,
      nestedFingerprints: nestedResult.fingerprintsByReminderId,
      nestedItemIds: nestedResult.nestedItemIds,
      employees: humansForPlan,
      actorId: employee.id,
      contacts: speakerContacts,
    });
    const reminderWrites = [
      ...filteredIncoming.filter((row) => row.action !== "remove"),
      ...filteredIncoming.filter((row) => row.action === "remove"),
    ];
    const incompleteComposeClocks = (metadata.reminders ?? []).filter(
      (row) =>
        row.action === "add" &&
        (row.composeSource === "git_log" ||
          row.composeSource === "saved_data" ||
          row.composeSource === "weather" ||
          row.composeSource === "market" ||
          row.composeSource === "mashov" ||
          row.composeSource === "smartschool" ||
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
      employees: humansForPlan,
      reminders: reminderWrites,
      contacts: speakerContacts,
      alreadyCancelledReminderIds: cancelledReminderIds,
    });
    // Merge nested clocks into reminder apply accounting (join already written).
    reminderResult.saved.push(...nestedResult.saved);
    reminderResult.skipped.push(
      ...nestedResult.skipped.map((row) => ({
        item: row.item,
        reason: "db" as const,
      })),
    );
    attachmentOutcome = mergeAttachmentOutcomes(
      attachmentOutcome,
      reminderResult.attachmentOutcome,
    );
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
      ? {
          saved: [],
          removed: [],
          alreadyExisting: [],
          shareNotices: [],
          attachmentOutcome: emptyAttachmentOutcome(),
        }
      : await applyDirectoryActions({
          userId: input.userId,
          ownerEmployeeId: employee.id,
          actions: metadata.directory ?? [],
          employees: humansForPlan,
        });
    attachmentOutcome = mergeAttachmentOutcomes(
      attachmentOutcome,
      directoryResult.attachmentOutcome,
    );
    // Result-A: internal ApplyResult only — does not change user-facing reply.
    // Explicit reminder skips for failed NEW task+nested txn (no clocks applied).
    // One skip per remind in the package — never a single blanket task label only.
    if (nestedRemindMisses.length > 0) {
      for (const miss of nestedRemindMisses) {
        const labels =
          Array.isArray(miss.remindLabels) && miss.remindLabels.length > 0
            ? miss.remindLabels
            : [miss.itemLabel];
        for (const label of labels) {
          reminderResult.skipped.push({
            item: label,
            reason: "db",
          });
        }
      }
    }
    let turnApplyResult: ApplyResult = buildApplyResult({
      requested: applyResultRequested,
      intentMisses: intentMissesForResult,
      dumpGuardDrops: dumpGuardDropsForResult,
      stripMisses: stripMissesForResult,
      unclassifiedStripDrops: unclassifiedStripDropsForResult,
      listMutations,
      filingMutations,
      shareMisses,
      nestedRemindMisses,
      listOpResults,
      reminderResult: {
        saved: reminderResult.saved,
        removed: reminderResult.removed,
        missed: reminderResult.missed,
        skipped: reminderResult.skipped,
        changes: reminderResult.changes,
      },
      directoryResult: {
        saved: directoryResult.saved.map((row) => ({
          id: row.id,
          name: row.name,
        })),
        removed: directoryResult.removed,
      },
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
    // EXISTING: ESD item_id → join (exact persisted id only; no itemKey).
    await linkRemindersByItemId({
      userId: input.userId,
      actorId: employee.id,
      saved: reminderResult.saved,
    });
    // Legacy exact-key soft-link only: exclude NEW nested + EXISTING item_id clocks.
    // Flag default remains ON; mechanism unchanged for title-matched legacy clocks.
    const exactKeyClocks = clocksEligibleForExactKeySoftLink(
      reminderResult.saved,
      nestedResult.saved.map((row) => row.id),
    ).map((row) => ({
      id: row.id,
      itemKey: row.itemKey,
      itemLabel: row.itemLabel,
    }));
    const humanIds = humans.map((human) => human.id);
    const sameTurnItems = itemsFromListMutationsForSoftLink(
      listMutations,
      humanIds,
    );
    const liveItems =
      exactKeyClocks.length > 0
        ? await listLiveHumanItemsForReminderLink({
            userId: input.userId,
            humanIds,
          })
        : [];
    const softLinkCandidates = excludeNestedItemsFromSoftLinkCandidates(
      unionSoftLinkItemCandidates(sameTurnItems, liveItems),
      nestedResult.nestedItemIds,
    );
    await linkRemindersToItems(exactKeyClocks, softLinkCandidates, {
      exactKeyEnabled: isExactKeySoftLinkEnabled(),
    });
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
      [...employees, ...externalPartners],
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
    if (pendingInviteContinue?.askerNotice) {
      notifications.push(
        await pushRelayMessage({
          userId: pendingInviteContinue.askerUserId,
          employeeId: pendingInviteContinue.askerEmployeeId,
          digitalEmployeeId: pendingInviteContinue.digitalEmployeeId,
          speaker: assistantSpeaker,
          text: pendingInviteContinue.askerNotice,
        }),
      );
      if (pendingInviteContinue.askerPhone) {
        await sendWhatsAppText(
          pendingInviteContinue.askerPhone,
          pendingInviteContinue.askerNotice,
          { ignoreSession: true },
        ).catch(() => "failed" as const);
      }
    }

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
      const target = humansForPlan.find((row) => row.id === notice.employeeId);
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
      employees: humansForPlan,
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
        const target = humansForPlan.find((row) => row.id === notice.employeeId);
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
      expectsReply:
        "expectsReply" in row ? Boolean(row.expectsReply) : true,
      askSummary:
        "askSummary" in row && typeof row.askSummary === "string"
          ? row.askSummary
          : "",
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
    let scheduledJobDeliveryCount = 0;
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
      scheduledJobDeliveryCount = scheduledJobDeliveries.length;
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
    let outboundSkips = [...waRelays.skips, ...waPhones.skips];
    let inviteComposeUrl: string | null = null;
    let inviteNotice = "";
    let inviteSaveContactButton: { label: string; command: string } | null =
      null;
    if (!guestSpeaker) {
      const inviteBuilt = await withoutFailingTurn("cold_invite_failed", () =>
        buildColdInvitesForNoSession({
          userId: input.userId,
          asker: employee,
          digitalId: digital.id,
          askerName: actorName,
          phoneRelays: attributedPhones,
          phoneSkips: waPhones.skips,
          relaySkips: waRelays.skips,
          relays: attributedRelays,
          messages: metadata.messages ?? [],
          contacts: refreshedContacts,
          employees: [...employees, ...externalPartners],
        }),
      );
      if (inviteBuilt) {
        inviteNotice = inviteBuilt.notice;
        inviteComposeUrl = inviteBuilt.composeUrl;
        inviteSaveContactButton = inviteBuilt.saveContactButton;
        const invitedLabels = new Set(inviteBuilt.labels);
        outboundSkips = outboundSkips.filter(
          (skip) =>
            !(skip.reason === "no_session" && invitedLabels.has(skip.label)),
        );
      }
    }
    const skips = [...sharedWhatsAppSkips, ...outboundSkips];
    const whatsappNotice = [inviteNotice, formatWhatsAppSkipNotice(skips)]
      .filter(Boolean)
      .join("\n\n");
    const missingSend = formatMissingSendTextNotice(metadata.messages ?? []);
    const scheduleSkipNotice = guestSpeaker
      ? ""
      : formatScheduleSkippedWithoutQueueNotice({
          messages: metadata.messages ?? [],
          scheduledJobCount: scheduledJobDeliveryCount,
        });
    const deliveryFailed =
      inviteNotice.length > 0 ||
      formatWhatsAppSkipNotice(outboundSkips).length > 0 ||
      scheduleSkipNotice.length > 0;
    let workingReply = turn.reply;
    // Reply contract: the model always answers. The engine replaces the reply
    // only when apply proves a failure (ApplyResult / share / attach / unshare)
    // — never by reading the model's text.
    const decidedReply = decideReplyFromApplyResult({
      applyResult: turnApplyResult,
      modelDraft: workingReply,
    });
    if (!decidedReply.keepDraft) {
      // Stage 2B: wholesale responses replace — no leftover model bubbles.
      workingReply = replaceSpokenForExecutionOverride(
        workingReply,
        decidedReply.spoken,
      );
    }
    if (jobResult && jobResult.askWhich.length > 1) {
      workingReply = replaceSpokenForExecutionOverride(
        workingReply,
        `על איזו משימה?\n${jobResult.askWhich.map((ask) => `• ${ask}`).join("\n")}`,
      );
    }
    const requestedListRemove = (metadata.lists ?? []).some(
      (row) => row.action === "remove",
    );
    const appliedListRemove = listMutations.some(
      (row) => row.action === "remove" && !row.listShell,
    );
    const listOpFallback = formatListOpFallback(listOpResults);
    const reminderDeleteFallback =
      (reminderResult.removed?.length ?? 0) > 0
        ? formatReminderDeleteFallback(reminderResult.removed)
        : "";
    // Stage 2A: empty spoken is never a valid intentional model outcome.
    // Recover via ApplyResult-truthful lines, or defer to show_dump / live display.
    // Do not invent detailed formatAppliedMutationFallback confirms the model never wrote.
    {
      const emptyDecision = decideEmptySpokenFallback({
        reply: workingReply,
        applyResult: turnApplyResult,
        metadata,
        pendingShowDump,
        guestMutationNotice,
        listOpFallback,
        reminderDeleteFallback,
      });
      if (emptyDecision.fallback) {
        workingReply = setEngineResponse(workingReply, emptyDecision.fallback);
      }
    }
    let unshareSummaryForGate:
      | ReturnType<typeof summarizeUnshareApply>
      | null = null;
    {
      const preview = summarizeUnshareApply({
        metadata,
        mutations: listMutations,
      });
      if (
        preview.partnerLabels.length > 0 ||
        preview.appliedUnshareCount > 0
      ) {
        const afterUnshare = await withoutFailingTurn(
          "unshare_remainder_failed",
          () => getEmployeeRecordSnapshot(employee.id),
        );
        unshareSummaryForGate = summarizeUnshareApply({
          metadata,
          mutations: listMutations,
          snapshotAfter: afterUnshare ?? null,
        });
      }
    }
    workingReply = applySideFailureOverrides({
      reply: workingReply,
      resultBReplaced: !decidedReply.keepDraft,
      lines: sideFailureLines({
        listMutations,
        shareMisses,
        attachmentOutcome,
        unshareSummary: unshareSummaryForGate,
      }),
      // Stage 2B: failure overrides replace the full responses array.
      setResponse: replaceSpokenForExecutionOverride,
    });
    if (
      requestedListRemove &&
      appliedListRemove &&
      !parseLlmReply(workingReply).response.trim()
    ) {
      // Narrow confirmed ack — same Stage 2A ordinary-mutation empty policy.
      workingReply = setEngineResponse(
        workingReply,
        ORDINARY_MUTATION_EMPTY_ACK,
      );
    }
    // Clock-only delete (no linked worker task): do not leave LIST_FIND_MISS.
    if (reminderDeleteFallback) {
      const spokenAfter = parseLlmReply(workingReply).response.trim();
      if (!spokenAfter || spokenAfter === LIST_FIND_MISS) {
        workingReply = setEngineResponse(workingReply, reminderDeleteFallback);
      }
    }
    // The model already said «שיניתי/מחקתי» — correct it when the engine refused the list op.
    const listOpRefusal = formatListOpRefusals(listOpResults);
    if (listOpRefusal) {
      workingReply = replaceSpokenForExecutionOverride(
        workingReply,
        [formatListOpFallback(listOpResults), listOpRefusal]
          .filter(Boolean)
          .join("\n"),
      );
    }
    // Do not append apply-summary lines — the spoken reply is the model's response only.
    const noTimeSkipped = reminderResult.skipped.some(
      (row) => row.reason === "no_time",
    );
    if (subHourlyRepeat) {
      workingReply = replaceSpokenForExecutionOverride(
        workingReply,
        SUB_HOURLY_REFUSAL,
      );
    } else if (noTimeSkipped || incompleteComposeClocks.length > 0) {
      workingReply = replaceSpokenForExecutionOverride(
        workingReply,
        "מתי לשלוח — עכשיו, בעוד X, או בשעה קבועה?",
      );
    }
    // Model / allowlist show_dump (+ section/partner/assignee/about) → live DB dump.
    // Never utterance-parse dump intent — ACTION fields only.
    let turnLastNumberedDump: LastNumberedDumpLine[] = [];
    let turnLastLiveLocation: LastLiveLocation | undefined;
    /** ITEM DUMP rows with files → engine sends them (model may omit send_attachments). */
    let itemDumpAttachmentIds: string[] = [];
    /**
     * Engine ITEM DUMP of exactly one tasks row → סמן כבוצע + reminder twin.
     * Kept aside because the show_dump freeze clears model choice taps.
     */
    let itemDumpShowButtons: Array<{ label: string; command: string }> = [];
    /** «📎 קבצי הרשימה (N)» on a list dump whose list has list-level files. */
    let listFilesButton: { label: string; command: string } | null = null;
    // Result-C: restore stripped show_dump after apply so dump uses post-apply DB.
    // Dump always reflects actual DB; Result-B already gated success wording.
    let mutateThenShowConfirm = "";
    const restoredPendingShow = pendingShowDump != null;
    if (restoredPendingShow) {
      mutateThenShowConfirm = parseLlmReply(workingReply).response;
      metadata = restorePendingShowDump(metadata, pendingShowDump);
    }
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
      const undatedDateScope = metadata.showDumpDateScope === "undated";
      const dumpOccurrenceRange =
        !undatedDateScope &&
        (metadata.showDumpFrom?.trim() || metadata.showDumpTo?.trim())
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
      const dumpIdsRequested = showDumpIdList(metadata.showDumpIds);
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
        dateFrom: undatedDateScope ? null : (metadata.showDumpFrom ?? null),
        dateTo: undatedDateScope ? null : (metadata.showDumpTo ?? null),
        ...(undatedDateScope ? { dateScope: "undated" as const } : {}),
        urgency: metadata.showDumpUrgency ?? null,
        collaboration: dumpCollaboration,
              };
      const resolvedDumpKind = resolveShowDumpKind(showDumpKind);
      const needsPhoneBook =
        resolvedDumpKind?.kind === "full" ||
        resolvedDumpKind?.kind === "phone_book";
      const speakerPhoneBook = needsPhoneBook
        ? speakerContacts.map((row) => ({
            contact_id: row.id,
            name: row.name,
            phone: row.phone ?? "",
            ...(row.description ? { description: row.description } : {}),
            scope: (row.scope ?? "personal") as "personal" | "shared",
            ...(row.sharedWith && row.sharedWith.length > 1
              ? { shared_with: row.sharedWith }
              : {}),
            ...(row.assignedBy ? { assigned_by: row.assignedBy } : {}),
            ...(row.sharedFromOwner ? { owner: row.sharedFromOwner } : {}),
            ...(row.attachments && row.attachments.length > 0
              ? { attachments: row.attachments }
              : {}),
          }))
        : undefined;
      const phoneBookAttachExtra = (speakerPhoneBook ?? [])
        .map((row) => ({
          id: (row.contact_id ?? "").trim(),
          attachments: row.attachments,
        }))
        .filter((row) => row.id);

      const dumpForSubject = async (
        viewerName: string,
        viewerAliases: string[],
        snapshot: Awaited<ReturnType<typeof withAttachmentRefsSafe>>,
        phoneBook?: Array<{
          contact_id?: string;
          name: string;
          phone: string;
          description?: string;
          scope: "personal" | "shared";
          shared_with?: string[];
          assigned_by?: string;
          owner?: string;
        }>,
        extraOpts?: {
          flatLayout?: boolean;
          omitEmptySentence?: boolean;
          numbering?: DumpNumbering;
        },
      ): Promise<{
        text: string | null;
        lines: LastNumberedDumpLine[];
        snapshot: typeof snapshot;
        validIds: string[];
        offerUndatedTasksButton?: boolean;
        opts: typeof baseDumpOpts & {
          viewerName: string;
          viewerAliases: string[];
          phoneBook?: typeof speakerPhoneBook;
          flatLayout?: boolean;
          omitEmptySentence?: boolean;
          itemIds?: Set<string>;
          numbering?: DumpNumbering;
        };
      }> => {
        // Drop unknown ids against THIS snapshot → never fall back to unfiltered full.
        const validIds = itemDumpRequested
          ? dumpIdsRequested.filter((id) =>
              liveDumpRowIdsFromSnapshot(snapshot, phoneBook).has(id),
            )
          : dumpIdsRequested;
        const dumpOpts = {
          ...baseDumpOpts,
          viewerName,
          viewerAliases,
          ...(phoneBook ? { phoneBook } : {}),
          ...(extraOpts?.flatLayout ? { flatLayout: true } : {}),
          ...(extraOpts?.omitEmptySentence
            ? { omitEmptySentence: true }
            : {}),
          ...(extraOpts?.numbering ? { numbering: extraOpts.numbering } : {}),
          ...(itemDumpRequested
            ? { itemIds: new Set(validIds), omitEmptySentence: true }
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
          validIds,
          opts: dumpOpts,
          ...(mapped.offerUndatedTasksButton
            ? { offerUndatedTasksButton: true }
            : {}),
        };
      };

      if (aboutNames.length === 0) {
        const { text, lines, snapshot, opts, validIds, offerUndatedTasksButton } =
          await dumpForSubject(
            speaker,
            speakerAliases,
            speakerSnapshot,
            speakerPhoneBook,
          );
        turnLastNumberedDump = lines;
        if (text) {
          workingReply = setEngineResponse(workingReply, text);
          const resolved = resolveShowDumpKind(showDumpKind);
          if (itemDumpRequested && validIds.length > 0) {
            itemDumpAttachmentIds = collectAttachmentIdsForDumpRows(
              snapshot,
              validIds,
              undefined,
              phoneBookAttachExtra,
            );
          } else if (resolved?.kind === "list") {
            // The model chose to show this list; the engine renders the whole
            // display, incl. a files tap when the list itself has files. The
            // tap goes back to the model (it decides send_attachments).
            const listFileCount = collectListLevelAttachmentIdsForDump(
              snapshot,
              resolved.name,
              (listType) =>
                isBuiltinListType(listType) ? builtinListHebrew(listType) : null,
            ).length;
            listFilesButton = listFilesTapButton(resolved.name, listFileCount);
          }
          if (resolved?.kind === "filings") {
            const dumpAddress = navigateAddressFromFilingsDump(
              snapshot.filing ?? [],
              opts,
            );
            if (dumpAddress && !parseLlmReply(workingReply).navigateAddress) {
              workingReply = setEngineNavigateAddress(workingReply, dumpAddress);
            }
          } else if (
            resolved?.kind === "list" &&
            !parseLlmReply(workingReply).navigateAddress
          ) {
            const dumpAddress = navigateAddressFromListDump(
              showDumpKind,
              snapshot,
              opts,
            );
            if (dumpAddress) {
              workingReply = setEngineNavigateAddress(workingReply, dumpAddress);
            }
          }
          if (
            validIds.length === 1 &&
            isTasksShowDumpKind(showDumpKind) &&
            lines.length === 1
          ) {
            const title =
              lines[0]!.title_stem.trim() ||
              taskTitleFromSnapshot(snapshot, validIds[0]!);
            const hasLinked = taskHasLinkedReminder(snapshot, validIds[0]!);
            const itemButtons = singleTaskShowButtons({
              title,
              hasLinkedReminder: hasLinked,
            });
            if (itemButtons.length > 0) {
              itemDumpShowButtons = itemButtons;
              workingReply = setEngineButtons(workingReply, itemButtons);
            }
          } else if (offerUndatedTasksButton) {
            workingReply = setEngineButtons(workingReply, [
              undatedTasksOfferButton(),
            ]);
          }
        } else if (itemDumpRequested) {
          workingReply = setEngineResponse(
            workingReply,
            "לא מצאתי את הפריט.",
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
        /** Single-about ITEM DUMP of one tasks row → attach סמן כבוצע like speaker path. */
        let soleTaskItemDump: {
          snapshot: Awaited<ReturnType<typeof withAttachmentRefsSafe>>;
          validId: string;
          titleStem: string;
        } | null = null;
        let offerUndatedTasksButton = false;
        // One continuous counter across every about-subject block in this dump.
        const turnDumpNumbering: DumpNumbering = { next: 1 };

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
            validIds,
            offerUndatedTasksButton: subjectOfferUndated,
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
              numbering: turnDumpNumbering,
            },
          );
          if (subjectOfferUndated) {
            offerUndatedTasksButton = true;
          }
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
              text = emptyListDumpSentence("משימות", opts);
            }
          }
          if (text) {
            const header =
              aboutNames.length > 1
                ? `*${employeeDisplayName(aboutPerson)}*\n${text}`
                : text;
            blocks.push(header);
            if (itemDumpRequested && validIds.length > 0) {
              itemDumpAttachmentIds = [
                ...new Set([
                  ...itemDumpAttachmentIds,
                  ...collectAttachmentIdsForDumpRows(
                    snapshot,
                    validIds,
                    undefined,
                    phoneBookAttachExtra,
                  ),
                ]),
              ].slice(0, 10);
            }
            const resolvedAbout = resolveShowDumpKind(showDumpKind);
            if (resolvedAbout?.kind === "filings") {
              filingDumpCount += 1;
              soleFilingSnapshot = snapshot;
              soleFilingOpts = opts;
            }
            if (
              aboutNames.length === 1 &&
              validIds.length === 1 &&
              isTasksShowDumpKind(showDumpKind) &&
              subjectLines.length === 1
            ) {
              soleTaskItemDump = {
                snapshot,
                validId: validIds[0]!,
                titleStem: subjectLines[0]!.title_stem.trim(),
              };
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
        } else if (
          blocks.length === 0 &&
          missing.length === 0 &&
          itemDumpRequested
        ) {
          workingReply = setEngineResponse(
            workingReply,
            "לא מצאתי את הפריט.",
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
            if (soleTaskItemDump) {
              const title =
                soleTaskItemDump.titleStem ||
                taskTitleFromSnapshot(
                  soleTaskItemDump.snapshot,
                  soleTaskItemDump.validId,
                );
              const hasLinked = taskHasLinkedReminder(
                soleTaskItemDump.snapshot,
                soleTaskItemDump.validId,
              );
              const itemButtons = singleTaskShowButtons({
                title,
                hasLinkedReminder: hasLinked,
              });
              if (itemButtons.length > 0) {
                itemDumpShowButtons = itemButtons;
                workingReply = setEngineButtons(workingReply, itemButtons);
              }
            } else if (offerUndatedTasksButton) {
              workingReply = setEngineButtons(workingReply, [
                undatedTasksOfferButton(),
              ]);
            }
          }
        }
      }
    }
    // Result-C: mutate+show — model confirm (verbatim), then engine dump from
    // fresh DB.
    if (restoredPendingShow && showDumpKind && mutateThenShowConfirm) {
      const dumpSpoken = parseLlmReply(workingReply).response;
      const applySucceeded = Object.values(turnApplyResult.domains).some(
        (domain) => domain != null && domain.applied.length > 0,
      );
      const combined = combineConfirmAndDump(
        mutateThenShowConfirm,
        dumpSpoken,
        {
          engineConfirmFallback: applySucceeded
            ? ORDINARY_MUTATION_EMPTY_ACK
            : "",
        },
      );
      if (combined !== dumpSpoken) {
        workingReply = setEngineResponse(workingReply, combined);
      }
    }
    if (showDumpKind) {
      turnApplyResult = withApplyResultDisplay(turnApplyResult, {
        kind: showDumpKind,
        snapshot_text: parseLlmReply(workingReply).response,
        lines: turnLastNumberedDump,
      });
    }
    // WATCH create turn: live sample is a 2nd bubble after the model ack —
    // preface «לידיעתך כרגע…» (pure live asks stay unwrapped).
    const watchSampleTurn = (metadata.reminders ?? []).some(
      (row) =>
        (row.action === "add" || row.action === "update") &&
        row.composeCondition != null,
    );
    // Live weather ACTION → Open-Meteo; tip LLM then facts (pure ask = 2 bubbles).
    // Guests: weather as main topic stays forbidden — skip even if model emitted it.
    const weatherAction = guestSpeaker ? null : metadata.weather ?? null;
    const weatherNearSpeaker = weatherAction?.near === "speaker";
    if (
      weatherAction &&
      (weatherAction.place.trim() || weatherNearSpeaker)
    ) {
      const weatherBilling = {
        conversationId: conversation.id,
        employeeId: employee.id,
        digitalEmployeeId: digital.id,
      };
      const weatherSnapshot = await getEmployeeRecordSnapshot(
        input.employeeId,
      );
      const weatherPending = getPendingLocation(input.employeeId);
      const weatherResolved = resolveActionLocation({
        place: weatherAction.place,
        nearSpeaker: weatherNearSpeaker,
        pending: weatherPending,
        snapshot: weatherSnapshot,
        contacts: speakerContacts,
      });
      // Ambiguous saved labels stay an ask. label_without_coords falls through
      // so Core may geocode while preserving savedRef (Stage 2B).
      if (weatherResolved.kind === "ambiguous") {
        workingReply = applyLiveDomainReply(
          workingReply,
          weatherResolved.askText,
          { watchSample: watchSampleTurn },
        );
      } else {
        const weatherHit =
          weatherResolved.kind === "hit" ? weatherResolved : null;
        const weather = await resolveWeatherMessages({
          place: weatherHit
            ? weatherHit.location.label
            : weatherAction.place,
          nearSpeaker:
            weatherHit != null
              ? weatherHit.usedPendingPin
              : weatherResolved.kind === "need_pin" || weatherNearSpeaker,
          useCoords: weatherHit != null && !weatherHit.usedPendingPin,
          latitude: weatherHit?.location.lat ?? null,
          longitude: weatherHit?.location.lng ?? null,
          snapshot: weatherSnapshot,
          contacts: speakerContacts,
          pending: weatherPending,
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
        if (
          shouldClearPendingAfterSpeakerPinUse({
            usedPendingPin: weather.usedPendingPin,
            needsLocation: weather.needsLocation,
            replyText: weather.body,
          })
        ) {
          clearPendingLocation(input.employeeId);
        }
        if (!weather.needsLocation) {
          const kind =
            weatherHit?.usedPendingPin === true
              ? "pin"
              : weatherHit?.location.source === "saved"
                ? "saved"
                : "geocoded";
          const built = buildLastLiveLocation({
            label: weatherHit
              ? weatherHit.location.label
              : weatherAction.place,
            lat: weatherHit?.location.lat ?? null,
            lng: weatherHit?.location.lng ?? null,
            kind,
            domain: "weather",
            role: "place",
          });
          if (built) {
            turnLastLiveLocation = built;
          }
        }
      }
    }
    // Live market ACTION → Yahoo Finance; guests skip (same as weather).
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
    // Live Mashov ACTION → login from filings; guests skip.
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
    // Live SmartSchool (Webtop) ACTION → login from filings; guests skip.
    const smartschoolAction = guestSpeaker
      ? null
      : metadata.smartschool ?? null;
    if (smartschoolAction) {
      const smartschoolSnapshot = await getEmployeeRecordSnapshot(
        input.employeeId,
      );
      const smartschoolText = await resolveSmartschoolReply({
        filings: smartschoolSnapshot.filing ?? [],
        child: smartschoolAction.child,
        aspects: smartschoolAction.aspects,
        dateFrom: smartschoolAction.dateFrom,
        dateTo: smartschoolAction.dateTo,
        dateBoundsInvalid: smartschoolAction.dateBoundsInvalid,
      });
      workingReply = applyLiveDomainReply(workingReply, smartschoolText, {
        watchSample: watchSampleTurn,
      });
    }
    // Live places ACTION → Google Places; guests skip.
    // Shared resolve (place/saved before pin). area_restrict bypasses resolve.
    const placesAction = guestSpeaker ? null : metadata.places ?? null;
    const pendingLoc = guestSpeaker
      ? null
      : getPendingLocation(input.employeeId);
    const pendingResolved = fromPendingLocation(pendingLoc);
    if (placesAction?.query.trim()) {
      const areaRestrict = placesAction.geoMode === "area_restrict";
      const liveBilling = {
        conversationId: conversation.id,
        employeeId: employee.id,
        digitalEmployeeId: digital.id,
      };
      let skipPlacesFetch = false;
      let placesNearSpeaker =
        !areaRestrict && placesAction.near === "speaker";
      let placesPlace = placesAction.place;
      let placesLat: number | null = null;
      let placesLng: number | null = null;
      let placesUsedPendingPin = false;

      const placesSnapshot = await getEmployeeRecordSnapshot(
        input.employeeId,
      );
      if (areaRestrict) {
        // Preserve hard area_restrict semantics → no saved/pin resolve.
        placesLat = null;
        placesLng = null;
        placesNearSpeaker = false;
      } else {
        const placesResolved = resolveActionLocation({
          place: placesAction.place,
          nearSpeaker: placesAction.near === "speaker",
          pending: pendingLoc,
          snapshot: placesSnapshot,
          contacts: speakerContacts,
        });
        // Ambiguous → ask. label_without_coords falls through so Core can
        // geocode while keeping savedRef (Stage 2B).
        if (placesResolved.kind === "ambiguous") {
          workingReply = applyLiveDomainReply(
            workingReply,
            placesResolved.askText,
            { watchSample: watchSampleTurn },
          );
          skipPlacesFetch = true;
        } else if (placesResolved.kind === "hit") {
          placesLat = placesResolved.location.lat;
          placesLng = placesResolved.location.lng;
          placesPlace = placesResolved.location.label;
          placesNearSpeaker = true;
          placesUsedPendingPin = placesResolved.usedPendingPin;
        } else {
          // none / need_pin / label_without_coords: ACTION coords win; named
          // place never inherits pending pin (Stage B1).
          const actionCoords = parseCoordinatePair(
            placesAction.lat,
            placesAction.lng,
          );
          const namedPlace = placesAction.place.trim().length > 0;
          placesNearSpeaker =
            placesAction.near === "speaker" && !namedPlace;
          placesLat =
            actionCoords?.lat ??
            (placesNearSpeaker ? pendingResolved?.lat ?? null : null);
          placesLng =
            actionCoords?.lng ??
            (placesNearSpeaker ? pendingResolved?.lng ?? null : null);
          placesUsedPendingPin =
            placesNearSpeaker && placesLat != null && placesLng != null;
        }
      }

      if (!skipPlacesFetch) {
        const placesResult = await resolvePlacesReplyDetailed({
          query: placesAction.query,
          place: placesPlace,
          aspects: placesAction.aspects,
          intent: placesAction.intent,
          nearSpeaker: placesNearSpeaker,
          areaRestrict,
          lat: placesLat,
          lng: placesLng,
          openNow: placesAction.openNow,
          minRating: placesAction.minRating,
          includedType: placesAction.includedType,
          radiusMeters: placesAction.radiusMeters,
          parkingCost: placesAction.parkingCost,
          radiusExplicit: placesAction.radiusMeters != null,
          requireLiveSelect: placesAction.requireLiveSelect === true,
          speakerAsk: input.message,
          billing: liveBilling,
          snapshot: placesSnapshot,
          contacts: speakerContacts,
          pending: pendingLoc,
        });
        workingReply = applyLiveDomainReply(workingReply, placesResult.text, {
          watchSample: watchSampleTurn,
        });
        if (
          placesResult.navigateAddress &&
          !parseLlmReply(workingReply).navigateAddress
        ) {
          workingReply = setEngineNavigateAddress(
            workingReply,
            placesResult.navigateAddress,
          );
        }
        if (
          shouldClearPendingAfterSpeakerPinUse({
            usedPendingPin:
              placesUsedPendingPin && placesResult.usedPendingPin,
            needsLocation: placesResult.needsLocation,
            replyText: placesResult.text,
          })
        ) {
          clearPendingLocation(input.employeeId);
        }
        if (!placesResult.needsLocation) {
          let kind: "pin" | "saved" | "soft_place_text" | "area" =
            "soft_place_text";
          if (areaRestrict) {
            kind = "area";
          } else if (placesUsedPendingPin && placesResult.usedPendingPin) {
            kind = "pin";
          } else if (placesLat != null && placesLng != null) {
            kind = "saved";
          }
          const built = buildLastLiveLocation({
            label: placesPlace || placesAction.place || placesAction.query,
            lat: placesLat,
            lng: placesLng,
            kind,
            domain: "places",
            role: areaRestrict ? "area" : "place",
          });
          if (built) {
            turnLastLiveLocation = built;
          }
        }
      }
    }
    // Live Jewish / Shabbat ACTION → Hebcal; guests skip.
    // Prefer candle-offset reminder over live jewish times when both appear.
    const candleAnchorReminder = shouldSkipLiveJewishForCandleReminders(
      metadata.reminders,
    );
    const jewishAction =
      guestSpeaker || candleAnchorReminder ? null : metadata.jewish ?? null;
    if (jewishAction) {
      const jewishResult = await resolveJewishReply({
        place: jewishAction.place,
        date: jewishAction.date,
        aspects: jewishAction.aspects,
        query: jewishAction.query ?? null,
        pending: getPendingLocation(input.employeeId),
        snapshot: await getEmployeeRecordSnapshot(input.employeeId),
        contacts: speakerContacts,
      });
      workingReply = applyLiveDomainReply(workingReply, jewishResult.text, {
        watchSample: watchSampleTurn,
      });
      if (
        shouldClearPendingAfterSpeakerPinUse({
          usedPendingPin: jewishResult.lastLive?.usedPendingPin === true,
          needsLocation: false,
          replyText: jewishResult.text,
        })
      ) {
        clearPendingLocation(input.employeeId);
      }
      if (jewishResult.lastLive) {
        const built = buildLastLiveLocation({
          label: jewishResult.lastLive.label,
          lat: jewishResult.lastLive.lat,
          lng: jewishResult.lastLive.lng,
          kind: jewishResult.lastLive.kind,
          domain: "jewish",
          role: "place",
        });
        if (built) {
          turnLastLiveLocation = built;
        }
      }
    }
    // Live routes ACTION → Google TRANSIT / Places board, MOT GTFS, or SIRI live_arrivals; guests skip.
    let routesAction = guestSpeaker ? null : metadata.routes ?? null;
    // Missed-bus / situation change: model sets recalculate → fresh Google
    // search; O/D may be filled from lastRoutesBoard (never open stale board).
    if (routesAction?.recalculate) {
      const boardForRecalc = await loadLastRoutesBoardForConversation(
        conversation.id,
      );
      const filled = fillRoutesOdFromBoard(
        routesAction.origin,
        routesAction.destination,
        boardForRecalc,
      );
      routesAction = {
        ...routesAction,
        origin: filled.origin,
        destination: filled.destination,
        openItinerary: null,
        // Empty departure = provider "now" (do not keep missed leave-by).
        departure: routesAction.departure.trim() ? routesAction.departure : "",
        arrival: "",
      };
      metadata = { ...metadata, routes: routesAction };
    }
    const routesLinesBoard = Boolean(
      routesAction?.aspects?.includes("lines"),
    );
    const routesGtfs = Boolean(
      routesAction?.aspects?.includes("schedule") ||
        routesAction?.aspects?.includes("nearest_stop") ||
        routesAction?.aspects?.includes("live_arrivals"),
    );
    const routesDisruptionOnly = Boolean(
      routesAction?.discloseNetworkDisruption &&
        !routesAction.origin.trim() &&
        !routesAction.destination.trim() &&
        !routesLinesBoard &&
        !routesGtfs &&
        routesAction.openItinerary == null &&
        !routesAction.recalculate,
    );
    // Board open is authorized only by an exact closed-choice utterance
    // (mapRoutesOpenCommand). Model-emitted open_itinerary alone never opens.
    const routesUtteranceOpen = guestSpeaker
      ? null
      : mapRoutesOpenCommand(stripWhatsAppReplyPrefix(input.message));
    const routesOpenCandidate = Boolean(
      routesAction?.openItinerary != null &&
        !routesAction.recalculate &&
        !routesAction.origin.trim() &&
        !routesAction.destination.trim() &&
        !routesLinesBoard &&
        !routesGtfs,
    );
    const routesOpenOnly = Boolean(
      routesOpenCandidate && routesUtteranceOpen != null,
    );
    const routesOpenUnauthorized = Boolean(
      routesOpenCandidate && routesUtteranceOpen == null,
    );
    /** Full new O/D trip → ignore open_itinerary (fresh search). */
    const routesFreshTrip = Boolean(
      routesAction &&
        routesAction.origin.trim() &&
        (routesAction.destination.trim() || routesLinesBoard),
    );
    const routesRecalculateMissingOd = Boolean(
      routesAction?.recalculate &&
        (!routesAction.origin.trim() || !routesAction.destination.trim()),
    );
    let turnLastRoutesBoard: LastRoutesBoard | undefined;
    if (
      routesAction &&
      (routesOpenOnly ||
        routesOpenUnauthorized ||
        routesGtfs ||
        routesFreshTrip ||
        routesDisruptionOnly ||
        routesRecalculateMissingOd)
    ) {
      if (routesDisruptionOnly) {
        workingReply = applyLiveDomainReply(
          workingReply,
          ROUTES_DISRUPTION_UNAVAILABLE_HE,
          { watchSample: watchSampleTurn },
        );
      } else if (routesRecalculateMissingOd) {
        workingReply = applyLiveDomainReply(
          workingReply,
          ROUTES_RECALCULATE_NO_CONTEXT_HE,
          { watchSample: watchSampleTurn },
        );
      } else if (routesOpenUnauthorized) {
        workingReply = applyLiveDomainReply(
          workingReply,
          ROUTES_OPEN_UNAUTHORIZED_CLARIFY_HE,
          { watchSample: watchSampleTurn },
        );
      } else if (routesOpenOnly && routesUtteranceOpen != null) {
        const board = await loadLastRoutesBoardForConversation(
          conversation.id,
        );
        if (!board) {
          workingReply = applyLiveDomainReply(
            workingReply,
            ROUTES_NO_SAVED_BOARD_HE,
            { watchSample: watchSampleTurn },
          );
        } else {
          // Expand using the authorized closed-choice command (not a conflicting model value).
          const opened = formatOpenItineraryFromBoard(
            board,
            routesUtteranceOpen,
          );
          workingReply = applyLiveDomainReply(workingReply, opened.text, {
            watchSample: watchSampleTurn,
          });
          if (
            opened.navigateAddress &&
            !parseLlmReply(workingReply).navigateAddress
          ) {
            workingReply = setEngineNavigateAddress(
              workingReply,
              opened.navigateAddress,
            );
          }
        }
      } else {
        const pin = fromPendingLocation(getPendingLocation(input.employeeId));
        const speakerOrigin =
          routesAction.origin.toLowerCase() === "speaker";
        const routesSnapshot = await getEmployeeRecordSnapshot(input.employeeId);
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
          prefer: routesAction.prefer,
          requireLiveSelect: routesAction.requireLiveSelect === true,
          speakerAsk: input.message,
          billing: liveBilling,
          snapshot: routesSnapshot,
          contacts: speakerContacts,
          originLat: speakerOrigin ? pin?.lat ?? null : null,
          originLng: speakerOrigin ? pin?.lng ?? null : null,
        });
        let routesText = routesResult.text;
        if (routesAction.discloseNetworkDisruption) {
          // Mixed trip + disruption U: keep route facts; append honest gap.
          routesText = `${routesText}\n\n${ROUTES_DISRUPTION_UNAVAILABLE_HE}`;
        }
        workingReply = applyLiveDomainReply(workingReply, routesText, {
          watchSample: watchSampleTurn,
        });
        if (
          routesResult.choiceButtons &&
          routesResult.choiceButtons.length > 0
        ) {
          const spoken = parseLlmReply(workingReply).responseBubbles;
          if (spoken.length > 0) {
            const next = spoken.map((bubble, index) =>
              index === spoken.length - 1
                ? { ...bubble, buttons: routesResult.choiceButtons }
                : bubble,
            );
            workingReply = setEngineSpokenBubbles(workingReply, next);
          } else {
            workingReply = setEngineButtons(
              workingReply,
              routesResult.choiceButtons,
            );
          }
        }
        if (
          routesResult.navigateAddress &&
          !parseLlmReply(workingReply).navigateAddress
        ) {
          workingReply = setEngineNavigateAddress(
            workingReply,
            routesResult.navigateAddress,
          );
        }
        if (routesResult.board) {
          turnLastRoutesBoard = routesResult.board;
        }
        const routesNeedsLocation = replyAsksForWhatsAppPin(routesResult.text);
        if (
          shouldClearPendingAfterSpeakerPinUse({
            usedPendingPin:
              speakerOrigin && pin != null && !routesNeedsLocation,
            needsLocation: routesNeedsLocation,
            replyText: routesResult.text,
          })
        ) {
          clearPendingLocation(input.employeeId);
        }
        if (!routesNeedsLocation && routesAction) {
          const dest = routesAction.destination.trim();
          const originLabel = routesAction.origin.trim();
          const preferDest = Boolean(dest) && dest.toLowerCase() !== "speaker";
          const label = preferDest
            ? dest
            : originLabel.toLowerCase() === "speaker"
              ? pin?.label?.trim() || ""
              : originLabel;
          if (label) {
            const built = buildLastLiveLocation({
              label,
              lat: preferDest ? null : (pin?.lat ?? null),
              lng: preferDest ? null : (pin?.lng ?? null),
              kind:
                !preferDest && speakerOrigin && pin
                  ? "pin"
                  : "routes_point",
              domain: "routes",
              role: preferDest ? "destination" : "origin",
            });
            if (built) {
              turnLastLiveLocation = built;
            }
          }
        }
      }
    }
    // Live flights ACTION → AviationStack board / status; guests skip.
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
    // only then fall back so we never prepend «לא הצלחתי» before a successful fetch.
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
    // N1: direct taps for rows saved this turn. ApplyResult is the source;
    // only ids the speaker can open survive (the same gate ITEM DUMP applies
    // when the tap comes back).
    let savedItemNavs: SavedItemNav[] = [];
    if (
      !guestSpeaker &&
      !metadata.showDump &&
      savedItemNavsFromApplyResult(turnApplyResult, undefined, "all").length > 0
    ) {
      savedItemNavs =
        (await withoutFailingTurn("saved_item_nav_failed", async () => {
          const snapshot = await withAttachmentRefsSafe(
            await getEmployeeRecordSnapshot(employee.id),
          );
          const visible = liveDumpRowIdsFromSnapshot(
            snapshot,
            refreshedContacts.map((row) => ({ contact_id: row.id, name: row.name })),
          );
          return savedItemNavsFromApplyResult(
            turnApplyResult,
            visible,
            shoppingRowsWithDetail(snapshot),
          );
        })) ?? [];
    }
    // Freeze per-bubble buttons/Waze onto the model reply BEFORE engine
    // tips/notices append, so legacy turn-level metadata.buttons are not
    // redistributed onto trailing tip bubbles.
    {
      const preTip = parseLlmReply(workingReply);
      let bubbles = preTip.responseBubbles;
      if (metadata.showDump) {
        // show_dump is display-only → strip model choice taps on a bare dump.
        // Re-attach engine single-task ITEM DUMP taps (סמן כבוצע / reminder twin).
        bubbles = clearBubbleButtons(bubbles);
        const engineDumpTaps = [
          ...itemDumpShowButtons,
          ...(listFilesButton ? [listFilesButton] : []),
        ];
        if (engineDumpTaps.length > 0 && bubbles[0]) {
          bubbles = [
            { ...bubbles[0], buttons: engineDumpTaps },
            ...bubbles.slice(1),
          ];
        }
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
            appliedWorkerWatchName: reminderResult.saved.some(
              (row) => row.hasComposeCondition === true,
            )
              ? employeeDisplayName(digital)
              : undefined,
            appliedReminders: {
              saved: reminderResult.saved.length,
              removed: reminderResult.removed?.length ?? 0,
            },
            // Validate model LIST/collab against real apply — not bare ACTION emit.
            // Collab kept only when mutation.collabApply proves it; else plain LIST.
            appliedNav: {
              listKeys: (() => {
                const keys = new Set(
                  listMutations.map((row) => listNavKeyFromMutation(row)),
                );
                for (const row of listOpResults) {
                  // Any applied alter_list (share / unshare / emoji / rename /
                  // columns / files) → show THAT list, whose header now proves
                  // the change («· משותפת עם X»). Only delete_list keeps the
                  // «הצג רשימות» overview (the list is gone).
                  if (
                    !row.applied ||
                    row.action !== "alter_list" ||
                    !row.listType
                  ) {
                    continue;
                  }
                  keys.add(
                    listNavKeyFromMutation({
                      listType: row.listType,
                      listName: row.listName ?? "",
                    }),
                  );
                }
                if (
                  directoryResult.saved.length > 0 ||
                  directoryResult.removed.length > 0
                ) {
                  keys.add("contacts");
                }
                return keys;
              })(),
              filing: filingMutations.length > 0,
              // Overview only after delete_list (the shown list no longer
              // exists). alter_list / empty create → that list's own nav.
              listsOverview: listOpResults.some(
                (row) => row.applied && row.action === "delete_list",
              ),
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
            savedItems: savedItemNavs,
            newListKeys: new Set(
              (turnApplyResult.domains.lists?.applied ?? [])
                .filter((row) => row.inNewList || (row.listShell && row.op === "add"))
                .map((row) =>
                  listNavKeyFromMutation({
                    listType: row.listType ?? "",
                    listName: row.listName ?? "",
                  }),
                ),
            ),
            // Item-open: keep existing-row taps; require apply proof for this-turn mutates.
            appliedItems: {
              lists: listMutations.map((row) => ({
                action: row.action,
                itemId: row.itemId,
                itemLabel: row.itemLabel,
                listType: row.listType,
                listShell: row.listShell,
                ...(row.calendarYmd ? { calendarYmd: row.calendarYmd } : {}),
              })),
              filings: filingMutations.map((row) => ({
                action: row.action,
                itemName: row.itemName,
              })),
            },
          }),
        );
      }
      // One deterministic item-open label (title ≤20, else «להצגת המשימה»).
      // Two saved rows with the same title get distinct labels (WhatsApp
      // drops a second button with an identical title).
      bubbles = bubbles.map((bubble) => {
        if (!bubble.buttons?.length) {
          return bubble;
        }
        const used = new Set<string>();
        return {
          ...bubble,
          buttons: bubble.buttons.map((button) => {
            let label = itemOpenButtonLabel(button);
            if (!label) {
              used.add(button.label.trim());
              return button;
            }
            for (let n = 2; used.has(label); n += 1) {
              const suffix = ` (${n})`;
              label = `${label.slice(0, REPLY_BUTTON_LABEL_MAX - suffix.length)}${suffix}`;
            }
            used.add(label);
            return { ...button, label };
          }),
        };
      });
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
      scheduleSkipNotice,
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
    if (inviteComposeUrl) {
      reply = setEngineWhatsappComposeUrl(reply, inviteComposeUrl);
    }
    if (inviteSaveContactButton) {
      const existingButtons = parseLlmReply(reply).buttons ?? [];
      const already = existingButtons.some(
        (button) => button.command === inviteSaveContactButton!.command,
      );
      if (!already) {
        reply = setEngineButtons(reply, [
          ...existingButtons,
          inviteSaveContactButton,
        ]);
      }
    }
    const outboundAttachments = guestSpeaker
      ? []
      : ((await withoutFailingTurn("attachments_send_failed", () =>
          resolveUsableAttachments(
            employee.id,
            [
              ...(metadata.sendAttachments ?? []),
              ...itemDumpAttachmentIds,
            ].slice(0, SEND_ATTACHMENTS_MAX),
            "send",
          ),
        )) ?? []);
    let celebrationRef: ChatAttachmentRef | null = null;
    const celebrationRemoves = guestSpeaker
      ? []
      : collectCelebrationRemoves(listMutations);
    const profileAttachmentId = employee.profileAttachmentId?.trim() ?? "";
    if (celebrationRemoves.length > 0 && profileAttachmentId) {
      const celebration = await withoutFailingTurn(
        "delete_celebration_failed",
        () =>
          runDeleteCelebration({
            userId: input.userId,
            // Lucy-generated file: owned by the digital worker, never the speaker —
            // otherwise it surfaces in PENDING_ATTACHMENTS as a file the user sent.
            uploaderId: digital.id,
            profileAttachmentId,
            removes: celebrationRemoves,
            speakerName: employee.nickname?.trim() || employee.name,
            addressGender: employee.addressGender,
            billing: {
              conversationId: conversation.id,
              employeeId: employee.id,
              digitalEmployeeId: digital.id,
            },
          }),
      );
      if (celebration) {
        celebrationRef = celebration.ref;
        const tipText = celebration.tip.trim();
        reply = setEngineSpokenBubbles(reply, [
          ...parseLlmReply(reply).responseBubbles,
          { text: tipText },
        ]);
      }
    }
    const finalParsed = parseLlmReply(reply);
    const celebrationBubbleIndex =
      celebrationRef && finalParsed.responseBubbles.length > 1
        ? finalParsed.responseBubbles.length - 1
        : -1;
    const bubbleAttachments: Array<ChatAttachmentRef[] | undefined> =
      celebrationBubbleIndex >= 0 && celebrationRef
        ? (() => {
            const map: Array<ChatAttachmentRef[] | undefined> = [];
            map[celebrationBubbleIndex] = [celebrationRef];
            return map;
          })()
        : [];
    const turnMessageIds = await syncTurnReplies({
      conversationId: conversation.id,
      assistantSpeaker,
      saved: messageIds,
      bubbles: finalParsed.responseBubbles,
      attachments: outboundAttachments.map(toChatAttachmentRef),
      ...(bubbleAttachments.length ? { bubbleAttachments } : {}),
      ...(finalParsed.showIcon ? { showIcon: finalParsed.showIcon } : {}),
      ...(turnLastNumberedDump.length > 0
        ? { lastNumberedDump: turnLastNumberedDump }
        : {}),
      ...(turnLastRoutesBoard
        ? { lastRoutesBoard: turnLastRoutesBoard }
        : {}),
      ...(turnLastLiveLocation
        ? { lastLiveLocation: turnLastLiveLocation }
        : {}),
    });

    if (conversation.needsContext) {
      await markContextInjected(conversation.id);
      if (!guestSpeaker && !consultFrom && isLucyDigital(digital)) {
        await withoutFailingTurn("overdue_offered_failed", () =>
          markOverdueJobsOffered({
            digitalEmployeeId: digital.id,
            speakerId: input.employeeId,
          }),
        );
        await withoutFailingTurn("stale_offered_failed", () =>
          markStaleUndatedJobsOffered({
            digitalEmployeeId: digital.id,
            speakerId: input.employeeId,
          }),
        );
      }
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
    const allOutboundRefs = [
      ...outboundAttachments.map(toChatAttachmentRef),
      ...(celebrationRef ? [celebrationRef] : []),
    ];
    return {
      reply,
      raw: turn.raw,
      request: openaiRequest,
      notifications,
      answeredBy: digital.name,
      timing: { llmMs, afterLlmMs: Date.now() - afterLlmStarted },
      messageIds: turnMessageIds,
      outboundAttachmentIds: allOutboundRefs.map((row) => row.id),
      outboundAttachments: allOutboundRefs,
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

async function buildColdInvitesForNoSession(input: {
  userId: string;
  asker: PublicEmployee;
  digitalId: string;
  askerName: string;
  phoneRelays: Array<{
    phone: string;
    text: string;
    label?: string;
    expectsReply?: boolean;
    askSummary?: string;
  }>;
  phoneSkips: WhatsAppDeliverySkip[];
  relaySkips: WhatsAppDeliverySkip[];
  relays: Array<{
    target: PublicEmployee;
    text: string;
    expectsReply?: boolean;
    askSummary?: string;
  }>;
  messages: Array<{
    expectsReply?: boolean;
    askSummary?: string;
    text: string;
    targets: string[];
  }>;
  contacts: Array<{ name: string; phone: string | null }>;
  employees: PublicEmployee[];
}): Promise<{
  notice: string;
  composeUrl: string;
  labels: string[];
  saveContactButton: { label: string; command: string } | null;
} | null> {
  const { hasWhatsAppSession } = await import("./whatsapp-window.js");
  const env = getEnv();
  const graphReady =
    env.NODE_ENV !== "test" && Boolean(env.WHATSAPP_ACCESS_TOKEN?.trim());

  type Candidate = {
    phone: string;
    label: string;
    askSummary: string;
    expectsReply: boolean;
  };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  async function needsColdInvite(
    phone: string,
    label: string,
    skips: WhatsAppDeliverySkip[],
  ): Promise<boolean> {
    const noSessionSkip = skips.some(
      (skip) => skip.label === label && skip.reason === "no_session",
    );
    if (noSessionSkip) {
      return true;
    }
    const sessionOpen = await hasWhatsAppSession(phone);
    if (sessionOpen) {
      return false;
    }
    // No open 24h window: invite even without Graph / without DISPLAY_PHONE
    // (Amit?recipient wa.me only needs the recipient digits).
    if (!graphReady) {
      return true;
    }
    // Graph ready but no skip listed → still invite when session is closed.
    return true;
  }

  for (const phone of input.phoneRelays) {
    const label = phone.label?.trim() || phone.phone;
    if (seen.has(phone.phone)) {
      continue;
    }
    if (!(await needsColdInvite(phone.phone, label, input.phoneSkips))) {
      continue;
    }
    seen.add(phone.phone);
    const matchedMessage = input.messages.find((row) =>
      row.targets.some((t) => t.includes(label) || t.includes(phone.phone)),
    );
    const expectsReply =
      phone.expectsReply ?? matchedMessage?.expectsReply !== false;
    const askSummary =
      phone.askSummary?.trim() ||
      matchedMessage?.askSummary?.trim() ||
      phone.text;
    candidates.push({
      phone: phone.phone,
      label,
      askSummary,
      expectsReply,
    });
  }

  for (const relay of input.relays) {
    if (!relay.target.phone) {
      continue;
    }
    const label = relay.target.nickname?.trim() || relay.target.name;
    const phone = relay.target.phone;
    if (seen.has(phone)) {
      continue;
    }
    if (!(await needsColdInvite(phone, label, input.relaySkips))) {
      continue;
    }
    seen.add(phone);
    candidates.push({
      phone,
      label,
      askSummary: relay.askSummary?.trim() || relay.text,
      expectsReply: relay.expectsReply !== false,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const primary = candidates[0]!;
  const created = await createWhatsAppInvite({
    userId: input.userId,
    askerEmployeeId: input.asker.id,
    digitalEmployeeId: input.digitalId,
    askerName: input.askerName,
    recipientPhone: primary.phone,
    recipientLabel: primary.label,
    askSummary: primary.askSummary,
    expectsReply: primary.expectsReply,
  });
  if (!created) {
    return null;
  }
  for (const extra of candidates.slice(1)) {
    await createWhatsAppInvite({
      userId: input.userId,
      askerEmployeeId: input.asker.id,
      digitalEmployeeId: input.digitalId,
      askerName: input.askerName,
      recipientPhone: extra.phone,
      recipientLabel: extra.label,
      askSummary: extra.askSummary,
      expectsReply: extra.expectsReply,
    });
  }

  const inContacts = input.contacts.some(
    (contact) =>
      contact.phone && phonesMatch(contact.phone, primary.phone),
  );
  const isEmployee = input.employees.some(
    (row) =>
      row.id !== input.asker.id &&
      row.phone &&
      phonesMatch(row.phone, primary.phone),
  );
  const saveContactButton =
    !inContacts && !isEmployee
      ? saveContactReplyButton(primary.label, primary.phone)
      : null;

  return {
    notice: created.notice,
    composeUrl: created.composeUrl,
    labels: candidates.map((row) => row.label),
    saveContactButton,
  };
}

async function continueInviteAfterRegister(input: {
  hostUserId: string;
  guestEmployeeId: string;
  guestDisplayName: string;
  guestPhone: string | null | undefined;
}): Promise<{
  askerUserId: string;
  askerEmployeeId: string;
  askerPhone: string | null;
  digitalEmployeeId: string;
  askerNotice: string;
  guestAck: string;
} | null> {
  let invite =
    (await findPendingInviteForGuest(input.guestEmployeeId)) ??
    (input.guestPhone
      ? await findPendingInviteByPhone(input.guestPhone)
      : null);
  if (!invite) {
    return null;
  }
  await consumeWhatsAppInvite(invite.id);

  const asker = await prisma.employee.findUnique({
    where: { id: invite.askerEmployeeId },
  });
  if (!asker) {
    return null;
  }
  const askerName = asker.nickname?.trim() || asker.name;
  const ask = invite.askSummary;
  const subjectName = input.guestDisplayName;

  await createJobsFromRelays({
    userId: invite.userId,
    digitalEmployeeId: invite.digitalEmployeeId,
    asker: { id: asker.id, name: askerName },
    deliveries: [
      {
        subjectId: input.guestEmployeeId,
        subjectName,
        text: ask,
        ask,
        urgency: "normal",
      },
    ],
  });

  if (input.guestPhone) {
    const askText = `${askerName} שאל/ה: ${ask}`;
    await sendWhatsAppText(input.guestPhone, askText, {
      ignoreSession: true,
    }).catch(() => "failed" as const);
  }

  return {
    askerUserId: invite.userId,
    askerEmployeeId: invite.askerEmployeeId,
    askerPhone: asker.phone,
    digitalEmployeeId: invite.digitalEmployeeId,
    askerNotice: `${subjectName} נרשם/ה לוורקי. השאלה: ${ask} — אעדכן כשיענה/תענה.`,
    guestAck: `ועכשיו לשאלה ששאלו אותך: ${ask}`,
  };
}

/** Custom + shopping/tasks shells the actor owns or is a shell partner on. */
async function listSharedCustomListsForActor(
  _userId: string,
  actorId: string,
): Promise<SharedListRef[]> {
  const rows = await prisma.employeeList.findMany({
    where: {
      listType: { in: ["custom", "shopping", "tasks"] },
      deletedAt: null,
      employee: { kind: "human" },
      OR: [{ employeeId: actorId }, { scope: "shared" }],
    },
    select: {
      employeeId: true,
      name: true,
      listType: true,
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
        listType: row.listType,
        visibleTo: [...new Set([row.employeeId, ...visibleTo])],
        scope: scope as "personal" | "shared",
      };
    })
    .filter((row) => {
      const builtin =
        row.listType === "shopping" || row.listType === "tasks";
      const namedOk = builtin || Boolean(row.listName.trim());
      return (
        namedOk &&
        (row.ownerId === actorId ||
          (row.scope === "shared" && row.visibleTo.includes(actorId)))
      );
    });
}
