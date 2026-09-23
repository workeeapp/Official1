import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/config/env.js";
import { phonesMatch } from "../src/services/whatsapp.service.js";

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
});
