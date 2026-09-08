import { loadLlmConfig } from "../config/llm.js";
import { ServiceUnavailableError } from "../utils/errors.js";
import { getEmployeeForUser } from "./employee.service.js";
import { getLlmClient } from "./llm-client.js";

const conversationsBySessionEmployee = new Map<string, string>();

function conversationKey(sessionId: string, employeeId: string): string {
  return `${sessionId}:${employeeId}`;
}

export function forgetConversation(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of conversationsBySessionEmployee.keys()) {
    if (key.startsWith(prefix)) {
      conversationsBySessionEmployee.delete(key);
    }
  }
}

export function resetConversationsForTests(): void {
  conversationsBySessionEmployee.clear();
}

function speakerName(employee: {
  name: string;
  nickname: string | null;
}): string {
  return employee.nickname?.trim() || employee.name;
}

export async function sendChatMessage(input: {
  sessionId: string;
  userId: string;
  message: string;
  employeeId: string;
}): Promise<{ reply: string; raw: unknown }> {
  const config = loadLlmConfig();
  const client = getLlmClient();
  const employee = await getEmployeeForUser(input.userId, input.employeeId);
  const speaker = speakerName(employee);
  const instructions = `${config.systemMessage}\n\nThe user is chatting as ${speaker}.`;
  const message = `${speaker}: ${input.message}`;
  const key = conversationKey(input.sessionId, input.employeeId);

  let conversationId = conversationsBySessionEmployee.get(key);
  if (!conversationId) {
    conversationId = await client.createConversation();
    conversationsBySessionEmployee.set(key, conversationId);
  }

  try {
    const turn = await client.createResponse({
      conversationId,
      message,
      model: config.model,
      temperature: config.temperature,
      instructions,
    });
    return { reply: turn.reply, raw: turn.raw };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      throw error;
    }
    throw new ServiceUnavailableError();
  }
}
