import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/config/env.js";
import {
  appendEngineNotice,
  appendEngineResponse,
  applyLiveDomainReply,
  formatWatchSampleLive,
  composeAssistantReply,
  deliverWhatsAppRelays,
  formatWhatsAppSkipNotice,
  sendWhatsAppMarkRead,
  sendWhatsAppTyping,
  setEngineButtons,
  setEngineSpokenBubbles,
  toWhatsAppFormatting,
  fitReplyButtonLabel,
  whatsappButtonsBody,
  whatsappCtaUrlBody,
  whatsappMarkReadBody,
  whatsappReactionBody,
  whatsappTypingBody,
  WHATSAPP_NAVIGATE_LABEL,
} from "../src/services/whatsapp-send.js";
import { parseLlmReply } from "@workee/shared";
import { EMPTY_REPLY_RETRY } from "../src/services/employee-records.service.js";
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
  formatSharedContactsMessage,
  phonesMatch,
  SHARED_CONTACTS_MARKER,
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

  it("does not wrap known הצג button commands in reply context", async () => {
    const { isKnownShowButtonCommand } = await import(
      "../src/services/show-button-dump.js"
    );
    expect(isKnownShowButtonCommand("הצג רשימת קניות")).toBe(true);
    expect(isKnownShowButtonCommand("הצג רשימת קניות אישית")).toBe(false);
    // Inbound path: spoken button command skips formatWhatsAppReplyContext.
    const spoken = "הצג רשימת קניות";
    const replyToText = "מחקתי את האורז מרשימת הקניות.";
    const message = isKnownShowButtonCommand(spoken)
      ? spoken
      : formatWhatsAppReplyContext(replyToText, spoken);
    expect(message).toBe("הצג רשימת קניות");
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

  it("turns a shared contact card into a structured shared_contacts turn", () => {
    const contactsMessage = (contacts: unknown, extra: Record<string, unknown> = {}) => ({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.card",
                    from: "972501234567",
                    type: "contacts",
                    contacts,
                    ...extra,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(
      extractInboundTexts(
        contactsMessage([
          {
            name: { formatted_name: "דני כהן", first_name: "דני" },
            phones: [
              { phone: "+972 52-123-4567", wa_id: "972521234567", type: "CELL" },
            ],
          },
        ]),
      ),
    ).toEqual([
      {
        from: "972501234567",
        messageId: "wamid.card",
        text: `${SHARED_CONTACTS_MARKER}\n{"shared_contacts":[{"name":"דני כהן","phones":["972521234567"]}]}`,
      },
    ]);

    expect(
      formatSharedContactsMessage([
        {
          name: { first_name: "מיכל", last_name: "לוי" },
          phones: [{ phone: "052-111-2222" }, { phone: "03-555-6666" }],
        },
        { name: { formatted_name: "יוסי" }, phones: [{ wa_id: "972533333333" }] },
      ]),
    ).toBe(
      `${SHARED_CONTACTS_MARKER}\n${JSON.stringify({
        shared_contacts: [
          { name: "מיכל לוי", phones: ["052-111-2222", "03-555-6666"] },
          { name: "יוסי", phones: ["972533333333"] },
        ],
      })}`,
    );

    expect(
      formatSharedContactsMessage([{ name: { formatted_name: "ללא מספר" } }]),
    ).toBe(
      `${SHARED_CONTACTS_MARKER}\n{"shared_contacts":[{"name":"ללא מספר","phones":[]}]}`,
    );
    expect(formatSharedContactsMessage(undefined)).toBe("");
    expect(formatSharedContactsMessage([{}])).toBe("");

    expect(
      extractInboundTexts(
        contactsMessage(
          [{ name: { formatted_name: "דני" }, phones: [{ wa_id: "972521234567" }] }],
          { id: undefined },
        ),
      ),
    ).toEqual([]);
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

  it("replaces long item-show labels with להצגת המטלה/תיוק instead of mid-cut", () => {
    const longTask = "להוריד את סקאזי לטיול";
    expect(longTask.length).toBeGreaterThan(20);
    expect(
      fitReplyButtonLabel({
        label: longTask,
        command: `הציגי את המטלה ${longTask}`,
      }),
    ).toBe("להצגת המטלה");
    expect(
      fitReplyButtonLabel({
        label: "סיסמת וייפיי של הבית של סבתא",
        command: "הציגי את התיוק סיסמת וייפיי של הבית של סבתא",
      }),
    ).toBe("להצגת התיוק");
    const body = whatsappButtonsBody("972501234567", "הוספתי", [
      { label: longTask, command: `הציגי את המטלה ${longTask}` },
      { label: "הצג מטלות", command: "הצג רשימת מטלות" },
    ]);
    const titles = (
      body.interactive as {
        action: { buttons: Array<{ reply: { title: string; id: string } }> };
      }
    ).action.buttons.map((row) => row.reply);
    expect(titles[0]).toEqual({
      title: "להצגת המטלה",
      id: `הציגי את המטלה ${longTask}`.slice(0, 256),
    });
    expect(titles[1]?.title).toBe("הצג מטלות");
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

  it("builds a reaction message for the inbound wamid", () => {
    expect(
      whatsappReactionBody("972501234567", "wamid.HBgLMTIz", "👍"),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "972501234567",
      type: "reaction",
      reaction: {
        message_id: "wamid.HBgLMTIz",
        emoji: "👍",
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
    expect(toWhatsAppFormatting("«1. לשתות מים» ‼️")).toBe("*1. לשתות מים* ‼️");
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

  it("extracts inbound location pins", () => {
    const rows = extractInboundTexts({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.loc",
                    from: "972501234567",
                    type: "location",
                    location: {
                      latitude: 32.087,
                      longitude: 34.887,
                      name: "בית",
                      address: "ז׳בוטינסקי 1",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.location).toEqual({
      lat: 32.087,
      lng: 34.887,
      name: "בית",
      address: "ז׳בוטינסקי 1",
    });
    expect(rows[0]?.text).toContain("מיקום שותף");
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

  it("marks the inbound message read without typing (pre-LLM)", () => {
    expect(whatsappMarkReadBody("wamid.1")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.1",
    });
    expect(whatsappMarkReadBody("wamid.1")).not.toHaveProperty(
      "typing_indicator",
    );
  });

  it("marks the inbound message read and shows typing", () => {
    expect(whatsappTypingBody("wamid.1")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.1",
      typing_indicator: { type: "text" },
    });
  });

  it("does not call Meta for mark-read or typing in test", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendWhatsAppMarkRead("wamid.1");
    await sendWhatsAppTyping("wamid.1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("documents outbound order: mark-read → reaction → typing → reply", () => {
    // runWhatsAppTurn: mark-read (no typing) → LLM → optional reaction → typing → reply.
    // No artificial settle sleeps between reaction/typing/first reply.
    const markRead = whatsappMarkReadBody("wamid.1");
    const typing = whatsappTypingBody("wamid.1");
    const reaction = whatsappReactionBody("972501234567", "wamid.1", "👍");
    expect(markRead).not.toHaveProperty("typing_indicator");
    expect(typing.typing_indicator).toEqual({ type: "text" });
    expect(reaction.type).toBe("reaction");
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

  it("appendEngineResponse keeps prior responses and adds a bubble", () => {
    const reply = appendEngineResponse(
      JSON.stringify({
        responses: ["אעקוב אחרי הביטקוין ואעדכן מעל 84,000"],
        metadata: { market: { queries: ["BTC-USD"] } },
      }),
      "Bitcoin USD (BTC-USD): 84,180.34 USD.\nלא ייעוץ השקעות.",
    );
    expect(parseLlmReply(reply).responses).toEqual([
      "אעקוב אחרי הביטקוין ואעדכן מעל 84,000",
      "Bitcoin USD (BTC-USD): 84,180.34 USD.\nלא ייעוץ השקעות.",
    ]);
  });

  it("applyLiveDomainReply appends when model ack is present", () => {
    const quote =
      "Bitcoin USD (BTC-USD): 84,180.34 USD.\nלא ייעוץ השקעות.";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: [
          "אעקוב אחרי שער הביטקוין ואעדכן אותך כשיהיה מעל 84,000 דולר",
        ],
        metadata: { market: { queries: ["BTC-USD"], aspects: ["price"] } },
      }),
      quote,
    );
    expect(parseLlmReply(reply).responses).toEqual([
      "אעקוב אחרי שער הביטקוין ואעדכן אותך כשיהיה מעל 84,000 דולר",
      quote,
    ]);
  });

  it("formatWatchSampleLive prefaced FX quote for WATCH baseline", () => {
    expect(
      formatWatchSampleLive("USD/ILS (ILS=X): 3.09 ILS.\nלא ייעוץ השקעות.", "market"),
    ).toBe(
      "לידיעתך כרגע השער הוא USD/ILS (ILS=X): 3.09 ILS.\nלא ייעוץ השקעות.",
    );
    expect(
      formatWatchSampleLive("Bitcoin USD (BTC-USD): 84,180.34 USD.", "market"),
    ).toBe("לידיעתך כרגע המחיר הוא Bitcoin USD (BTC-USD): 84,180.34 USD.");
  });

  it("applyLiveDomainReply WATCH sample wraps 2nd bubble; pure ask does not", () => {
    const quote = "USD/ILS (ILS=X): 3.09 ILS.\nלא ייעוץ השקעות.";
    const watchReply = applyLiveDomainReply(
      JSON.stringify({
        responses: ["אעקוב אחרי שער הדולר ואעדכן אותך כשיעבור 3 שקלים"],
        metadata: {
          market: { queries: ["ILS=X"], aspects: ["price"] },
          reminders: [
            {
              action: "add",
              item: "דולר",
              compose_condition: { type: "market_price", op: "gt", value: 3 },
            },
          ],
        },
      }),
      quote,
      { watchSample: true, watchDomain: "market" },
    );
    expect(parseLlmReply(watchReply).responses).toEqual([
      "אעקוב אחרי שער הדולר ואעדכן אותך כשיעבור 3 שקלים",
      "לידיעתך כרגע השער הוא USD/ILS (ILS=X): 3.09 ILS.\nלא ייעוץ השקעות.",
    ]);
    const pureAsk = applyLiveDomainReply(
      JSON.stringify({
        responses: [],
        metadata: { market: { queries: ["ILS=X"] } },
      }),
      quote,
      { watchSample: true, watchDomain: "market" },
    );
    expect(parseLlmReply(pureAsk).responses).toEqual([quote]);
  });

  it("applyLiveDomainReply replaces when spoken is empty (pure live ask)", () => {
    const weather =
      "מזג האוויר בפתח תקווה עכשיו: 22° מעונן חלקית.";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: [],
        metadata: { weather: { place: "פתח תקווה", aspects: ["summary"] } },
      }),
      weather,
    );
    expect(parseLlmReply(reply).responses).toEqual([weather]);
  });

  it("applyLiveDomainReply appends weather after places-style ack", () => {
    const facts = "חשמלאי מומלץ, פתח תקווה — 03-1234567";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: ["מצאתי כמה חשמלאים באזור:"],
        metadata: { places: { query: "חשמלאי", place: "פתח תקווה" } },
      }),
      facts,
    );
    expect(parseLlmReply(reply).responses).toEqual([
      "מצאתי כמה חשמלאים באזור:",
      facts,
    ]);
  });

  it("applyLiveDomainReply replaces EMPTY_REPLY_RETRY instead of appending", () => {
    const quote =
      "Bitcoin USD (BTC-USD): 84,111.54 USD.\nלא ייעוץ השקעות.";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: [EMPTY_REPLY_RETRY],
        metadata: { market: { queries: ["BTC-USD"] } },
      }),
      quote,
    );
    expect(parseLlmReply(reply).responses).toEqual([quote]);
    expect(parseLlmReply(reply).response).not.toContain("לא הצלחתי");
  });

  it("applyLiveDomainReply fills empty responses with live facts only", () => {
    const quote = "Bitcoin USD (BTC-USD): 84,111.54 USD.";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: [],
        metadata: { market: { queries: ["BTC-USD"] } },
      }),
      quote,
    );
    expect(parseLlmReply(reply).responses).toEqual([quote]);
  });

  it("applyLiveDomainReply pure ask keeps tip then body as two responses", () => {
    const tip = "אני רואה שיהיה קר — כדאי לקחת בגדים חמים.";
    const body = "מזג האוויר בפריז היום\n*גשם*\n• עכשיו כ־8°C";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: [],
        metadata: { weather: { place: "פריז", aspects: ["summary"] } },
      }),
      [tip, body],
    );
    expect(parseLlmReply(reply).responses).toEqual([tip, body]);
  });

  it("applyLiveDomainReply WATCH sample appends body only from tip+body array", () => {
    const tip = "כדאי לקחת מטריה.";
    const body = "מזג האוויר בתל אביב היום\n*גשם*";
    const reply = applyLiveDomainReply(
      JSON.stringify({
        responses: ["אעקוב אחרי הגשם ואעדכן"],
        metadata: { weather: { place: "תל אביב", aspects: ["summary"] } },
      }),
      [tip, body],
      { watchSample: true },
    );
    expect(parseLlmReply(reply).responses).toEqual([
      "אעקוב אחרי הגשם ואעדכן",
      `לידיעתך כרגע:\n${body}`,
    ]);
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

  it("patches metadata.buttons on a JSON LLM reply", () => {
    const patched = setEngineButtons(
      JSON.stringify({
        responses: ["עדכנתי את התזכורת ל־14:50"],
        metadata: { reminders: [], buttons: [] },
      }),
      [{ label: "הצג", command: "הצג תזכורות" }],
    );
    const parsed = parseLlmReply(patched);
    expect(parsed.responses).toEqual(["עדכנתי את התזכורת ל־14:50"]);
    expect(parsed.responseBubbles[0]?.buttons).toEqual([
      { label: "הצג", command: "הצג תזכורות" },
    ]);
    expect(parsed.buttons).toEqual([
      { label: "הצג", command: "הצג תזכורות" },
    ]);
  });

  it("keeps offer כן/לא on the offer bubble after an engine tip", () => {
    const withTip = appendEngineResponse(
      JSON.stringify({
        responses: [
          {
            text: "הוספתי לשלוח מייל לעירייה למטלות להיום.",
            buttons: [{ label: "הצג", command: "הצג רשימת מטלות" }],
          },
          {
            text: "רוצה שאוסיף גם תזכורת בוואטסאפ?",
            buttons: [
              { label: "כן", command: "כן" },
              { label: "לא", command: "לא" },
            ],
          },
        ],
        metadata: {},
      }),
      "באפשרותי לשמור פגישה קבועה, לדוגמא: *כל יום ראשון ב10 בבוקר פגישת צוות*",
    );
    const parsed = parseLlmReply(withTip);
    expect(parsed.responses).toHaveLength(3);
    expect(parsed.responseBubbles[0]?.buttons).toEqual([
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
    expect(parsed.responseBubbles[1]?.buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
    expect(parsed.responseBubbles[2]?.buttons).toBeUndefined();
    expect(parsed.responseBubbles[2]?.text).toContain("פגישה קבועה");
  });

  it("collab nav commands stay on confirm after tip; כן/לא stay on offer (command-bound)", () => {
    const sharedCmd = "הצג קניות משותפות עם מיכל";
    const allCmd = "כל הקניות";
    const frozen = setEngineSpokenBubbles(
      JSON.stringify({
        responses: [
          {
            text: "שיתפתי את הקניות עם מיכל.",
            buttons: [
              { label: "משותף עם מיכל", command: sharedCmd },
              { label: "כל הקניות", command: allCmd },
            ],
          },
          {
            text: "רוצה שאוסיף גם תזכורת?",
            buttons: [
              { label: "כן", command: "כן" },
              { label: "לא", command: "לא" },
            ],
          },
        ],
        metadata: {},
      }),
      parseLlmReply(
        JSON.stringify({
          responses: [
            {
              text: "שיתפתי את הקניות עם מיכל.",
              buttons: [
                { label: "משותף עם מיכל", command: sharedCmd },
                { label: "כל הקניות", command: allCmd },
              ],
            },
            {
              text: "רוצה שאוסיף גם תזכורת?",
              buttons: [
                { label: "כן", command: "כן" },
                { label: "לא", command: "לא" },
              ],
            },
          ],
          metadata: {},
        }),
      ).responseBubbles,
    );
    const withTip = appendEngineResponse(frozen, "טיפ על פגישה קבועה");
    const parsed = parseLlmReply(withTip);
    expect(parsed.responseBubbles[0]?.buttons?.map((b) => b.command)).toEqual([
      sharedCmd,
      allCmd,
    ]);
    expect(parsed.responseBubbles[1]?.buttons?.map((b) => b.command)).toEqual([
      "כן",
      "לא",
    ]);
    expect(parsed.responseBubbles[2]?.buttons).toBeUndefined();
    // Not all buttons collapsed onto first reply.
    expect(
      parsed.responseBubbles[0]?.buttons?.some((b) => b.command === "כן"),
    ).toBe(false);
  });

  it("freezes legacy turn-level buttons before tip so choices stay off the tip", () => {
    const model = JSON.stringify({
      responses: ["הוספתי מטלה.", "רוצה שאוסיף גם תזכורת?"],
      metadata: {
        buttons: [
          { label: "הצג", command: "הצג רשימת מטלות" },
          { label: "כן", command: "כן" },
          { label: "לא", command: "לא" },
        ],
      },
    });
    const frozen = setEngineSpokenBubbles(
      model,
      parseLlmReply(model).responseBubbles,
    );
    const withTip = appendEngineResponse(frozen, "טיפ על פגישה קבועה");
    const parsed = parseLlmReply(withTip);
    expect(parsed.responses).toHaveLength(3);
    expect(parsed.responseBubbles[0]?.buttons).toEqual([
      { label: "הצג", command: "הצג רשימת מטלות" },
    ]);
    expect(parsed.responseBubbles[1]?.buttons).toEqual([
      { label: "כן", command: "כן" },
      { label: "לא", command: "לא" },
    ]);
    expect(parsed.responseBubbles[2]?.buttons).toBeUndefined();
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
