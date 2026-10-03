import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { ChatLiveEvent } from "@workee/shared";
import { Client } from "pg";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";

const CHANNEL = "chat_events";

/** Stable per process — listeners skip own NOTIFY echoes. */
export const chatEventsInstanceId = randomUUID();

const subscribers = new Map<string, Set<Response>>();

let listenClient: Client | null = null;

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

export type ChatEventNotifyPayload = {
  origin: string;
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  event: ChatLiveEvent;
};

export function encodeChatEventNotify(payload: ChatEventNotifyPayload): string {
  return JSON.stringify(payload);
}

export function decodeChatEventNotify(
  raw: string,
): ChatEventNotifyPayload | null {
  try {
    const parsed = JSON.parse(raw) as ChatEventNotifyPayload;
    if (
      !parsed ||
      typeof parsed.origin !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.employeeId !== "string" ||
      typeof parsed.digitalEmployeeId !== "string" ||
      !parsed.event
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalSubscribers(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
  event: ChatLiveEvent,
): void {
  const bucket = subscribers.get(
    subscriberKey(userId, employeeId, digitalEmployeeId),
  );
  if (!bucket || bucket.size === 0) {
    return;
  }

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of bucket) {
    res.write(payload);
  }
}

async function notifyOtherInstances(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
  event: ChatLiveEvent,
): Promise<void> {
  if (getEnv().NODE_ENV === "test") {
    return;
  }
  const payload = encodeChatEventNotify({
    origin: chatEventsInstanceId,
    userId,
    employeeId,
    digitalEmployeeId,
    event,
  });
  // Postgres NOTIFY payload limit is ~8KB; chat events stay small.
  if (Buffer.byteLength(payload, "utf8") > 7500) {
    console.error("chat_events NOTIFY payload too large; skipped fan-out");
    return;
  }
  try {
    await prisma.$executeRaw`SELECT pg_notify(${CHANNEL}, ${payload})`;
  } catch (error) {
    console.error(
      "chat_events NOTIFY failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export function publishChatEvent(
  userId: string,
  employeeId: string,
  digitalEmployeeId: string,
  event: ChatLiveEvent,
): void {
  writeLocalSubscribers(userId, employeeId, digitalEmployeeId, event);
  void notifyOtherInstances(userId, employeeId, digitalEmployeeId, event);
}

/** Apply a remote fan-out (or test injection). Skips payloads from this process. */
export function applyRemoteChatEventNotify(raw: string): boolean {
  const payload = decodeChatEventNotify(raw);
  if (!payload || payload.origin === chatEventsInstanceId) {
    return false;
  }
  writeLocalSubscribers(
    payload.userId,
    payload.employeeId,
    payload.digitalEmployeeId,
    payload.event,
  );
  return true;
}

export async function startChatEventListener(): Promise<void> {
  if (getEnv().NODE_ENV === "test" || listenClient) {
    return;
  }
  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  client.on("error", (error) => {
    console.error("chat_events LISTEN connection error", error.message);
  });
  client.on("notification", (message) => {
    if (message.channel !== CHANNEL || !message.payload) {
      return;
    }
    applyRemoteChatEventNotify(message.payload);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listenClient = client;
  } catch (error) {
    console.error(
      "chat_events LISTEN failed to start",
      error instanceof Error ? error.message : "unknown",
    );
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

export async function stopChatEventListener(): Promise<void> {
  const client = listenClient;
  listenClient = null;
  if (!client) {
    return;
  }
  try {
    await client.end();
  } catch (error) {
    console.error(
      "chat_events LISTEN disconnect failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

export function resetChatEventsForTests(): void {
  subscribers.clear();
}
