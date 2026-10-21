import { describe, expect, it } from "vitest";
import {
  evaluateComposeCondition,
  mashovContentFingerprint,
} from "../src/services/compose-condition.js";
import { isWmoRainCode } from "../src/services/weather.js";
import { resolveComposeFireOutbound } from "../src/services/reminder-fire.js";

describe("isWmoRainCode", () => {
  it("treats drizzle/rain/showers/thunder as rain", () => {
    expect(isWmoRainCode(61)).toBe(true);
    expect(isWmoRainCode(80)).toBe(true);
    expect(isWmoRainCode(95)).toBe(true);
    expect(isWmoRainCode(0)).toBe(false);
    expect(isWmoRainCode(71)).toBe(false);
  });
});

describe("evaluateComposeCondition", () => {
  it("market_price: skips when above threshold", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "market_price", op: "lt", value: 80_000 },
      facts: { marketPrice: 90_000 },
      lastReportSha: "",
    });
    expect(gate.skipSend).toBe(true);
    expect(gate.immediateSha).toBe("market:above");
  });

  it("market_price: sends on first transition into below", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "market_price", op: "lt", value: 80_000 },
      facts: { marketPrice: 75_000 },
      lastReportSha: "",
    });
    expect(gate.skipSend).toBe(false);
    expect(gate.immediateSha).toBe("market:below");
  });

  it("market_price: edge — stays below without re-alerting", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "market_price", op: "lt", value: 80_000 },
      facts: { marketPrice: 70_000 },
      lastReportSha: "market:below",
    });
    expect(gate.skipSend).toBe(true);
    expect(gate.immediateSha).toBe("market:below");
  });

  it("market_price: re-alerts when crossing above→below again", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "market_price", op: "lt", value: 80_000 },
      facts: { marketPrice: 79_000 },
      lastReportSha: "market:above",
    });
    expect(gate.skipSend).toBe(false);
  });

  it("weather_rain: skips when dry", () => {
    expect(
      evaluateComposeCondition({
        condition: { type: "weather_rain" },
        facts: { weatherIsRain: false },
      }).skipSend,
    ).toBe(true);
  });

  it("weather_rain: sends when raining", () => {
    expect(
      evaluateComposeCondition({
        condition: { type: "weather_rain" },
        facts: { weatherIsRain: true },
      }).skipSend,
    ).toBe(false);
  });

  it("mashov_new: skips when fingerprint matches lastReportSha", () => {
    const fp = mashovContentFingerprint("ציונים…");
    expect(
      evaluateComposeCondition({
        condition: { type: "mashov_new" },
        facts: { mashovFingerprint: fp },
        lastReportSha: fp,
      }).skipSend,
    ).toBe(true);
  });

  it("mashov_new: sends and schedules shaAfterSend when content is new", () => {
    const fp = mashovContentFingerprint("ציונים חדשים");
    const gate = evaluateComposeCondition({
      condition: { type: "mashov_new" },
      facts: { mashovFingerprint: fp },
      lastReportSha: "",
    });
    expect(gate.skipSend).toBe(false);
    expect(gate.shaAfterSend).toBe(fp);
  });

  it("bus_eta: skips when ETA above threshold", () => {
    expect(
      evaluateComposeCondition({
        condition: {
          type: "bus_eta",
          origin: "ארנס",
          destination: "תל אביב",
          line: "51",
          headsign: "",
          minutesBefore: 10,
        },
        facts: { busEtaMinutes: 25, busEtaFingerprint: "51|08:40" },
        lastReportSha: "",
      }).skipSend,
    ).toBe(true);
  });

  it("bus_eta: sends once then skips same fingerprint", () => {
    const condition = {
      type: "bus_eta" as const,
      origin: "ארנס",
      destination: "תל אביב",
      line: "51",
      headsign: "",
      minutesBefore: 10,
    };
    const first = evaluateComposeCondition({
      condition,
      facts: { busEtaMinutes: 8, busEtaFingerprint: "51|08:40" },
      lastReportSha: "",
    });
    expect(first.skipSend).toBe(false);
    expect(first.shaAfterSend).toBe("51|08:40");
    expect(
      evaluateComposeCondition({
        condition,
        facts: { busEtaMinutes: 7, busEtaFingerprint: "51|08:40" },
        lastReportSha: "51|08:40",
      }).skipSend,
    ).toBe(true);
  });
});

describe("conditional fire outbound", () => {
  it("skips send when condition is false — no WhatsApp body applied", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "weather_rain" },
      facts: { weatherIsRain: false },
    });
    expect(gate.skipSend).toBe(true);
    // Fire path: when skipSend, settle succeeds without using outbound body.
  });

  it("uses fixed facts body when condition is true", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "weather_rain" },
      facts: { weatherIsRain: true },
    });
    expect(gate.skipSend).toBe(false);
    const resolved = resolveComposeFireOutbound({
      brief: "עדכון גשם",
      itemLabel: "לעדכן כשיורד גשם",
      composed: "יורד גשם בפתח תקווה — 12 מ״מ.",
    });
    expect(resolved.body).toContain("יורד גשם");
    expect(resolved.lastComposedToSave).toContain("יורד גשם");
  });
});
