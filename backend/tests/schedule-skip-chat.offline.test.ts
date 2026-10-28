/**
 * Chat-level wiring for scheduled messages that were skipped (not queued):
 * same notice + replaceSpoken path chat.service uses.
 */
import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import {
  formatScheduleSkippedWithoutQueueNotice,
  planPhoneRelays,
  planRelayDeliveries,
  planScheduledJobDeliveries,
} from "../src/services/employee-targets.service.js";
import { composeAssistantReply } from "../src/services/whatsapp-send.js";

const amit: PublicEmployee = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "human",
  name: "עמית",
  surname: "",
  nickname: "עמית",
  email: null,
  phone: "0501111111",
};

const tal: PublicEmployee = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "human",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "0502222222",
};

const lucy: PublicEmployee = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "digital",
  name: "לוסי",
  surname: "",
  nickname: "לוסי",
  email: null,
  phone: null,
};

const roster = [amit, tal, lucy];

/** Mirrors chat.service: scheduleSkipNotice → deliveryFailed → replaceSpoken. */
function applyChatScheduleSkipWiring(input: {
  llmReply: string;
  messages: Parameters<typeof formatScheduleSkippedWithoutQueueNotice>[0]["messages"];
  scheduledJobCount: number;
}): string {
  const scheduleSkipNotice = formatScheduleSkippedWithoutQueueNotice({
    messages: input.messages,
    scheduledJobCount: input.scheduledJobCount,
  });
  const deliveryFailed = scheduleSkipNotice.length > 0;
  const notice = scheduleSkipNotice;
  return deliveryFailed
    ? composeAssistantReply({
        llmReply: input.llmReply,
        notice,
        replaceResponse: true,
      })
    : composeAssistantReply({
        llmReply: input.llmReply,
        notice: "",
        replaceResponse: false,
      });
}

describe("scheduled message chat-level honesty", () => {
  it("replaces misleading אשלח ב… when schedule was only skipped (not queued)", () => {
    const messages = [
      {
        targets: ["טל"],
        text: "שלום מחר בערב",
        expectsReply: false as const,
        time: "20:00",
        date: "2026-10-29",
      },
    ];
    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: roster,
        messages,
      }),
    ).toEqual([]);
    expect(planScheduledJobDeliveries({
      actor: amit,
      sender: lucy,
      employees: roster,
      messages,
    })).toEqual([]);

    const spoken = applyChatScheduleSkipWiring({
      llmReply: JSON.stringify({
        response: "אשלח ב־20:00 את ההודעה לטל",
        metadata: { messages },
      }),
      messages,
      scheduledJobCount: 0,
    });
    const parsed = JSON.parse(spoken) as { responses: string[] };
    expect(parsed.responses).toEqual([
      "ההודעה לא תוזמנה לשליחה מאוחרת. לשליחה בזמן עתידי צריך שעון תזכורת עם הטקסט והנמען.",
    ]);
    expect(spoken).not.toContain("אשלח ב");
  });

  it("valid named deferred check-with is queued and never sent immediately", () => {
    const messages = [
      {
        targets: ["טל"],
        text: "עמית שואל אם קנית חלב?",
        expectsReply: true as const,
        askSummary: "אם קנית חלב?",
        inSeconds: 7200,
      },
    ];
    expect(
      planRelayDeliveries({
        actor: amit,
        sender: lucy,
        employees: roster,
        messages,
      }),
    ).toEqual([]);
    expect(
      planPhoneRelays(messages, roster, amit.id),
    ).toEqual([]);
    const queued = planScheduledJobDeliveries({
      actor: amit,
      sender: lucy,
      employees: roster,
      messages,
    });
    expect(queued).toEqual([
      {
        subjectId: tal.id,
        subjectName: "טל",
        text: "עמית שואל אם קנית חלב?",
        ask: "אם קנית חלב?",
        inSeconds: 7200,
      },
    ]);

    const spoken = applyChatScheduleSkipWiring({
      llmReply: JSON.stringify({
        response: "אבדוק עם טל בעוד שעתיים: «עמית שואל אם קנית חלב?»",
        metadata: { messages },
      }),
      messages,
      scheduledJobCount: queued.length,
    });
    const parsed = JSON.parse(spoken) as { responses?: string[]; response?: string };
    const text = parsed.responses?.[0] ?? parsed.response ?? spoken;
    expect(text).toContain("אבדוק עם טל");
    expect(text).not.toContain("לא תוזמנה");
  });

  it("keeps phone-target schedule guard (no immediate send, notice when unqueued)", () => {
    const messages = [
      {
        targets: ["050-333-3333"],
        text: "היי בערב",
        expectsReply: false as const,
        time: "20:00",
      },
    ];
    expect(planPhoneRelays(messages, roster, amit.id)).toEqual([]);
    const spoken = applyChatScheduleSkipWiring({
      llmReply: JSON.stringify({
        response: "אשלח ב־20:00",
        metadata: { messages },
      }),
      messages,
      scheduledJobCount: 0,
    });
    expect(spoken).toContain("לא תוזמנה");
    expect(spoken).not.toContain("אשלח ב־20:00");
  });
});
