import { prisma } from "../database/prisma.js";
import { getEnv } from "../config/env.js";
import { publishChatEvent } from "./chat-events.service.js";
import { sendWhatsAppButtons } from "./whatsapp-send.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export type MissionPushButton = { label: string; command: string };

/**
 * Push a user-facing message as Lucy on the Lucy↔speaker thread
 * (web SSE + WhatsApp when available).
 */
export async function pushMissionMessageAsLucy(input: {
  userId: string;
  speakerId: string;
  orchestratorId: string;
  text: string;
  buttons?: MissionPushButton[];
  raw?: Record<string, unknown>;
}): Promise<void> {
  const text = input.text.trim();
  if (!text) {
    return;
  }
  const buttons = (input.buttons ?? []).slice(0, 3);
  const orchestrator = await prisma.employee.findUnique({
    where: { id: input.orchestratorId },
  });
  const speakerName =
    orchestrator?.nickname?.trim() || orchestrator?.name || "לוסי";

  const conversation = await prisma.chatConversation.findUnique({
    where: {
      userId_employeeId_digitalEmployeeId: {
        userId: input.userId,
        employeeId: input.speakerId,
        digitalEmployeeId: input.orchestratorId,
      },
    },
  });

  if (conversation) {
    const created = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        author: "assistant",
        speaker: speakerName,
        text,
        ...(buttons.length > 0
          ? {
              buttons: buttons.map(({ label, command }) => ({
                label,
                command,
              })),
            }
          : {}),
        raw: { mission: true, ...(input.raw ?? {}) },
      },
    });
    publishChatEvent(input.userId, input.speakerId, input.orchestratorId, {
      employeeId: input.speakerId,
      digitalEmployeeId: input.orchestratorId,
      message: {
        id: created.id,
        author: "assistant",
        speaker: created.speaker,
        text: created.text,
        createdAt: created.createdAt.toISOString(),
        ...(buttons.length > 0 ? { buttons } : {}),
      },
      raw: { mission: true, ...(input.raw ?? {}) },
    });
  }

  const speaker = await prisma.employee.findUnique({
    where: { id: input.speakerId },
  });
  const phone = speaker?.phone?.trim() ?? "";
  if (phone && getEnv().WHATSAPP_ACCESS_TOKEN?.trim()) {
    try {
      const result = await sendWhatsAppButtons(phone, text, buttons, {
        ignoreSession: true,
      });
      recordWhatsAppEvent(
        "mission_push",
        `result=${result} phone=…${phone.replace(/\D/g, "").slice(-4)}`,
      );
    } catch (error) {
      console.error(
        "Mission WhatsApp push failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
}

export function planApprovalButtons(missionId: string): MissionPushButton[] {
  return [
    { label: "אשר תכנית", command: `אשר תכנית ${missionId}` },
    { label: "שנה", command: `שנה תכנית ${missionId}` },
    { label: "בטל", command: `בטל משימה ${missionId}` },
  ];
}

export function stepApprovalButtons(toolCallId: string): MissionPushButton[] {
  return [
    { label: "אשר", command: `אשר פעולה ${toolCallId}` },
    { label: "דחה", command: `דחה פעולה ${toolCallId}` },
  ];
}
