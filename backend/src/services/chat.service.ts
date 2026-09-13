import { Prisma, type ChatMessage as ChatMessageRow } from "@prisma/client";
import {
  parseLlmReply,
  parseReplyMetadata,
  type ChatHistoryResponse,
  type ChatThreadMessage,
  type ChatThreadNotification,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { loadLlmConfig } from "../config/llm.js";
import { prisma } from "../database/prisma.js";
import {
  isUniqueConstraintError,
  ServiceUnavailableError,
} from "../utils/errors.js";
import {
  applyEmployeeMetadata,
  formatEmployeeContext,
  getEmployeeRecordSnapshot,
  type SharedItemEvent,
} from "./employee-records.service.js";
import { getEmployeeForUser, listEmployeesForUser } from "./employee.service.js";
import {
  employeeDisplayName,
  fallbackNotificationText,
  planTargetedActions,
  resolveSpokenMetadata,
} from "./employee-targets.service.js";
import { publishChatEvent } from "./chat-events.service.js";
import { getLlmClient, toPlainJson } from "./llm-client.js";

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
): ChatHistoryResponse {
  return {
    employeeId,
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
    ...(actions.length > 0 ? { actions } : {}),
  };
}

function targetingInstructions(
  employees: PublicEmployee[],
  speaker: string,
): string {
  const names = employees.map(employeeDisplayName).join(", ");
  return [
    `Known employees: ${names}.`,
    `Current speaker: ${speaker}.`,
    'If the speaker assigns an action to another employee or to everyone, set targets on that action to those names or ["all"].',
    'Example: "טל צריך לקנות חלב" → shopping add, targets: ["טל"].',
    'Example: "טל צריך לקחת את הילדים לגינה" → tasks add, targets: ["טל"].',
    'Example: "כולם צריכים לקנות חלב" → targets: ["all"].',
    "If omitted, the action applies only to the current speaker.",
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
): Promise<{
  id: string;
  openaiConversationId: string;
  needsContext: boolean;
}> {
  const existing = await prisma.chatConversation.findUnique({
    where: { userId_employeeId: { userId, employeeId } },
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
        openaiConversationId,
      },
    });
    return { ...created, needsContext: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const raced = await prisma.chatConversation.findUniqueOrThrow({
      where: { userId_employeeId: { userId, employeeId } },
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
  message: string;
  reply: string;
  raw: unknown;
}): Promise<void> {
  const parsed = parseLlmReply(input.reply);

  await prisma.chatMessage.createMany({
    data: [
      {
        conversationId: input.conversationId,
        author: "you",
        speaker: input.speaker,
        text: input.message,
      },
      {
        conversationId: input.conversationId,
        author: "assistant",
        speaker: "Assistant",
        text: parsed.response,
        actions: parsed.actions.length > 0 ? parsed.actions : Prisma.JsonNull,
        raw: toJsonValue(input.raw),
      },
    ],
  });
}

async function saveAssistantMessage(input: {
  conversationId: string;
  text: string;
  actions: string[];
  raw: unknown;
}): Promise<ChatThreadMessage> {
  const created = await prisma.chatMessage.create({
    data: {
      conversationId: input.conversationId,
      author: "assistant",
      speaker: "Assistant",
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
}): Promise<ChatThreadNotification> {
  const conversation = await getOrCreateConversation(input.userId, input.target.id);
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
    text,
    actions,
    raw,
  });

  if (conversation.needsContext) {
    await markContextInjected(conversation.id);
  }

  const notification = {
    employeeId: input.target.id,
    message,
    raw,
  };
  publishChatEvent(input.userId, input.target.id, notification);
  return notification;
}

export async function notifySharedItemEvents(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  events: SharedItemEvent[];
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
      }),
    );
  }

  return notifications;
}

export async function getChatHistory(
  userId: string,
  employeeId: string,
): Promise<ChatHistoryResponse> {
  await getEmployeeForUser(userId, employeeId);

  const conversation = await prisma.chatConversation.findUnique({
    where: { userId_employeeId: { userId, employeeId } },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!conversation) {
    return emptyHistory(employeeId, null);
  }

  const lastActivity =
    conversation.messages.at(-1)?.createdAt ?? conversation.updatedAt;
  if (isIdleSince(lastActivity)) {
    const rotated = await rotateConversation(conversation);
    return emptyHistory(
      employeeId,
      rotated.openaiConversationId,
      rotated.updatedAt,
    );
  }

  return toHistoryResponse(employeeId, conversation);
}

export async function resetChatConversation(
  userId: string,
  employeeId: string,
): Promise<ChatHistoryResponse> {
  await getEmployeeForUser(userId, employeeId);
  const existing = await prisma.chatConversation.findUnique({
    where: { userId_employeeId: { userId, employeeId } },
  });

  if (existing) {
    const rotated = await rotateConversation(existing);
    return emptyHistory(
      employeeId,
      rotated.openaiConversationId,
      rotated.updatedAt,
    );
  }

  const created = await prisma.chatConversation.create({
    data: {
      userId,
      employeeId,
      openaiConversationId: await getLlmClient().createConversation(),
    },
  });
  return emptyHistory(employeeId, created.openaiConversationId, created.updatedAt);
}

export async function sendChatMessage(input: {
  userId: string;
  message: string;
  employeeId: string;
}): Promise<{
  reply: string;
  raw: unknown;
  notifications: ChatThreadNotification[];
}> {
  const config = loadLlmConfig();
  const client = getLlmClient();
  const [employee, employees] = await Promise.all([
    getEmployeeForUser(input.userId, input.employeeId),
    listEmployeesForUser(input.userId),
  ]);
  const speaker = speakerName(employee);
  const conversation = await getOrCreateConversation(input.userId, input.employeeId);
  const context = formatEmployeeContext(await getEmployeeRecordSnapshot(input.employeeId));
  const instructions = [
    config.systemMessage,
    `The user is chatting as ${speaker}.`,
    targetingInstructions(employees, speaker),
    "Personal items belong only to this employee. Shared items are visible to the relevant employees listed on the item.",
    "If asked what someone still needs to buy, use only current shopping lists in EMPLOYEE_SAVED_DATA.",
    "Ignore older shopping lists or tasks from earlier turns when they conflict with EMPLOYEE_SAVED_DATA.",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
  const message = [
    context,
    "Use only EMPLOYEE_SAVED_DATA. If an item is missing from those lists, it is not needed.",
    `${speaker}: ${input.message}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const turn = await client.createResponse({
      conversationId: conversation.openaiConversationId,
      message,
      model: config.model,
      temperature: config.temperature,
      instructions,
    });
    await saveTurn({
      conversationId: conversation.id,
      speaker,
      message: input.message,
      reply: turn.reply,
      raw: turn.raw,
    });

    const metadata = resolveSpokenMetadata(
      input.message,
      parseReplyMetadata(turn.reply),
      employees,
      employee.id,
    );
    const plan = planTargetedActions({
      actor: employee,
      employees,
      metadata,
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

    const notifications = await notifySharedItemEvents({
      userId: input.userId,
      actor: employee,
      employees,
      events: collectedEvents,
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
        }),
      );
    }

    if (conversation.needsContext) {
      await markContextInjected(conversation.id);
    }
    return { reply: turn.reply, raw: turn.raw, notifications };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      throw error;
    }
    throw new ServiceUnavailableError();
  }
}
