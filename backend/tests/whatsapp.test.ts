import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/config/env.js";
import {
  appendEngineNotice,
  composeAssistantReply,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
} from "../src/services/whatsapp-send.js";
import { sessionOpenAt } from "../src/services/whatsapp-window.js";
import {
  listWhatsAppEvents,
  recordWhatsAppEvent,
  resetWhatsAppEvents,
} from "../src/services/whatsapp-log.js";
import {
  applyWhatsAppHandoff,
  extractInboundTexts,
  phonesMatch,
} from "../src/services/whatsapp.service.js";

describe("WhatsApp webhook", () => {
  beforeEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    resetEnvCache();
    resetWhatsAppEvents();
  });

  it("returns the hub challenge when the verify token matches", async () => {
    const app = createApp();
    const response = await request(app).get("/api/whatsapp/webhook").query({
      "hub.mode": "subscribe",
      "hub.verify_token": "test-verify-token",
      "hub.challenge": "12345",
    });

    expect(response.status).toBe(200);
    expect(response.text).toBe("12345");
  });

  it("rejects a wrong verify token", async () => {
    const app = createApp();
    const response = await request(app).get("/api/whatsapp/webhook").query({
      "hub.mode": "subscribe",
      "hub.verify_token": "nope",
      "hub.challenge": "12345",
    });

    expect(response.status).toBe(403);
  });

  it("acknowledges inbound text messages", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/api/whatsapp/webhook")
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.1",
                      from: "972501234567",
                      text: { body: "hello" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(listWhatsAppEvents()[0]?.step).toBe("inbound_text");
    expect(listWhatsAppEvents().some((event) => event.step === "webhook_post")).toBe(
      true,
    );
  });

  it("redacts tokens in the flow log", () => {
    const event = recordWhatsAppEvent("send_fail", "Authorization EAASecretToken99");
    expect(event.detail).toContain("[token]");
    expect(event.detail).not.toMatch(/EAASecretToken99/);
  });

  it("keeps WhatsApp status behind auth", async () => {
    const app = createApp();
    const response = await request(app).get("/api/whatsapp/status");
    expect(response.status).toBe(401);
  });

  it("matches local and WhatsApp phone numbers", () => {
    expect(phonesMatch("050-0000002", "972500000002")).toBe(true);
    expect(phonesMatch("050-0000002", "972500000001")).toBe(false);
  });

  it("treats a 24h inbound window as open only while it lasts", () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    expect(sessionOpenAt(null, now)).toBe(false);
    expect(sessionOpenAt(new Date("2026-09-23T12:00:01.000Z"), now)).toBe(true);
    expect(sessionOpenAt(new Date("2026-09-23T12:00:00.000Z"), now)).toBe(false);
  });

  it("applies an LLM handoff to a digital worker", () => {
    const lucy = {
      id: "lucy",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      kind: "digital" as const,
      protected: true,
    };
    const david = {
      id: "david",
      name: "דוד",
      surname: "הליצן",
      nickname: "דוד",
      kind: "digital" as const,
      protected: false,
    };
    const digitals = [lucy, david] as never;
    expect(applyWhatsAppHandoff("972500000001", "דוד", digitals)?.id).toBe(
      "david",
    );
    expect(applyWhatsAppHandoff("972500000001", "הליצן", digitals)?.id).toBe(
      "david",
    );
    expect(applyWhatsAppHandoff("972500000001", undefined, digitals)).toBeUndefined();
  });

  it("extracts inbound text messages and ignores status updates", () => {
    expect(extractInboundTexts({})).toEqual([]);
    expect(
      extractInboundTexts({
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [{ id: "wamid.status" }],
                  messages: [
                    { id: "wamid.1", from: "972501234567", text: { body: "  hi  " } },
                    { id: "wamid.2", from: "972501234567", type: "image" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([{ from: "972501234567", text: "hi", messageId: "wamid.1" }]);
  });

  it("returns 503 when the verify token is not configured", async () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    resetEnvCache();
    const app = createApp();
    const response = await request(app).get("/api/whatsapp/webhook").query({
      "hub.mode": "subscribe",
      "hub.verify_token": "test-verify-token",
      "hub.challenge": "12345",
    });

    expect(response.status).toBe(503);
  });

  it("does not call Meta when delivering relays in test", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await deliverWhatsAppRelays(
      [
        {
          target: {
            id: "human-1",
            kind: "human",
            name: "טל",
            surname: "",
            nickname: "טל",
            email: null,
            phone: "972541111111",
            protected: false,
          },
          text: "ping",
        },
      ],
      "actor-1",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("explains a skipped WhatsApp send without a 24h window", () => {
    expect(
      formatWhatsAppSkipNotice([{ label: "מיכל", reason: "no_session" }]),
    ).toContain("מיכל");
    expect(
      formatWhatsAppSkipNotice([{ label: "מיכל", reason: "no_session" }]),
    ).toContain("24");
    expect(
      appendEngineNotice(
        JSON.stringify({ response: "שלחתי למיכל", metadata: {} }),
        "הוואטסאפ אל מיכל לא נשלח: הנמען לא כתב לעסק ב־24 השעות האחרונות.",
      ),
    ).toContain("לא נשלח");
  });

  it("replaces a false send claim when the engine owns the ask", () => {
    const spoken = composeAssistantReply({
      llmReply: JSON.stringify({
        response: "שלחתי למיכל",
        metadata: { messages: [{ targets: ["מיכל"], text: "" }] },
      }),
      listed: "",
      notice: "מה לשלוח ל«מיכל»? אפשר גם שלום.",
      ownAsk: "אין לי מספר ל«מיכל». מה המספר?",
    });
    expect(spoken).toContain("אין לי מספר ל«מיכל»");
    expect(spoken).not.toContain("שלחתי");
  });

  it("uses one delete confirm when the engine owns the ask", () => {
    const spoken = composeAssistantReply({
      llmReply: JSON.stringify({
        response:
          "למחוק את התזכורות: 'לבדוק למה מיכל קיבלה תשובה' ו'לבדוק למה הודעה למיכל נשלחה אלי'?",
        metadata: {},
      }),
      listed: "",
      notice: "למחוק את אלה: לבדוק למה מיכל קיבלה תשובה, לבדוק למה הודעה למיכל נשלחה אלי?",
      ownAsk:
        "למחוק את אלה: לבדוק למה מיכל קיבלה תשובה, לבדוק למה הודעה למיכל נשלחה אלי?",
    });
    expect(spoken.match(/למחוק/g)).toHaveLength(1);
    expect(spoken).not.toContain("התזכורות:");
  });
});

describe("legal pages", () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it("serves privacy, data-deletion, and terms HTML", async () => {
    const app = createApp();
    const privacy = await request(app).get("/privacy");
    const deletion = await request(app).get("/data-deletion");
    const terms = await request(app).get("/terms");

    expect(privacy.status).toBe(200);
    expect(privacy.text).toContain("poc@workee.site");
    expect(deletion.status).toBe(200);
    expect(deletion.text).toContain("delete my data");
    expect(terms.status).toBe(200);
    expect(terms.text).toContain("Workee terms of service");
  });
});
