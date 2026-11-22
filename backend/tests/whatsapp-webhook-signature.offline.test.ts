/**
 * F0 — WhatsApp webhook HMAC unit + route tests (no DB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/config/env.js";
import {
  listWhatsAppEvents,
  resetWhatsAppEvents,
} from "../src/services/whatsapp-log.js";
import * as whatsappService from "../src/services/whatsapp.service.js";
import {
  assertWhatsAppWebhookConfig,
  signWhatsAppWebhookBody,
  verifyWhatsAppWebhookSignature,
  WHATSAPP_SIGNATURE_HEADER,
} from "../src/services/whatsapp-webhook-signature.js";

const TEST_SECRET = "test-whatsapp-app-secret-f0";

const samplePayload = {
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
};

describe("verifyWhatsAppWebhookSignature (unit)", () => {
  const raw = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");

  it("accepts a valid sha256 signature", () => {
    const header = signWhatsAppWebhookBody(raw, TEST_SECRET);
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: header,
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects missing signature header with 401", () => {
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: undefined,
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 401 });
  });

  it("rejects malformed signature with 401", () => {
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: "not-a-signature",
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 401 });
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: "sha256=zz",
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 401 });
  });

  it("rejects wrong signature / tampered body with 403", () => {
    const header = signWhatsAppWebhookBody(raw, TEST_SECRET);
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: Buffer.from('{"hello":"nope"}', "utf8"),
        signatureHeader: header,
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 403 });
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: "sha256=" + "ab".repeat(32),
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 403 });
  });

  it("rejects missing app secret with 403 (no production bypass)", () => {
    const header = signWhatsAppWebhookBody(raw, TEST_SECRET);
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: header,
        appSecret: undefined,
      }),
    ).toEqual({ ok: false, status: 403 });
  });

  it("rejects missing rawBody with 401", () => {
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: undefined,
        signatureHeader: signWhatsAppWebhookBody(raw, TEST_SECRET),
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 401 });
  });

  it("handles different-length hex without throwing", () => {
    expect(
      verifyWhatsAppWebhookSignature({
        rawBody: raw,
        signatureHeader: "sha256=abcd",
        appSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, status: 403 });
  });
});

describe("assertWhatsAppWebhookConfig", () => {
  it("fails closed in production when WA token set without app secret", () => {
    expect(() =>
      assertWhatsAppWebhookConfig({
        NODE_ENV: "production",
        WHATSAPP_ACCESS_TOKEN: "token",
        WHATSAPP_APP_SECRET: undefined,
      }),
    ).toThrow(/WHATSAPP_APP_SECRET/);
  });

  it("allows production when WA inactive (no access token)", () => {
    expect(() =>
      assertWhatsAppWebhookConfig({
        NODE_ENV: "production",
        WHATSAPP_ACCESS_TOKEN: undefined,
        WHATSAPP_APP_SECRET: undefined,
      }),
    ).not.toThrow();
  });

  it("does not fail in test/development without secret", () => {
    expect(() =>
      assertWhatsAppWebhookConfig({
        NODE_ENV: "test",
        WHATSAPP_ACCESS_TOKEN: "token",
        WHATSAPP_APP_SECRET: undefined,
      }),
    ).not.toThrow();
  });
});

describe("WhatsApp webhook POST signature (route)", () => {
  beforeEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.WHATSAPP_APP_SECRET = TEST_SECRET;
    resetEnvCache();
    resetWhatsAppEvents();
    vi.restoreAllMocks();
  });

  it("GET verify still works without signature", async () => {
    const app = createApp();
    const response = await request(app).get("/api/whatsapp/webhook").query({
      "hub.mode": "subscribe",
      "hub.verify_token": "test-verify-token",
      "hub.challenge": "12345",
    });
    expect(response.status).toBe(200);
    expect(response.text).toBe("12345");
  });

  it("accepts signed inbound and reaches ingestion path", async () => {
    const spy = vi
      .spyOn(whatsappService, "handleInboundWhatsAppTexts")
      .mockResolvedValue(undefined);
    const app = createApp();
    const raw = Buffer.from(JSON.stringify(samplePayload), "utf8");
    const sig = signWhatsAppWebhookBody(raw, TEST_SECRET);
    const response = await request(app)
      .post("/api/whatsapp/webhook")
      .set(WHATSAPP_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(raw.toString("utf8"));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(listWhatsAppEvents().some((e) => e.step === "webhook_post")).toBe(
      true,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("unsigned POST never reaches handleInboundWhatsAppTexts", async () => {
    const spy = vi
      .spyOn(whatsappService, "handleInboundWhatsAppTexts")
      .mockResolvedValue(undefined);
    const app = createApp();
    const response = await request(app)
      .post("/api/whatsapp/webhook")
      .send(samplePayload);

    expect([401, 403]).toContain(response.status);
    expect(spy).not.toHaveBeenCalled();
    expect(listWhatsAppEvents()).toEqual([]);
  });

  it("wrong signature never reaches handleInboundWhatsAppTexts", async () => {
    const spy = vi
      .spyOn(whatsappService, "handleInboundWhatsAppTexts")
      .mockResolvedValue(undefined);
    const app = createApp();
    const raw = Buffer.from(JSON.stringify(samplePayload), "utf8");
    const response = await request(app)
      .post("/api/whatsapp/webhook")
      .set(WHATSAPP_SIGNATURE_HEADER, "sha256=" + "00".repeat(32))
      .set("Content-Type", "application/json")
      .send(raw.toString("utf8"));

    expect(response.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect(listWhatsAppEvents()).toEqual([]);
  });
});
