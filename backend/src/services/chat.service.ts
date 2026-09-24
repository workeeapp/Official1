import { Prisma, type ChatMessage as ChatMessageRow } from "@prisma/client";
import {
  digitalEmployees,
  humanEmployees,
  parseLlmReply,
  parseReplyMetadata,
  type ChatHistoryResponse,
  type ChatThreadMessage,
  type ChatThreadNotification,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { loadLlmConfig, type LlmConfig } from "../config/llm.js";
import { ValidationError } from "../utils/errors.js";
import { prisma } from "../database/prisma.js";
import {
  isContextTooLargeError,
  isUniqueConstraintError,
  missingTableName,
  ServiceUnavailableError,
} from "../utils/errors.js";
import {
  applyEmployeeMetadata,
  formatEmployeeContext,
  formatTeamSchedules,
  getEmployeeRecordSnapshot,
  getTeamSchedules,
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
} from "./employee-targets.service.js";
import { phonesMatch } from "../utils/phone.js";
import { publishChatEvent } from "./chat-events.service.js";
import { getLlmClient, toPlainJson } from "./llm-client.js";
import {
  applyReminders,
  formatActiveRemindersReply,
  formatReminderApplyNotice,
  formatReminderConfirmNotice,
  listVisibleReminders,
  pendingReminderDeleteNames,
  planReminderWrites,
} from "./reminder.service.js";
import {
  composeAssistantReply,
  deliverWhatsAppPhones,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
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

export const CONVERSATION_IDLE_MS = 60 * 60 * 1000;

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
    raw: lastAssistant?.raw ?? null,
    isNew: conversation.messages.length === 0,
  };
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

function llmConfigForDigital(digital?: PublicEmployee): LlmConfig {
  const fileConfig = loadLlmConfig();
  if (digital?.protected) {
    return {
      model: digital.model ?? fileConfig.model,
      temperature: digital.temperature ?? fileConfig.temperature,
      systemMessage: digital.instructions?.trim() || fileConfig.systemMessage,
      responseFormat: fileConfig.responseFormat,
    };
  }

  if (digital?.model && digital.instructions?.trim()) {
    return {
      model: digital.model,
      temperature: digital.temperature ?? 0,
      systemMessage: digital.instructions,
    };
  }

  return fileConfig;
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

function isDavidEmployee(employee: PublicEmployee): boolean {
  if (employee.protected || employee.kind === "human") {
    return false;
  }
  const label = `${employee.name} ${employee.surname ?? ""} ${employee.nickname ?? ""}`;
  return label.includes("דוד") || label.includes("ליצן");
}

function davidTargetingInstructions(
  employees: PublicEmployee[],
  speaker: string,
): string {
  const names = employees.map(employeeDisplayName).join(", ");
  return [
    `Known employees: ${names}. Current speaker: ${speaker}.`,
    "Never ask whether to save as a task list or as a reminder only.",
    "A reminder request always means: list item + clock. Infer shopping vs tasks yourself.",
    "Reminder item is an infinitive to-do: להתאמן, לקנות חלב. Never imperative (התאמן).",
    "Never claim a reminder is saved unless metadata.reminders has action add with in (seconds number) or time (HH:mm).",
    "Ask until the reminder schema is complete, then emit it. Empty reminders while you ask. Recurring: every_count + every_unit. Weekdays: [1] = Monday (0=Sun … 6=Sat). time HH:mm. date empty or YYYY-MM-DD. Delete: one remove per item name from this turn's saved reminders — never item all. If unsure which names, ask.",
    "If the speaker wants to speak with another digital employee — any wording — set metadata.handoff to { \"worker\": \"<their name>\" }. Telling someone something is messages, not handoff.",
    "ping and messages.targets may be employee names or phone numbers. A number is a WhatsApp destination.",
    "A one-time WhatsApp now to a number → metadata.messages with that number in targets and the text. A later ping to a number → reminders.ping with that number.",
    "If they want to send or remind someone whose name is not in Known employees, ASK for their WhatsApp number. Do not emit messages or reminders until ping/targets has digits. Do not say you sent or saved.",
    "If they want to send someone a message but did not say the words, ASK what to send. You may offer שלום. Do not invent text. Empty messages and reminders while you ask.",
    "Delete: emit remove names, no confirmed. After they say yes, emit only metadata.confirm=true — do not emit remove again and do not re-ask. Saved reminder data is from before this turn.",
    "If they want to see current reminders — any wording — set metadata.query to \"reminders\". The server lists them from the database.",
  ].join("\n");
}

function targetingInstructions(
  employees: PublicEmployee[],
  speaker: string,
): string {
  const names = employees.map(employeeDisplayName).join(", ");
  return [
    `Known employees: ${names}.`,
    `Current speaker: ${speaker}.`,
    'If the speaker assigns an action to another employee or to everyone, set targets on that action to those names or ["all"]. The server will not infer targets from the sentence.',
    'Example: "טל צריך לקנות חלב" → shopping add, targets: ["טל"].',
    'Example: "טל צריך לקחת את הילדים לגינה" → tasks add, targets: ["טל"].',
    'Example: "כולם צריכים לקנות חלב" → targets: ["all"].',
    `Example: "שמור פגישה עם טל ביום ראשון בשעה 10" → tasks add, targets: ["${speaker}", "טל"].`,
    "A meeting WITH someone must include the current speaker and every named participant in targets.",
    "If the speaker gives a meeting date without a time and did not say all-day / יום שלם, ask before saving.",
    "If omitted on a normal list item, the action applies only to the current speaker.",
    "If asked what you can do, list: lists of any kind, a task list, meetings, filings, and messages. Meetings are not part of the task list. Do not shorten it for this speaker.",
    "If the speaker asks you to send, check, ask, or tell another employee (human or digital) something, add metadata.messages.",
    'Example: "תשלחי הודעה לטל - מה שלומך?" → messages: [{ "targets": ["טל"], "text": "עמית שואל מה שלומך?\\nמה לענות לו?" }].',
    'Example: "תבדקי עם טל אם הוא קנה שמן" → messages: [{ "targets": ["טל"], "text": "עמית שואל אם קנית שמן?" }].',
    "Write metadata.messages[].text for the recipient, in second person, and mention the speaker by name.",
    "Do not turn a send/check request into a list or task unless they also asked to add one.",
    "If there are no messages to send, metadata.messages = [].",
    "messages.targets may be employee names or a phone number. A number is a WhatsApp destination, not an employee name.",
    "If they name someone who is not in Known employees, ask for that person's WhatsApp number. Do not emit messages until you have digits.",
    "If they ask to send a message but did not say what it should say, ask what to send. You may offer שלום. Do not invent text. Do not emit metadata.messages until they give words or agree to שלום. Asking 'is this the wording?' with messages filled still sends — leave messages empty while you ask.",
    "You are לוסי (woman). First-person Hebrew is feminine only: מעבירה, מוסיפה, שומרת, שואלת — never מעביר or מוסיף.",
    "If the speaker wants to speak with, switch to, or be transferred to another digital employee — any wording — set metadata.handoff to { \"worker\": \"<their name>\" } and confirm in feminine Hebrew (מעבירה אותך לדוד, not מעביר).",
    "Do not use metadata.messages for a conversation switch. Asking you to tell or send someone something is messages, not handoff.",
    "If they ask which digital workers exist, name them from Known employees. No handoff unless they chose one.",
    "Reminders are דוד (also called הליצן — same person). Create, change, or delete a reminder → metadata.handoff { \"worker\": \"דוד\" }. Never say you saved a reminder.",
    "Which reminders exist now — any wording — → metadata.query = \"reminders\". The server lists them from the database. Do not invent names.",
    "If the speaker says they bought or already have an item, remove it from their shopping list.",
    "When asked what someone still needs, answer only from EMPLOYEE_SAVED_DATA. Never mention items that are not listed there.",
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

async function saveTurn(input: {
  conversationId: string;
  speaker: string;
  assistantSpeaker: string;
  message: string;
  reply: string;
  raw: unknown;
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
        actions: parsed.actions.length > 0 ? parsed.actions : Prisma.JsonNull,
        raw: toJsonValue(input.raw),
        createdAt: assistantAt,
      },
    ],
  });
}

async function replaceAssistantText(
  conversationId: string,
  text: string,
): Promise<void> {
  const last = await prisma.chatMessage.findFirst({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) {
    return;
  }
  await prisma.chatMessage.update({
    where: { id: last.id },
    data: { text },
  });
}

async function appendAssistantNotice(
  conversationId: string,
  notice: string,
): Promise<void> {
  const last = await prisma.chatMessage.findFirst({
    where: { conversationId, author: "assistant" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) {
    return;
  }
  await prisma.chatMessage.update({
    where: { id: last.id },
    data: { text: `${last.text.trim()}\n\n${notice}` },
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
  assistantSpeaker?: string;
  digitalEmployeeId: string;
}): Promise<ChatThreadNotification> {
  const conversation = await getOrCreateConversation(
    input.userId,
    input.target.id,
    input.digitalEmployeeId,
  );
  const text = fallbackNotificationText(input.actor, input.metadata, {
    purchased: input.purchased,
    recipientIsOwner: input.recipientIsOwner,
    ownerName: input.ownerName,
  });
  const actions = parseLlmReply(
    JSON.stringify({
      response: text,
      metadata: input.metadata,
    }),
  ).actions;
  const raw = { notification: text };
  const message = await saveAssistantMessage({
    conversationId: conversation.id,
    speaker: input.assistantSpeaker ?? "Assistant",
    text,
    actions,
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
  return notification;
}

export async function notifySharedItemEvents(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  events: SharedItemEvent[];
  assistantSpeaker?: string;
  digitalEmployeeId: string;
}): Promise<ChatThreadNotification[]> {
  const notified = new Set<string>();
  const notifications: ChatThreadNotification[] = [];
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
    notifications.push(
      await pushTargetNotification({
        userId: input.userId,
        actor: input.actor,
        target,
        metadata: event.metadata,
        purchased: event.purchased,
        recipientIsOwner: event.listOwnerId === target.id,
        ownerName: owner ? employeeDisplayName(owner) : undefined,
        assistantSpeaker: input.assistantSpeaker,
        digitalEmployeeId: input.digitalEmployeeId,
      }),
    );
  }

  return notifications;
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
}): Promise<{
  reply: string;
  raw: unknown;
  notifications: ChatThreadNotification[];
  answeredBy: string;
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
  const waitingDeletes = pendingReminderDeleteNames(conversation.id);
  const context = [
    formatEmployeeContext(await getEmployeeRecordSnapshot(input.employeeId)),
    formatTeamSchedules(await getTeamSchedules(input.userId)),
    waitingDeletes.length > 0
      ? `REMINDER_DELETE_WAITING: ${waitingDeletes.join(", ")}. These are not deleted yet. If the speaker confirmed, set metadata.confirm=true and leave reminders empty. Do not list them as still active.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const instructions = [
    config.systemMessage,
    `The user is chatting as ${speaker}.`,
    isDavidEmployee(digital)
      ? davidTargetingInstructions(employees, speaker)
      : targetingInstructions(employees, speaker),
    "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
    "EMPLOYEE_SAVED_DATA in this user message is the only source of truth for saved items.",
    "If asked what someone still needs to buy, use only current shopping lists in EMPLOYEE_SAVED_DATA.",
    "If asked what you can do, list every capability. Saved data does not limit that answer.",
    "Ignore older shopping lists, tasks, or reminders from earlier turns when they conflict with EMPLOYEE_SAVED_DATA.",
    "If asked which reminders exist now, list only status=active from this turn. Missing from active_reminders means deleted.",
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
      turn = await client.createResponse({
        conversationId: conversation.openaiConversationId,
        message,
        model: config.model,
        temperature: config.temperature,
        instructions,
        textFormat: config.responseFormat,
      });
    }
    await saveTurn({
      conversationId: conversation.id,
      speaker,
      assistantSpeaker,
      message: input.message,
      reply: turn.reply,
      raw: turn.raw,
    });

    const parsedMetadata = parseReplyMetadata(turn.reply);
    const metadata = resolveSpokenMetadata(
      input.message,
      parsedMetadata,
      humans,
      employee.id,
    );
    const plan = planTargetedActions({
      actor: employee,
      employees: humans,
      metadata,
    });
    const relays = planRelayDeliveries({
      actor: employee,
      sender: digital,
      employees,
      messages: resolveRelayMessages(parsedMetadata.messages ?? []),
    });

    const collectedEvents: SharedItemEvent[] = [];
    for (const application of plan.applications) {
      collectedEvents.push(
        ...(await applyEmployeeMetadata(
          application.employeeId,
          application.metadata,
          application.visibility,
          employee.id,
        )),
      );
    }
    const visibleReminders = prisma.reminder
      ? await listVisibleReminders(input.userId, employee.id, humans)
      : [];
    const reminderPlan = planReminderWrites(
      conversation.id,
      metadata.reminders ?? [],
      metadata.confirm ?? null,
    );
    const reminderResult = await applyReminders({
      userId: input.userId,
      actor: employee,
      employees: humans,
      reminders: reminderPlan.apply,
    });
    recordWhatsAppEvent(
      "reminder_apply",
      `worker=${digital.name} query=${metadata.query ?? "none"} incoming=${metadata.reminders?.length ?? 0} apply=${reminderPlan.apply.length} saved=${reminderResult.saved.length} skipped=${reminderResult.skipped.length} ping=${reminderResult.saved.map((row) => row.ping).filter(Boolean).join("|") || "none"}`,
    );
    const confirmAsk = formatReminderConfirmNotice(
      reminderPlan.ask,
      reminderPlan.cancelled,
      reminderPlan.noneToDelete,
    );
    const reminderNotice = [
      confirmAsk,
      formatReminderApplyNotice(reminderResult),
    ]
      .filter(Boolean)
      .join("\n");

    const phoneRelays = planPhoneRelays(
      parsedMetadata.messages ?? [],
      employees,
      employee.id,
    );
    const outbound = planOutboundSends({
      relays,
      phones: phoneRelays,
    });
    if (outbound.held) {
      recordWhatsAppEvent(
        "outbound_held",
        "spoken reply is still a question",
      );
    }

    const notifications = await notifySharedItemEvents({
      userId: input.userId,
      actor: employee,
      employees: humans,
      events: collectedEvents,
      assistantSpeaker,
      digitalEmployeeId: digital.id,
    });
    const notified = new Set(notifications.map((item) => item.employeeId));

    for (const notification of plan.notifications) {
      if (notified.has(notification.employee.id) || notification.employee.id === employee.id) {
        continue;
      }
      notified.add(notification.employee.id);
      notifications.push(
        await pushTargetNotification({
          userId: input.userId,
          actor: employee,
          target: notification.employee,
          metadata: notification.metadata,
          recipientIsOwner: true,
          assistantSpeaker,
          digitalEmployeeId: digital.id,
        }),
      );
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
    const skips = [
      ...(await deliverWhatsAppRelays(attributedRelays, employee.id)),
      ...(await deliverWhatsAppPhones(attributedPhones)),
    ];
    const missingSend = formatMissingSendTextNotice(
      parsedMetadata.messages ?? [],
    );
    const destRefuse = formatReminderApplyNotice({
      removed: [],
      missed: [],
      skipped: reminderResult.skipped.filter(
        (row) => row.reason === "no_phone" || row.reason === "no_time",
      ),
    });
    const notice = [
      reminderNotice,
      missingSend,
      formatWhatsAppSkipNotice(skips),
    ]
      .filter(Boolean)
      .join("\n\n");
    const listed =
      (parsedMetadata.query ?? metadata.query) === "reminders"
      ? formatActiveRemindersReply(
          prisma.reminder
            ? await listVisibleReminders(input.userId, employee.id, humans)
            : [],
        )
      : "";
    const ownAsk =
      !listed &&
      reminderResult.saved.length === 0 &&
      outbound.relays.length === 0 &&
      outbound.phones.length === 0 &&
      !outbound.held
        ? [
            reminderResult.removed.length > 0
              ? formatReminderApplyNotice(reminderResult)
              : "",
            confirmAsk,
            missingSend,
            destRefuse,
          ].filter(Boolean).join("\n")
        : "";
    const reply = composeAssistantReply({
      llmReply: turn.reply,
      listed,
      notice,
      ownAsk,
    });
    if (listed) {
      await replaceAssistantText(
        conversation.id,
        [listed, notice].filter(Boolean).join("\n\n"),
      );
    } else if (ownAsk) {
      await replaceAssistantText(conversation.id, ownAsk);
    } else if (notice) {
      await appendAssistantNotice(conversation.id, notice);
    }

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
        });
      }
    }
    return {
      reply,
      raw: turn.raw,
      notifications,
      answeredBy: digital.name,
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
