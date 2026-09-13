import type { Response } from "express";
import type { ChatLiveEvent } from "@workee/shared";

const subscribers = new Map<string, Set<Response>>();

function subscriberKey(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
): string {
  return `${userId}:${employeeId}:${digitalEmployeeId}`;
}

export function subscribeChatEvents(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
  res: Response,
): () => void {
  const key = subscriberKey(userId, employeeId, digitalEmployeeId);
  const bucket = subscribers.get(key) ?? new Set<Response>();
  bucket.add(res);
  subscribers.set(key, bucket);

  return () => {
    bucket.delete(res);
    if (bucket.size === 0) {
      subscribers.delete(key);
    }
  };
}

export function publishChatEvent(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
  event: ChatLiveEvent,
): void {
  const bucket = subscribers.get(subscriberKey(userId, employeeId, digitalEmployeeId));
  if (!bucket || bucket.size === 0) {
    return;
  }

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of bucket) {
    res.write(payload);
  }
}

export function resetChatEventsForTests(): void {
  subscribers.clear();
}
