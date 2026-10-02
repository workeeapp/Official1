import { Prisma, type ChatMessage as ChatMessageRow } from "@prisma/client";
import {
  digitalEmployees,
  humanEmployees,
  isGuestEmployee,
  parseLlmReply,
  parseReplyMetadata,
  type ChatHistoryResponse,
  type ChatThreadMessage,
  type ChatThreadNotification,
  type LlmMetadata,
  type PublicEmployee,
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
  formatAppliedMutationFallback,
  formatEmployeeContext,
  formatTeamSchedules,
  getEmployeeRecordSnapshot,
  getTeamSchedules,
  removeVisibleCustomItems,
  type FilingMutation,
  type ListItemMutation,
  type SharedItemEvent,
} from "./employee-records.service.js";
import { getEmployeeForUser, listEmployeesForUser } from "./employee.service.js";
import {
  employeeDisplayName,
  fallbackNotificationText,
  formatMissingSendTextNotice,
  planPhoneRelays,
  planRelayDeliveries,
  planTargetedActions,
  resolveRelayMessages,
  resolveSpokenMetadata,
  type SharedListRef,
} from "./employee-targets.service.js";
import { phonesMatch } from "../utils/phone.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import { publishChatEvent } from "./chat-events.service.js";
import { getLlmClient, toPlainJson, toResponsesCreateBody } from "./llm-client.js";
import { recordLlmUsage } from "./llm-usage.service.js";
import {
  applyReminders,
  formatReminderApplyNotice,
  formatReminderConfirmNotice,
  hasUnrelatedWorkWhilePending,
  linkRemindersToWorkerTasks,
  planReminderWrites,
  type WorkerTaskRef,
} from "./reminder.service.js";
import {
  formatRecentOutboundContext,
  listRecentReminderOutbounds,
} from "./recent-outbound.service.js";
import {
  conversationPendingFromStored,
  fillMessagesFromPendingHold,
  fillListsFromPendingHold,
  fillRemindersFromPendingHold,
  alignListTargetsWithMessageRecipients,
  formatCancelledHoldReply,
  formatConversationPendingContext,
  formatListDeleteConfirmNotice,
  isAwaitingFieldsHold,
  isPendingHoldCancelText,
  metadataAfterHoldCancel,
  pendingHoldFromLlm,
  pendingHoldFromMissingMessages,
  pendingToStored,
  planListDeletes,
  resolveNextPending,
  type ConversationPendingAction,
} from "./pending-action.service.js";
import {
  applyDirectoryActions,
  formatSpeakerContacts,
  listContactsForEmployee,
} from "./contact.service.js";
import {
  composeAssistantReply,
  deliverWhatsAppPhones,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
  setEngineResponse,
  type WhatsAppDeliverySkip,
} from "./whatsapp-send.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";
import { planOutboundSends } from "./outbound-hold.js";
import { formatAttributedOutbound } from "./outbound-text.js";

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

export const CONVERSATION_IDLE_MS = 24 * 60 * 60 * 1000;

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
    .find((message) => message.author === "assistant");

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

function buildOpenAiRequest(input: {
  conversationId: string;
  message: string;
  model: string;
  temperature: number;
  instructions: string;
  textFormat?: LlmJsonSchemaFormat;
}): Record<string, unknown> {
  return toResponsesCreateBody(input);
}

function packStoredLlmRaw(request: unknown, response: unknown): unknown {
  return {
    [STORED_LLM_REQUEST]: request,
    [STORED_LLM_RESPONSE]: response,
  };
}

function unpackStoredLlmRaw(raw: unknown): { request: unknown; response: unknown } {
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
    };
  }
  return { request: null, response: raw ?? null };
}

function toThreadMessage(row: ChatMessageRow): ChatThreadMessage {
  const actions = Array.isArray(row.actions)
    ? row.actions.filter((action): action is string => typeof action === "string")
    : [];

  return {
    id: row.id,
    author: row.author === "assistant" ? "assistant" : "you",
    speaker: row.speaker,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    ...(actions.length > 0 ? { actions } : {}),
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
    "EMPLOYEE_SAVED_DATA, WORKER_SAVED_DATA, SPEAKER_CONTACTS, TEAM_SCHEDULES, RECENT_OUTBOUND, and PENDING_ACTION_STATE in this turn's user message are facts — do not invent missing ones.",
    input.speakerIsOwner
      ? "This speaker is the account owner and may see every human's live saved data in EMPLOYEE_SAVED_DATA."
      : "This speaker is not the account owner — answer only from their own live saved data (plus shared items visible to them).",
    feminine
      ? "First-person Hebrew is feminine only: מעבירה, מוסיפה, שומרת, שואלת."
      : "First-person Hebrew is masculine: מעביר, מוסיף, שומר, שואל.",
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

function workerTargetingInstructions(
  employees: PublicEmployee[],
  speaker: string,
  worker: PublicEmployee,
): string {
  const workerName = speakerName(worker);
  const names = employees.map(employeeDisplayName).join(", ");
  const feminine = worker.protected || workerName.includes("לוסי");
  return [
    `Known employees: ${names}.`,
    `Current speaker: ${speaker}. You are ${workerName}.`,
    "You support every action: lists, meetings, filing, messages, reminders, query, confirm, and handoff.",
    'If the speaker assigns an action to another employee or to everyone, set targets on that action to those names or ["all"]. The server will not infer targets from the sentence.',
    'Example: "טל צריך לקנות חלב" → shopping add, targets: ["טל"] (assign — no tell/send verb).',
    'Example: "תגידי לטל לקנות מגבונים וגבינה לבנה" → messages to טל NOW; lists=[]. Offer shared shopping; hold kind=lists need=confirm_share with draft targets [speaker,\"טל\"]. On כן the server applies that draft — never private speaker shopping.',
    'Example: "תגידי לטל ולעמית לקנות ביצים" → messages to both; hold confirm_share targets speaker+טל+עמית.',
    'Example: "תגידי לטל להכין מצגת" / "תגידי למיכל שיש פגישה ב־10" / "תגידי לעמית שהקוד 1234" → messages NOW; lists/filing=[] until they accept an offer to save.',
    'Example: "אני צריך ללכת לרופא מחר ב־08:00" → tasks add for the speaker with that clock fields; reminders=[]. In response offer a reminder (when?); only then self-nudge reminders.',
    'Example: "טל צריך לקחת את הילדים לגינה" → tasks add, targets: ["טל"].',
    'Example: "כולם צריכים לקנות חלב" → targets: ["all"].',
    `Example: "שמור פגישה עם טל ביום ראשון בשעה 10" → tasks add, targets: ["${speaker}", "טל"].`,
    "A meeting WITH someone must include the current speaker and every named participant in targets.",
    "If the speaker gives a meeting date without a time and did not say all-day / יום שלם, ask before saving.",
    "If omitted on a normal list item, the action applies only to the current speaker.",
    `Work assigned to YOU → lists tasks add, targets: ["${workerName}"]. The item is the work itself. Do not put that task on the speaker. Do not handoff.`,
    `What YOU still need to do, your tasks, or YOUR reminders (מה את/ה צריך/ה לעשות, מה המטלות שלך, מה התזכורות שלך) → metadata.query = "self". Answer only from THIS turn's WORKER_SAVED_DATA. Worker tasks להזכיר ל… / לשלוח הודעה ל… count only if listed there now. Never say you have none when one is listed. Do not invent saved jobs from earlier chat that are missing from this JSON — PENDING_ACTION_STATE / hold message drafts are separate and stay in force.`,
    `Change YOUR task → lists update, targets: ["${workerName}"], keep the current שם מטלה from WORKER_SAVED_DATA and write the new wording. Do not lists.remove your task to replace it. If they refuse an offered add, lists = [].`,
    "If asked what you can do, list every capability: any list, tasks, meetings, filings, messages, and reminders. Do not shorten it.",
    "Send NOW (no delay) → metadata.messages. Send LATER (בעוד שעה / מחר ב־08:00 / in N minutes) → metadata.reminders add with in or time, ping = recipient, text = dictated/formulated words; messages = []. Do not also emit messages for a delayed send.",
    `Scheduled dictated send: (1) reminders add with ping + text + in/time. (2) lists tasks add targeting yourself (${workerName}) — לשלוח הודעה ל<name> (same item label as the clock). That is YOUR job for query self. (3) messages = []. Do not put shopping/tasks on the speaker unless they also asked to buy or remember their own work.`,
    "Write metadata.messages[].text / reminders.text for the recipient, in second person, and mention the speaker by name.",
    "Do not turn a send/check/tell request into a list or task unless they also asked to add one — except the worker task required for a scheduled send above. After tell-to-buy/task/meeting/filing: send first; offer ONLY a shared/partnered save with the people you messaged (never the speaker's private shopping/tasks alone). On yes → lists/filing with targets including those people (+ speaker for shared). After a speaker timed task without תזכיר לי: save the task and offer a reminder in response — do not auto-add reminders.",
    "messages.targets and reminders.ping may be employee names, SPEAKER_CONTACTS names, or a phone number.",
    "If the name is in Known employees, use that name in messages.targets or reminders.ping. NEVER ask for their WhatsApp number.",
    "If the name is in SPEAKER_CONTACTS, use that name (or their saved phone) in messages.targets / reminders.ping. NEVER ask for their number again.",
    "If they name someone who is not in Known employees and not in SPEAKER_CONTACTS, ask for their WhatsApp number. Empty messages and reminders until you have digits.",
    "After they give digits for an unknown person, ASK לשמור את «name» בספר הטלפונים שלך? Empty directory and empty messages/reminders while asking — but set metadata.hold kind=directory with the known name+phone draft and need=confirm_save.",
    "Yes → same turn: directory add with name + phone, hold=null, AND if they already dictated words: messages if NOW, or reminders + your worker task if LATER — do not ask again what to send. No → directory []; hold=null; still emit messages or reminders using the phone digits if the words were already given.",
    "Only ask מה תרצה לשלוח after a directory save when they never dictated words.",
    "Phone book / אנשי קשר with name+phone already given → directory add immediately (first name enough). Never ask for last name. If you must ask for a missing required field on any domain, emit hold with the known draft; next turn PENDING_ACTION_STATE keeps context — never לא הבנתי to the short fill-in.",
    "DICTATED SEND WORDS: after the recipient name, remaining words in the same sentence ARE the body — even without dash/colon/quotes. תגידי לטל לקנות… / תשלחי הודעה לעמית המערכת למעלה → messages NOW; do NOT ask מה תרצה שאשלח or האם זו הודעה או רשימת קניות. Only ask what to send when a recipient is named but no message content follows; you may offer שלום. While asking: messages=[{targets:[name], text:\"\"}] and hold kind=messages need=text with the same draft. Next short reply (היי / זו ההודעה / כן תשלחי) → send that text, hold=null — never ask again. Cancel any awaiting hold (לא / בטל / אל תשלחי / cancel) → empty unfinished arrays + hold=null; do not use cancel words as the missing field.",
    `Example delayed send: \"תשלחי למיכל בעוד שעה אני אוהב את מושה\" → messages [], lists tasks add on ${workerName} לשלוח הודעה למיכל, reminders add in 3600 ping:[\"מיכל\"] text the love note.`,
    feminine
      ? "First-person Hebrew is feminine only: מעבירה, מוסיפה, שומרת, שואלת."
      : "First-person Hebrew is masculine: מעביר, מוסיף, שומר, שואל.",
    `Handoff only if they want to speak with another digital employee. metadata.handoff = { "worker": "<their name>" }. ${feminine ? "Confirm feminine: מעבירה אותך ל«שם»." : "Confirm masculine: מעביר אותך ל«שם»."} Messages are not a conversation switch.`,
    "If they ask which digital workers exist, name them from Known employees. No handoff unless they chose one.",
    "One sentence can be several actions. Fill every array that applies.",
    `Self-nudge (תזכיר/י לי לקנות / לבדוק at a clock): (1) lists add for the speaker — shopping if buying, else tasks. (2) lists tasks add targeting yourself (${workerName}) — להזכיר ל<speaker> <item> at the clock. (3) metadata.reminders add with in (seconds) or time HH:mm. ping and reminder targets = the speaker. Do not handoff for a reminder.`,
    `Remind someone ELSE in Known employees (תזכיר/י לעמית…): (1) lists add on that person. (2) lists tasks add on yourself — להזכיר ל<name> <item>. (3) reminders add, ping/targets = that person's name from Known employees (not digits). Recurring: every_count + every_unit. NEVER ask for WhatsApp if the name is Known.`,
    "Cancel a nudge / stop the jokes / בטלי את התזכורת: reminders remove for that clock. Also lists.remove the speaker item when it is only the wrapper for that nudge (same work by meaning). If the speaker item looks like independent work they may still want, ASK whether to remove it too; empty lists while asking. The server clears the linked worker task with the clock.",
    "Change a clock / תעדכן תזכורת → reminders update using the EXACT item name from this turn's active_reminders (match by meaning if they rephrased). Put a new time only if they changed the clock. Do not add a second clock. The server updates the linked worker task time.",
    "Edit scheduled-message text only (תוסיפי בסוף להודעה לעמית): reminders update, exact saved item, text = FULL new wording (previous + addition), leave time/in empty so the server keeps the existing clock. Never claim updated unless reminders has update.",
    "Dynamic scheduled message (compose at fire): compose:true, text = brief/instruction only (any kind — greeting, note, joke, whatever). Final WhatsApp copy is written at fire time. Fixed copy → compose false/omit with full text.",
    "PLATFORM INTERNAL for account owners only (do not list under general capabilities): scheduled digest of code/product changes from git → compose:true, compose_source:\"git_log\", ping = recipient THEY named (never invent עמית), compose_lookback_hours from the spoken window (minutes→fractional hours e.g. 5 דקות≈0.083, 24≈day, 168≈week; 0 only for recurring since-last-report). One-shot MUST set lookback so a report now does not empty/advance the next recurring report. Brief in their language. No time given → ASK מתי (עכשיו / בעוד X / daily); hold kind=reminders need=time with git_log draft; NEVER say אשלח without in/time. «עכשיו» → in≈5 then it fires; when saved, say WHEN. After a sent digest / RECENT_OUTBOUND: talk to THIS speaker only about the content (e.g. אפשר להוסיף דוגמאות). NEVER invent עמית or any coworker; NEVER offer «אשלח לו / תבקשי מעמית» unless they named that person this turn. messages=[] until a real named recipient. Example names in prompts are fiction — not defaults.",
    "Ambiguous words: if a request hinges on a Hebrew word with several common senses (e.g. עדות = ethnic communities / אשכנזי־ספרדי vs courtroom testimony), ASK which meaning before saving. Do not assume בית משפט. For בדיחות על עדות without משפט/בית משפט, prefer ethnic communities or ask.",
    "Reminder item is an infinitive: להתאמן, לקנות חלב. Never claim saved unless reminders has add/update with a clock (new) or update of an existing clock (text/time).",
    "Before reminders add: only if this turn's active_reminders already has the SAME work by meaning, ASK מצאתי תזכורת קיימת ל«…». לעדכן אותה או להוסיף עוד אחת? Same time or the same every-N cadence alone is never a match (בדיחה על עדות כל 10 דקות ≠ חביתה כל 10 דקות → just add both). Unrelated clocks never trigger that ask. Do not invent that one exists. Empty reminders while asking.",
    "RELATED TO THESE items (קשורות למטלות האלה / לפריטים שמחקנו): answer only active clocks that match those items by meaning. If none, say none. Never list unrelated active clocks. Never invent past deletes or completed history — the system does not load it.",
    "Ask until the reminder schema is complete. Empty reminders while you ask. Recurring: every_count + every_unit. Weekdays: [1] = Monday (0=Sun … 6=Sat). date empty or YYYY-MM-DD.",
    "Delete reminder: one remove per name, no confirmed. Do not write the confirm question in response — the server asks. After yes: metadata.confirm=true, empty reminders. In response say the reminder(s) were deleted (past tense), naming them — never מאשרת/לאשר confirming language. If PENDING_ACTION_STATE is present, stay in that delete — names pick targets, not send.",
    "Delete many list items / מחק את כל המטלות / כל הקניות: emit lists.remove for each item. Do not write the confirm question — the server asks and holds. After yes: confirm=true, empty lists. In response: past tense that items were deleted, list every name from PENDING_ACTION_STATE current_target (e.g. נמחקו הפריטים הבאים מרשימת הקניות: …). Never מאשרת/לאשר/confirming — yes already confirmed. A single bought item (קניתי חלב) may remove immediately without confirm.",
    "Speaker still needs → query todos. Your tasks / your reminder jobs (להזכיר ל…) → query self from WORKER_SAVED_DATA. Ping clocks only → query reminders. Empty clocks ≠ you have no work.",
    "WHEN / TODAY / SOON (מה לעשות היום / מחר / יום שלישי / השבוע / בעוד שעתיים / בעוד יומיים): leave query empty. Use SESSION_CLOCK (Asia/Jerusalem). For אני / שלי / מה אני צריך — ONLY the speaker's own personal tasks + active_reminders in EMPLOYEE_SAVED_DATA (owner = current speaker). Do NOT use WORKER_SAVED_DATA (that is YOUR jobs — e.g. להזכיר למאיוש… is not the speaker's Tuesday plan). Do NOT use other owners' TEAM_SCHEDULES rows. Do NOT treat custom lists about someone else (e.g. שיעורי הנהיגה של מאיה) as the speaker's to-do for that day. מה את צריכה ביום X / what YOU need that day → ONLY this turn's WORKER_SAVED_DATA rows whose תאריך matches; if none, say you have nothing that day — do not resurrect prior-turn *saved* jobs (not the same as hold/PENDING_ACTION_STATE follow-ups). TEAM_SCHEDULES only when they ask about another person by name. Short intro + • lines. Empty timed window → «אין לך מטלות או תזכורות ביום שלישי» — never jargon like מטלות מתוזמנות. Undated open tasks only if they also asked מה יש לי לעשות in general.",
    "Status / דוח / what someone needs to buy or do / show a list: leave query empty. Answer fully in response from EMPLOYEE_SAVED_DATA (name the owner when relevant). Never emit query report. Format lists as short intro + one • item per line — not a paragraph. Current field values only — never dump שם חדש / update drafts. Bold with single *asterisks* (WhatsApp), never **. Shared lists: use scope/shared_with; say shared with those partners. Exact list_name matches only. כל מה ששמור עלי / סיכום מלא → full dump of shopping, tasks, custom lists, active reminders, filings+memory, contacts — not tasks alone.",
    "Answer in your response from this turn's saved data. The server does not write that answer — except known false delivery / list-type wording fixes. It does not append a mutation summary.",
    "After any save/send/remove, state clearly in response what you did — that text is what the user sees.",
    "If the speaker says they bought or already have a shopping item, remove it from shopping. If they finished a task (הכנתי / סיימתי / עשיתי / הכנתי חביתה), remove it from tasks — look up which list holds it in EMPLOYEE_SAVED_DATA. Never call a tasks item רשימת הקניות.",
    "list_type: shopping = things to buy (לקנות חלב). tasks = work to do (להכין חביתה, לשתות מים, לקחת ילדים). On remove/update, match the list_type of the saved row in EMPLOYEE_SAVED_DATA. response must say מטלות for tasks and קניות for shopping.",
    "Durable personal memory — file with add_filing in the same turn (do not only say אזכור): לשון פנייה/מגדר, משפחה (יש לי שני ילדים → file now, ages may come later via update), כתובת/עיר, מצב משפחתי, השכלה, מקצוע, מקום עבודה, pets/school/diet/allergies. Do NOT auto-file soft plans (חושב לנסוע / אולי). item_description usually = item_name. מה התיוקים שלי → explicit saves (codes/docs), not auto-memory unless מה את זוכרת עלי. Later turns: use filing silently when advising/addressing.",
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
      pendingAction: null,
      pendingTargets: Prisma.JsonNull,
      pendingStep: null,
      pendingAt: null,
    },
  });
}

async function loadPendingAction(
  conversationId: string,
): Promise<ConversationPendingAction | null> {
  const row = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: {
      pendingAction: true,
      pendingTargets: true,
      pendingStep: true,
      pendingAt: true,
    },
  });
  return conversationPendingFromStored(row);
}

async function savePendingAction(
  conversationId: string,
  pending: ConversationPendingAction | null,
): Promise<void> {
  const stored = pendingToStored(pending);
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: {
      pendingAction: stored.pendingAction,
      pendingTargets:
        stored.pendingTargets === null
          ? Prisma.JsonNull
          : (stored.pendingTargets as Prisma.InputJsonValue),
      pendingStep: stored.pendingStep,
      pendingAt: stored.pendingAt,
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

async function saveTurn(input: {
  conversationId: string;
  speaker: string;
  assistantSpeaker: string;
  message: string;
  reply: string;
  raw: unknown;
  request: unknown;
}): Promise<void> {
  const parsed = parseLlmReply(input.reply);
  const userAt = new Date();
  const assistantAt = new Date(userAt.getTime() + 1);

  await prisma.chatMessage.createMany({
    data: [
      {
        conversationId: input.conversationId,
        author: "you",
        speaker: input.speaker,
        text: input.message,
        createdAt: userAt,
      },
      {
        conversationId: input.conversationId,
        author: "assistant",
        speaker: input.assistantSpeaker,
        text: parsed.response,
        actions: Prisma.JsonNull,
        raw: toJsonValue(packStoredLlmRaw(input.request, input.raw)),
        createdAt: assistantAt,
      },
    ],
  });
}

async function appendAssistantNotice(
  conversationId: string,
  notice: string,
  mode: "append" | "replace" = "append",
): Promise<void> {
  const last = await prisma.chatMessage.findFirst({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) {
    return;
  }
  const nextText =
    mode === "replace" ? notice : `${last.text.trim()}\n\n${notice}`;
  await prisma.chatMessage.update({
    where: { id: last.id },
    data: { text: nextText },
  });
}

async function patchLastAssistantText(
  conversationId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const last = await prisma.chatMessage.findFirst({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
  });
  if (!last || last.text === trimmed) {
    return;
  }
  await prisma.chatMessage.update({
    where: { id: last.id },
    data: { text: trimmed },
  });
}

async function clearLastAssistantActions(conversationId: string): Promise<void> {
  const last = await prisma.chatMessage.findFirst({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) {
    return;
  }
  await prisma.chatMessage.update({
    where: { id: last.id },
    data: { actions: Prisma.JsonNull },
  });
}

/** Rewrite metadata.lists on an LLM JSON reply (e.g. drop held bulk removes). */
function setReplyLists(reply: string, lists: unknown[]): string {
  try {
    const parsed: unknown = JSON.parse(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { metadata?: unknown };
      const metadata =
        record.metadata &&
        typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : {};
      return JSON.stringify({
        ...record,
        metadata: { ...metadata, lists },
      });
    }
  } catch {
    /* plain text */
  }
  return reply;
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
  speaker: string;
  text: string;
  actions: string[];
  raw: unknown;
}): Promise<ChatThreadMessage> {
  const created = await prisma.chatMessage.create({
    data: {
      conversationId: input.conversationId,
      author: "assistant",
      speaker: input.speaker,
      text: input.text,
      actions: input.actions.length > 0 ? input.actions : Prisma.JsonNull,
      raw: toJsonValue(input.raw),
    },
  });

  return toThreadMessage(created);
}

async function markContextInjected(conversationId: string): Promise<void> {
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { contextInjectedAt: new Date() },
  });
}

async function pushTargetNotification(input: {
  userId: string;
  actor: PublicEmployee;
  target: PublicEmployee;
  metadata: LlmMetadata;
  purchased?: boolean;
  recipientIsOwner?: boolean;
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
  const text = fallbackNotificationText(input.actor, input.metadata, {
    purchased: input.purchased,
    recipientIsOwner: input.recipientIsOwner,
    ownerName: input.ownerName,
    partnerNames: input.partnerNames,
  });
  const raw = { notification: text };
  const message = await saveAssistantMessage({
    conversationId: conversation.id,
    speaker: input.assistantSpeaker ?? "Assistant",
    text,
    actions: [],
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
    [{ target: input.target, text }],
    input.actor.id,
  );
  return { notification, whatsappSkips: whatsappDelivery.skips };
}

export async function notifySharedItemEvents(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  events: SharedItemEvent[];
  assistantSpeaker?: string;
  digitalEmployeeId: string;
  alreadyNotifiedIds?: Set<string>;
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
    const event =
      events.find((item) => item.purchased) ??
      events.find((item) => item.listOwnerId === target.id) ??
      events[0];
    const owner = input.employees.find((item) => item.id === event.listOwnerId);
    const pushed = await pushTargetNotification({
      userId: input.userId,
      actor: input.actor,
      target,
      metadata: event.metadata,
      purchased: event.purchased,
      recipientIsOwner: event.listOwnerId === target.id,
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
}): Promise<{
  reply: string;
  raw: unknown;
  notifications: ChatThreadNotification[];
  answeredBy: string;
  timing: { llmMs: number; afterLlmMs: number };
  request: unknown;
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
  let conversation = await getOrCreateConversation(
    input.userId,
    input.employeeId,
    digital.id,
  );
  const waitingPending = await loadPendingAction(conversation.id);
  const waitingDeletes =
    waitingPending?.action === "delete_reminder" ? waitingPending : null;
  const guestSpeaker = isGuestEmployee(employee);
  const speakerContacts = guestSpeaker
    ? []
    : await listContactsForEmployee(input.employeeId);
  const recentOutbound = guestSpeaker
    ? []
    : await listRecentReminderOutbounds({
        userId: input.userId,
        employeeId: input.employeeId,
      });
  const context = [
    formatSessionClockContext(),
    formatEmployeeContext(await getEmployeeRecordSnapshot(input.employeeId)),
    guestSpeaker
      ? ""
      : formatEmployeeContext(
          await getEmployeeRecordSnapshot(digital.id, {
            scopeItemsToViewerId: input.employeeId,
          }),
          "WORKER_SAVED_DATA",
        ),
    guestSpeaker ? "" : formatSpeakerContacts(speakerContacts),
    guestSpeaker ? "" : formatTeamSchedules(await getTeamSchedules(input.employeeId)),
    guestSpeaker ? "" : formatRecentOutboundContext(recentOutbound),
    formatConversationPendingContext(waitingPending),
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
        "GUEST MODE: The SPEAKER is a WhatsApp guest (אורח) — not you. You are still לוסי.",
        "Never say אני אורחת / אני רק אורחת / I'm a guest. Speak TO them (second person) or use impersonal Hebrew.",
        "Allowed ONLY: answer about lists/filings already shared with them in this turn's EMPLOYEE_SAVED_DATA (scope=shared). Show items, say if empty, confirm a named shared list exists.",
        "Forbidden: weather, chitchat, advice, jokes, shopping adds, tasks, reminders, messages, directory, filings, anything not about those shared lists.",
        "Off-topic (הים גלי / מה שלומך / ספרי בדיחה / anything outside shared lists) → response exactly or nearly: «אני יכולה לעזור רק עם הרשימות ששותפו איתך.» Empty lists/filing/reminders/messages/directory.",
        "Add/update/delete/buy/remind/send while guest → response: «אפשר רק לצפות ברשימות ששותפו איתך — בלי להוסיף או לשנות.» Empty metadata arrays.",
        "lists/filing/reminders/directory/messages must always stay []. Do not invent private data.",
      ].join("\n")
    : "";
  const instructions = attachLucyEngine
    ? [
        config.systemMessage,
        `The user is chatting as ${speaker}.`,
        guestModeInstructions ||
          workerTargetingInstructions(employees, speaker, digital),
        guestSpeaker
          ? "GUEST MODE: shared-list Q&A only. Never claim you (Lucy) are the guest. Off-topic → «אני יכולה לעזור רק עם הרשימות ששותפו איתך.»"
          : "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
        "EMPLOYEE_SAVED_DATA is the speaker's visible saved items. WORKER_SAVED_DATA is YOUR lists and tasks. Do not invent items.",
        guestSpeaker
          ? ""
          : "filing inside EMPLOYEE_SAVED_DATA is durable memory + explicit saves. Use memory silently (family, לשון פנייה, job…). מה התיוקים שלי → prefer codes/docs/explicit תתיקי; מה את זוכרת עלי → memory rows. Do not claim you lack a fact that appears there.",
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
          : "If asked what the speaker still needs to buy, use only shopping in EMPLOYEE_SAVED_DATA. Format: short intro + one • item per line (e.g. ברשימת הקניות שלך:\\n• חלב\\n• שוקו). Not a paragraph.",
        guestSpeaker
          ? ""
          : "If asked what ANOTHER person needs to buy or do (מה טל צריך לקנות / מה יש למיכל במטלות): leave query empty. Answer from EMPLOYEE_SAVED_DATA for that owner — same bullet layout; e.g. «טל צריך לקנות:\\n• שוקו».",
        guestSpeaker
          ? ""
          : "If asked what you still need to do, which tasks you have, or what YOUR reminders are, set metadata.query = \"self\" and answer from THIS turn's WORKER_SAVED_DATA only. Worker להזכיר-ל / לשלוח-הודעה jobs count only if listed there now — do not invent saved jobs from earlier chat. PENDING_ACTION_STATE / hold drafts are unrelated and stay active. List jobs one • per line.",
        "USER-FACING LANGUAGE: echo the speaker's words for any saved thing (תזכורות / מטלות / קניות / תיוק). Never rename their category or explain storage. Never say schema words (query, sections, clocks, metadata, list_name).",
        "Status / דוח / מה יש לי / show a list: write the full answer in response from EMPLOYEE_SAVED_DATA. Never emit query report — the server no longer formats reports. Use short intro + one • item per line; never a dense paragraph. כל מה ששמור / סיכום מלא → FULL DUMP layout (all sections), not tasks only.",
        "WHEN / TODAY / SOON (מה לעשות היום / מחר / יום שלישי / השבוע / בעוד שעתיים): leave query empty. SESSION_CLOCK for the window. אני/שלי → only the speaker's own personal tasks + active_reminders in EMPLOYEE_SAVED_DATA. Never WORKER_SAVED_DATA (your jobs like להזכיר למאיוש… are not theirs). Never other owners' TEAM_SCHEDULES. Never custom lists about someone else (שיעורי הנהיגה של מאיה) as their day plan. מה את צריכה ביום X → only THIS turn's WORKER rows with matching תאריך; missing → nothing that day (ignore older *saved* claims only — not hold/PENDING follow-ups like היי after מה תרצה שאשלח). Ask about X by name → that person's visible rows. Empty timed window → «אין לך מטלות או תזכורות ב…». Never מטלות מתוזמנות. Undated open tasks only for a general מה יש לי לעשות.",
        "הציגי את הרשימות שלי / show my lists: one block per list — header (list_name + shared_with if shared), then • items with CURRENT field values only; blank line between lists. Never one run-on paragraph. Empty → «ריקה».",
        "FULL DUMP / כל מה ששמור עלי / סיכום מלא / everything saved about me: leave query empty. From THIS turn's EMPLOYEE_SAVED_DATA (+ SPEAKER_CONTACTS): cover shopping, tasks/meetings, each custom list, active_reminders, all filing (explicit + memory), contacts — every section even if empty (say ריק). Do not answer with tasks only. • bullets; no schema jargon.",
        "Show a named list / הציגי את רשימת X / שיעורי נהיגה של מאיה: enumerate that list's items from EMPLOYEE_SAVED_DATA — one • line per item with the live value only (never «שם + שם חדש» / update drafts). Never reply with only the owner name — owner is whose list it is; the answer is the items. Speak Hebrew only — never list_name / list_type / metadata. items=[] → say the list is empty.",
        "SHARED LISTS: use scope + shared_with from EMPLOYEE_SAVED_DATA. Shared → say משותפת and name shared_with partners; never «של עמית» alone if the speaker is in shared_with. הציגי רשימות משותפות → only scope=shared. Exact list_name for יש רשימת X (בעיות ≠ באגים).",
        "Bold in response: single *asterisks* only (WhatsApp). Never **double** asterisks.",
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
          : "If PENDING_ACTION_STATE is present: stay inside that action. current_step=confirm → delete confirm only (delete_reminder or delete_lists — not a send). current_step=awaiting_fields → the speaker's short reply fills missing_field for known_draft; complete it (hold=null) — never לא הבנתי. Cancel that draft (לא / בטל / אל תשלחי / cancel / בעצם לא) → hold=null and empty directory/lists/reminders/filing/messages; do not finish the unfinished save/send. Yes → confirm=true and empty reminders/lists; in response report past-tense deletion naming current_target (נמחקו… / מחקתי את התזכורת…) — never מאשרת/לאשר. No → confirm=false. Do not start unrelated work until the server clears the state.",
        guestSpeaker
          ? "If asked what you can do: «אני יכולה להציג רק רשימות ששותפו איתך.» Nothing else."
          : "If asked what you can do, list every capability. Saved data does not limit that answer.",
        "Ignore older shopping lists, tasks, or reminders from earlier turns when they conflict with EMPLOYEE_SAVED_DATA.",
        guestSpeaker
          ? ""
          : "query reminders = ping clocks only (active_reminders). Empty active clocks does not mean you have no reminder jobs — those live in WORKER_SAVED_DATA.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : [
        config.systemMessage,
        guestModeInstructions,
        thinSessionEnvelope({
          employees,
          speaker,
          worker: digital,
          speakerIsOwner: employee.isOwner === true,
        }),
      ]
        .filter(Boolean)
        .join("\n\n");
  const message = [
    context,
    `${speaker}: ${input.message}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    let turn;
    const llmStarted = Date.now();
    let openaiRequest = buildOpenAiRequest({
      conversationId: conversation.openaiConversationId,
      message,
      model: config.model,
      temperature: config.temperature,
      instructions,
      textFormat: config.responseFormat,
    });
    try {
      turn = await client.createResponse({
        conversationId: conversation.openaiConversationId,
        message,
        model: config.model,
        temperature: config.temperature,
        instructions,
        textFormat: config.responseFormat,
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
        instructions,
        textFormat: config.responseFormat,
      });
      turn = await client.createResponse({
        conversationId: conversation.openaiConversationId,
        message,
        model: config.model,
        temperature: config.temperature,
        instructions,
        textFormat: config.responseFormat,
      });
    }
    const llmMs = Date.now() - llmStarted;
    const afterLlmStarted = Date.now();
    await recordLlmUsage({
      conversationId: conversation.id,
      employeeId: employee.id,
      digitalEmployeeId: digital.id,
      openaiConversationId: conversation.openaiConversationId,
      model: config.model,
      turn,
    });
    await saveTurn({
      conversationId: conversation.id,
      speaker,
      assistantSpeaker,
      message: input.message,
      reply: turn.reply,
      raw: turn.raw,
      request: openaiRequest,
    });

    const parsedMetadata = parseReplyMetadata(turn.reply);
    let metadata = resolveSpokenMetadata(
      input.message,
      parsedMetadata,
      humans,
      employee.id,
    );
    let serverFilledSendText = "";
    let cancelledAwaitingHold = false;
    if (
      !guestSpeaker &&
      isAwaitingFieldsHold(waitingPending) &&
      isPendingHoldCancelText(input.message)
    ) {
      cancelledAwaitingHold = true;
      metadata = metadataAfterHoldCancel(metadata);
    }
    if (!guestSpeaker && !cancelledAwaitingHold) {
      const filledMessages = fillMessagesFromPendingHold(
        waitingPending,
        metadata.messages ?? [],
        input.message,
      );
      if (filledMessages) {
        serverFilledSendText = input.message.trim();
        metadata = {
          ...metadata,
          messages: filledMessages,
          hold: null,
        };
      }
    }
    if (!guestSpeaker && !cancelledAwaitingHold) {
      const filledLists = fillListsFromPendingHold(
        waitingPending,
        metadata.lists ?? [],
        input.message,
        metadata.confirm ?? null,
      );
      if (filledLists) {
        metadata = {
          ...metadata,
          lists: filledLists,
          hold: null,
          confirm: null,
        };
      }
    }
    if (!guestSpeaker && !cancelledAwaitingHold) {
      const filledReminders = fillRemindersFromPendingHold(
        waitingPending,
        metadata.reminders ?? [],
        input.message,
      );
      if (filledReminders) {
        metadata = {
          ...metadata,
          reminders: filledReminders,
          hold: null,
        };
      }
    }
    if (!guestSpeaker && !cancelledAwaitingHold) {
      const alignedLists = alignListTargetsWithMessageRecipients({
        lists: metadata.lists ?? [],
        messages: metadata.messages ?? [],
        speakerName: employeeDisplayName(employee),
      });
      if (alignedLists !== metadata.lists) {
        metadata = { ...metadata, lists: alignedLists };
      }
    }
    const listPlan = planListDeletes({
      lists: metadata.lists ?? [],
      confirm: metadata.confirm ?? null,
      stored: waitingPending,
    });
    const metadataForApply = {
      ...metadata,
      lists: listPlan.applyLists,
    };
    const sharedLists = await listSharedCustomListsForActor(
      input.userId,
      employee.id,
    );
    const plan = planTargetedActions({
      actor: employee,
      employees: humans,
      workers: digitalEmployees(employees),
      metadata: metadataForApply,
      sharedLists,
    });
    const relays = planRelayDeliveries({
      actor: employee,
      sender: digital,
      employees,
      messages:
        guestSpeaker || cancelledAwaitingHold
          ? []
          : resolveRelayMessages(metadata.messages ?? []),
    });

    const collectedEvents: SharedItemEvent[] = [];
    const listMutations: ListItemMutation[] = [];
    const filingMutations: FilingMutation[] = [];
    const cancelledReminders: string[] = [];
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
      cancelledReminders.push(...applied.cancelledReminders);
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
      cancelledReminders.push(...recovered.cancelledReminders);
    }
    const guestMutationNotice =
      guestSpeaker &&
      ((metadata.lists?.length ?? 0) > 0 ||
        (metadata.filing?.length ?? 0) > 0 ||
        (metadata.reminders?.length ?? 0) > 0 ||
        (metadata.directory?.length ?? 0) > 0 ||
        (parsedMetadata.messages?.length ?? 0) > 0 ||
        plan.guestMutationBlocked)
        ? "אפשר רק לצפות ברשימות ששותפו איתך — בלי להוסיף או לשנות."
        : "";
    const abandonPending = Boolean(
      waitingDeletes &&
        hasUnrelatedWorkWhilePending({
          confirm: metadata.confirm ?? null,
          reminders: metadata.reminders ?? [],
          messages: metadata.messages ?? [],
          lists: metadata.lists ?? [],
          filing: metadata.filing ?? [],
        }),
    );
    const reminderPlan = planReminderWrites(
      guestSpeaker ? [] : metadata.reminders ?? [],
      metadata.confirm ?? null,
      waitingDeletes,
      { abandonPending },
    );
    const nextPending = resolveNextPending({
      stored: cancelledAwaitingHold ? null : waitingPending,
      hold: guestSpeaker || cancelledAwaitingHold ? null : metadata.hold ?? null,
      reminderNext: reminderPlan.nextPending,
      listDeleteNext: listPlan.nextPending,
      directory: guestSpeaker ? [] : metadata.directory ?? [],
      lists: guestSpeaker ? [] : metadata.lists ?? [],
      reminders: guestSpeaker ? [] : metadata.reminders ?? [],
      filing: guestSpeaker ? [] : metadata.filing ?? [],
      messages: guestSpeaker || cancelledAwaitingHold ? [] : metadata.messages ?? [],
      confirm: metadata.confirm ?? null,
    });
    const incompleteGitDigests = (metadata.reminders ?? []).filter(
      (row) =>
        row.action === "add" &&
        row.composeSource === "git_log" &&
        !row.time.trim() &&
        !(typeof row.inSeconds === "number" && row.inSeconds > 0) &&
        !(row.everyCount && row.everyUnit) &&
        !(row.weekdays && row.weekdays.length > 0),
    );
    const pendingAfterGit =
      !guestSpeaker &&
      !cancelledAwaitingHold &&
      !nextPending &&
      incompleteGitDigests.length > 0
        ? pendingHoldFromLlm({
            kind: "reminders",
            need: "time",
            directory: [],
            lists: [],
            reminders: incompleteGitDigests,
            filing: [],
            messages: [],
          })
        : nextPending;
    await savePendingAction(conversation.id, pendingAfterGit);
    const reminderResult = await applyReminders({
      userId: input.userId,
      actor: employee,
      employees: humans,
      reminders: reminderPlan.apply,
      contacts: speakerContacts,
    });
    const directoryResult = guestSpeaker
      ? { saved: [], removed: [] }
      : await applyDirectoryActions({
          userId: input.userId,
          ownerEmployeeId: employee.id,
          actions: metadata.directory ?? [],
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
    await linkRemindersToWorkerTasks(
      reminderResult.saved.map((row) => ({
        id: row.id,
        itemKey: row.itemKey,
        itemLabel: row.itemLabel,
      })),
      workerItems,
    );
    recordWhatsAppEvent(
      "reminder_apply",
      `worker=${digital.name} query=${metadata.query ?? "none"} incoming=${metadata.reminders?.length ?? 0} apply=${reminderPlan.apply.length} saved=${reminderResult.saved.length} skipped=${reminderResult.skipped.length} ping=${reminderResult.saved.map((row) => row.ping).filter(Boolean).join("|") || "none"}`,
    );
    const confirmAsk = [
      formatReminderConfirmNotice(
        reminderPlan.ask,
        reminderPlan.cancelled,
        reminderPlan.noneToDelete,
      ),
      formatListDeleteConfirmNotice(listPlan.askLabels, listPlan.cancelled),
    ]
      .filter(Boolean)
      .join("\n");

    const phoneRelays = planPhoneRelays(
      guestSpeaker || cancelledAwaitingHold ? [] : metadata.messages ?? [],
      employees,
      employee.id,
      refreshedContacts,
    );
    const outbound = planOutboundSends({
      relays: guestSpeaker || cancelledAwaitingHold ? [] : relays,
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
        recipientIsOwner: true,
        partnerNames: notification.partnerNames,
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
    });
    for (const notification of sharedNotify.notifications) {
      if (notified.has(notification.employeeId)) {
        continue;
      }
      notified.add(notification.employeeId);
      notifications.push(notification);
    }
    sharedWhatsAppSkips.push(...sharedNotify.whatsappSkips);

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
    const relayed = new Set<string>();
    for (const relay of attributedRelays) {
      const key = `${relay.employeeId}:${relay.digitalEmployeeId}`;
      if (relayed.has(key)) {
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
    const waRelays = await deliverWhatsAppRelays(attributedRelays, employee.id);
    const waPhones = await deliverWhatsAppPhones(attributedPhones);
    // Partner shared-list notify skips must not erase the speaker's spoken reply.
    // replaceSpoken is only for intentional outbound sends the model claimed to deliver.
    const outboundSkips = [...waRelays.skips, ...waPhones.skips];
    const skips = [...sharedWhatsAppSkips, ...outboundSkips];
    const whatsappNotice = formatWhatsAppSkipNotice(skips);
    const missingSend = formatMissingSendTextNotice(metadata.messages ?? []);
    if (!guestSpeaker && missingSend) {
      const sendHold = pendingHoldFromMissingMessages(metadata.messages ?? []);
      if (sendHold) {
        await savePendingAction(conversation.id, sendHold);
      }
    }
    const deliveryFailed = formatWhatsAppSkipNotice(outboundSkips).length > 0;
    const confirmPending =
      reminderPlan.ask.length > 0 || listPlan.askLabels.length > 0;
    let workingReply = alignListTypeInReply(turn.reply, listMutations);
    // Held bulk list deletes are not applied — hide their actions from the reply.
    if (listPlan.askLabels.length > 0) {
      workingReply = setReplyLists(workingReply, listPlan.applyLists);
    }
    // Empty LLM response must not leak raw JSON / blank bubble to the user.
    if (!parseLlmReply(workingReply).response.trim()) {
      const fallback =
        confirmAsk ||
        guestMutationNotice ||
        (metadata.confirm === false
          ? "ביטלתי את המחיקה."
          : metadata.confirm === true
            ? "בוצע."
            : "") ||
        formatAppliedMutationFallback(listMutations, filingMutations);
      if (fallback) {
        workingReply = setEngineResponse(workingReply, fallback);
      }
    }
    // Model often claims «הסרתי» even when no row matched — correct that.
    const requestedCustomRemove = (metadata.lists ?? []).some(
      (row) => row.action === "remove" && row.listType === "custom",
    );
    const appliedCustomRemove = listMutations.some(
      (row) =>
        row.action === "remove" && row.listType === "custom" && !row.listShell,
    );
    if (requestedCustomRemove && !appliedCustomRemove) {
      workingReply = setEngineResponse(
        workingReply,
        "לא מצאתי את הפריט למחיקה ברשימה.",
      );
    } else if (
      requestedCustomRemove &&
      appliedCustomRemove &&
      !parseLlmReply(workingReply).response.trim()
    ) {
      workingReply = setEngineResponse(
        workingReply,
        formatAppliedMutationFallback(listMutations, filingMutations),
      );
    }
    // Do not append apply-summary lines — the spoken reply is the model's response only.
    if (serverFilledSendText) {
      const dests = (metadata.messages ?? [])
        .flatMap((row) => row.targets)
        .map((name) => name.trim())
        .filter(Boolean);
      const destLabel =
        dests.length === 1 ? `ל«${dests[0]}»` : dests.length > 1 ? "להם" : "";
      workingReply = setEngineResponse(
        workingReply,
        destLabel
          ? `שלחתי ${destLabel}: «${serverFilledSendText}».`
          : `שלחתי: «${serverFilledSendText}».`,
      );
    }
    if (cancelledAwaitingHold && isAwaitingFieldsHold(waitingPending)) {
      workingReply = setEngineResponse(
        workingReply,
        formatCancelledHoldReply(waitingPending),
      );
    }
    const noTimeSkipped = reminderResult.skipped.some(
      (row) => row.reason === "no_time",
    );
    if (noTimeSkipped || incompleteGitDigests.length > 0) {
      workingReply = setEngineResponse(
        workingReply,
        "מתי לשלוח — עכשיו, בעוד X, או בשעה קבועה?",
      );
    }
    const reminderApplyNotice = formatReminderApplyNotice(reminderResult);
    const notice = [
      confirmPending ? "" : confirmAsk,
      guestMutationNotice,
      missingSend,
      whatsappNotice,
      noTimeSkipped ? "" : reminderApplyNotice,
    ]
      .filter(Boolean)
      .join("\n\n");
    const alignedSpoken = parseLlmReply(workingReply).response;
    if (alignedSpoken !== parseLlmReply(turn.reply).response) {
      await patchLastAssistantText(conversation.id, alignedSpoken);
    }
    const replaceSpoken = deliveryFailed || confirmPending;
    const composeNotice = confirmPending ? confirmAsk : notice;
    const reply = composeAssistantReply({
      llmReply: workingReply,
      notice: composeNotice,
      replaceResponse: replaceSpoken,
    });
    if (composeNotice) {
      await appendAssistantNotice(
        conversation.id,
        composeNotice,
        replaceSpoken ? "replace" : "append",
      );
    }
    // Never show English metadata action chips on the speaker bubble.
    await clearLastAssistantActions(conversation.id);

    if (conversation.needsContext) {
      await markContextInjected(conversation.id);
    }
    if (!input.skipHandoffFollow) {
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
