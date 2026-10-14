import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/config/env.js";
import {
  appendEngineNotice,
  composeAssistantReply,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
  sendWhatsAppTyping,
  toWhatsAppFormatting,
  whatsappButtonsBody,
  whatsappCtaUrlBody,
  whatsappTypingBody,
  WHATSAPP_NAVIGATE_LABEL,
} from "../src/services/whatsapp-send.js";
import { wazeNavigateUrl } from "@workee/shared";
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
import {
  formatWhatsAppReplyContext,
  rememberWhatsAppOutbound,
  resetWhatsAppOutboundMemory,
} from "../src/services/whatsapp-outbound-memory.js";

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

  it("attaches in-memory quoted outbound text on swipe-reply", () => {
    resetWhatsAppOutboundMemory();
    rememberWhatsAppOutbound("wamid.out", "מה יש בקניות?");
    expect(
      extractInboundTexts({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.in",
                      from: "972501234567",
                      text: { body: "תוריד את החלב" },
                      context: { id: "wamid.out", from: "972501234567" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        from: "972501234567",
        text: "תוריד את החלב",
        messageId: "wamid.in",
        replyToText: "מה יש בקניות?",
      },
    ]);
    expect(
      formatWhatsAppReplyContext("מה יש בקניות?", "תוריד את החלב"),
    ).toBe('[בתשובה להודעה: "מה יש בקניות?"] תוריד את החלב');
  });

  it("reads a tapped reply button as the button's command", () => {
    expect(
      extractInboundTexts({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.btn",
                      from: "972501234567",
                      type: "interactive",
                      interactive: {
                        type: "button_reply",
                        button_reply: { id: "הצג רשימת קניות", title: "הצג" },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      { from: "972501234567", text: "הצג רשימת קניות", messageId: "wamid.btn" },
    ]);
  });

  it("builds an interactive reply-button message", () => {
    expect(
      whatsappButtonsBody("972501234567", "הוספתי חלב לרשימת הקניות שלך", [
        { label: "הצג", command: "הצג רשימת קניות" },
      ]),
    ).toEqual({
      messaging_product: "whatsapp",
      to: "972501234567",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "הוספתי חלב לרשימת הקניות שלך" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "הצג רשימת קניות", title: "הצג" } },
          ],
        },
      },
    });
  });

  it("builds a Waze CTA URL message", () => {
    const url = wazeNavigateUrl("הרצל 12, תל אביב");
    expect(
      whatsappCtaUrlBody("972501234567", "הרצל 12, תל אביב", WHATSAPP_NAVIGATE_LABEL, url),
    ).toEqual({
      messaging_product: "whatsapp",
      to: "972501234567",
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: "הרצל 12, תל אביב" },
        action: {
          name: "cta_url",
          parameters: { display_text: "פתח ב-Waze", url },
        },
      },
    });
  });

  it("turns «quoted» parts into WhatsApp bold", () => {
    expect(toWhatsAppFormatting("עמית מחק «באג» מרשימת «באגים»")).toBe(
      "עמית מחק *באג* מרשימת *באגים*",
    );
    expect(toWhatsAppFormatting("מה לשלוח ל« מיכל »?")).toBe("מה לשלוח *למיכל*?");
    expect(toWhatsAppFormatting("עידכנתי את השם ל«דני כהן».")).toBe(
      "עידכנתי את השם *לדני כהן*.",
    );
    expect(toWhatsAppFormatting("«חלב» ו«לחם»")).toBe("*חלב* *ולחם*");
    expect(toWhatsAppFormatting("ראיתי גם וה«משימה»ות")).toBe("ראיתי גם *והמשימהות*");
    expect(toWhatsAppFormatting("ב«בית», ש«שם»!")).toBe("*בבית*, *ששם*!");
    expect(toWhatsAppFormatting("(«חלב»)")).toBe("(*חלב*)");
    expect(toWhatsAppFormatting("«לא סגור\nשורה»")).toBe("«לא סגור\nשורה»");
    expect(toWhatsAppFormatting("«»")).toBe("«»");
    expect(
      (whatsappButtonsBody("972501234567", "הוספתי «חלב»", [
        { label: "הצג", command: "הצג רשימת קניות" },
      ]).interactive as { body: { text: string } }).body.text,
    ).toBe("הוספתי *חלב*");
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

  it("marks the inbound message read and shows typing", () => {
    expect(whatsappTypingBody("wamid.1")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.1",
      typing_indicator: { type: "text" },
    });
  });

  it("does not call Meta for typing in test", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendWhatsAppTyping("wamid.1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

  it("keeps the model response and only appends an engine notice", () => {
    const spoken = composeAssistantReply({
      llmReply: JSON.stringify({
        response: "שלחתי למיכל",
        metadata: { messages: [{ targets: ["מיכל"], text: "" }] },
      }),
      notice: "מה לשלוח ל«מיכל»? אפשר גם שלום.",
    });
    expect(spoken).toContain("שלחתי למיכל");
    expect(spoken).toContain("מה לשלוח");
  });

  it("replaces a false sent claim when WhatsApp delivery failed", () => {
    const fail =
      "הוואטסאפ אל מיכל לא נשלח: הנמען לא כתב לעסק ב־24 השעות האחרונות.";
    const spoken = composeAssistantReply({
      llmReply: JSON.stringify({
        response: "שלחתי למיכל הודעה עם לבבות",
        metadata: { messages: [{ targets: ["מיכל"], text: "❤️" }] },
      }),
      notice: fail,
      replaceResponse: true,
    });
    const parsed = JSON.parse(spoken) as { responses: string[] };
    expect(parsed.responses).toEqual([fail]);
  });

  it("appends partner notify skips without erasing a shared-list delete reply", () => {
    const partnerSkip = formatWhatsAppSkipNotice([
      { label: "עמית", reason: "no_session" },
    ]);
    const spoken = composeAssistantReply({
      llmReply: JSON.stringify({
        response: "הסרתי מרשימת «בעיות» את «לבדוק שוב את הפונקציונליות».",
        metadata: {},
      }),
      notice: partnerSkip,
      // Shared-list partner notify failures must not set replaceResponse.
      replaceResponse: false,
    });
    const parsed = JSON.parse(spoken) as { responses: string[] };
    expect(parsed.responses).toHaveLength(2);
    expect(parsed.responses[0]).toContain("הסרתי מרשימת «בעיות»");
    expect(parsed.responses[1]).toContain("עמית");
  });

  it("keeps a raise as its own message and adds an engine notice after it", () => {
    const spoken = composeAssistantReply({
      llmReply: JSON.stringify({
        responses: ["הי, איך אפשר לעזור?", "אגב, ביקשת שאבדוק אם קנית חלב?"],
        metadata: {},
      }),
      notice: "הוואטסאפ אל מיכל לא נשלח.",
    });
    const parsed = JSON.parse(spoken) as { responses: string[]; response?: string };
    expect(parsed.responses).toEqual([
      "הי, איך אפשר לעזור?",
      "אגב, ביקשת שאבדוק אם קנית חלב?",
      "הוואטסאפ אל מיכל לא נשלח.",
    ]);
    expect(parsed.response).toBeUndefined();
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
