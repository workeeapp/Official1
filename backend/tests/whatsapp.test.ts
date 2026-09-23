import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/config/env.js";
import { deliverWhatsAppRelays } from "../src/services/whatsapp-send.js";
import {
  extractInboundTexts,
  parseWhatsAppWorkerCommand,
  phonesMatch,
} from "../src/services/whatsapp.service.js";

describe("WhatsApp webhook", () => {
  beforeEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    resetEnvCache();
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
  });

  it("matches local and WhatsApp phone numbers", () => {
    expect(phonesMatch("050-0000002", "972500000002")).toBe(true);
    expect(phonesMatch("050-0000002", "972500000001")).toBe(false);
  });

  it("parses WhatsApp worker switch commands", () => {
    expect(parseWhatsAppWorkerCommand("מי העובדים")).toEqual({ list: true });
    expect(parseWhatsAppWorkerCommand("who can I talk to")).toEqual({ list: true });
    expect(parseWhatsAppWorkerCommand("דבר עם דוד")).toEqual({
      workerName: "דוד",
    });
    expect(parseWhatsAppWorkerCommand("עברי ל לוסי")).toEqual({
      workerName: "לוסי",
    });
    expect(parseWhatsAppWorkerCommand("talk to Lucy")).toEqual({
      workerName: "Lucy",
    });
    expect(parseWhatsAppWorkerCommand("hello")).toEqual({});
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
