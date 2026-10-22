import { describe, expect, it } from "vitest";
import {
  baselineShaForWatch,
  evaluateComposeCondition,
  idleEdgeShaForHolding,
  isHoldingEdgeSha,
  mashovContentFingerprint,
  weatherContentFingerprint,
} from "../src/services/compose-condition.js";
import {
  collectConditionFieldRefs,
  compareWatchExpr,
  encodeFieldValueSha,
  evalWatchExprNode,
  sourcesNeededForRefs,
  watchFieldKey,
} from "../src/services/watch-expr.js";
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

  it("market_price gt: already above at create → idle stamp then next fire sends once", () => {
    const condition = {
      type: "market_price" as const,
      op: "gt" as const,
      value: 84_000,
    };
    const facts = { marketPrice: 84_180 };
    const raw = baselineShaForWatch({ condition, facts });
    expect(raw).toBe("market:below"); // holding token (misnamed)
    expect(isHoldingEdgeSha(raw)).toBe(true);
    const idle = idleEdgeShaForHolding(raw!);
    expect(idle).toBe("market:above");
    // Seed stamps idle → first fire edges into send.
    const first = evaluateComposeCondition({
      condition,
      facts,
      lastReportSha: idle,
    });
    expect(first.skipSend).toBe(false);
    expect(first.immediateSha).toBe("market:below");
    // Stay above after alert → quiet-skip.
    expect(
      evaluateComposeCondition({
        condition,
        facts,
        lastReportSha: "market:below",
      }).skipSend,
    ).toBe(true);
  });

  it("market_price gt: still below at create → idle baseline, no immediate send", () => {
    const condition = {
      type: "market_price" as const,
      op: "gt" as const,
      value: 84_000,
    };
    const facts = { marketPrice: 80_000 };
    const raw = baselineShaForWatch({ condition, facts });
    expect(raw).toBe("market:above");
    expect(isHoldingEdgeSha(raw)).toBe(false);
    expect(
      evaluateComposeCondition({
        condition,
        facts,
        lastReportSha: raw,
      }).skipSend,
    ).toBe(true);
  });

  it("weather_rain: skips when dry", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "weather_rain" },
      facts: { weatherIsRain: false },
    });
    expect(gate.skipSend).toBe(true);
    expect(gate.immediateSha).toBe("weather:dry");
  });

  it("weather_rain: sends when raining (edge into wet)", () => {
    const gate = evaluateComposeCondition({
      condition: { type: "weather_rain" },
      facts: { weatherIsRain: true },
    });
    expect(gate.skipSend).toBe(false);
    expect(gate.immediateSha).toBe("weather:wet");
  });

  it("weather_rain: edge — stays wet without re-alerting", () => {
    expect(
      evaluateComposeCondition({
        condition: { type: "weather_rain" },
        facts: { weatherIsRain: true },
        lastReportSha: "weather:wet",
      }).skipSend,
    ).toBe(true);
  });

  it("weather_changed: skips when fingerprint matches", () => {
    const fp = weatherContentFingerprint("מעונן בפתח תקווה");
    expect(
      evaluateComposeCondition({
        condition: { type: "weather_changed" },
        facts: { weatherFingerprint: fp },
        lastReportSha: fp,
      }).skipSend,
    ).toBe(true);
  });

  it("weather_changed: sends on new fingerprint", () => {
    const fp = weatherContentFingerprint("גשום בפתח תקווה");
    const gate = evaluateComposeCondition({
      condition: { type: "weather_changed" },
      facts: { weatherFingerprint: fp },
      lastReportSha: weatherContentFingerprint("מעונן"),
    });
    expect(gate.skipSend).toBe(false);
    expect(gate.shaAfterSend).toBe(fp);
  });

  it("market_change_compare: edge when left gt right", () => {
    const first = evaluateComposeCondition({
      condition: {
        type: "market_change_compare",
        left: "דולר",
        right: "יורו",
        op: "gt",
        metric: "daily_change_pct",
        leftDayOffset: 0,
        rightDayOffset: -1,
      },
      facts: { marketLeftChangePct: 1.2, marketRightChangePct: 0.4 },
      lastReportSha: "",
    });
    expect(first.skipSend).toBe(false);
    expect(first.immediateSha).toBe("market:below");
    expect(
      evaluateComposeCondition({
        condition: {
          type: "market_change_compare",
          left: "דולר",
          right: "יורו",
          op: "gt",
          metric: "daily_change_pct",
          leftDayOffset: 0,
          rightDayOffset: -1,
        },
        facts: { marketLeftChangePct: 1.5, marketRightChangePct: 0.3 },
        lastReportSha: "market:below",
      }).skipSend,
    ).toBe(true);
  });

  it("baselineShaForWatch stamps fingerprint for weather_changed", () => {
    const fp = weatherContentFingerprint("מעונן");
    expect(
      baselineShaForWatch({
        condition: { type: "weather_changed" },
        facts: { weatherFingerprint: fp },
      }),
    ).toBe(fp);
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

  it("expr: temp*2 eq 50 — edge into hold", () => {
    const key = watchFieldKey({
      field: "weather.temp_now",
      place: "פתח תקווה",
    });
    const condition = {
      type: "expr" as const,
      compare: "eq" as const,
      left: {
        op: "mul" as const,
        args: [
          { field: "weather.temp_now", place: "פתח תקווה" },
          { const: 2 },
        ],
      },
      right: { const: 50 },
    };
    const first = evaluateComposeCondition({
      condition,
      facts: { exprFieldValues: { [key]: 25 } },
      lastReportSha: "",
    });
    expect(first.skipSend).toBe(false);
    expect(first.immediateSha).toBe("expr:hold");
    expect(
      evaluateComposeCondition({
        condition,
        facts: { exprFieldValues: { [key]: 25 } },
        lastReportSha: "expr:hold",
      }).skipSend,
    ).toBe(true);
  });

  it("expr: eur+usd lt 10 — idle when sum is above", () => {
    const eurKey = watchFieldKey({ field: "market.price", symbol: "יורו" });
    const usdKey = watchFieldKey({ field: "market.price", symbol: "דולר" });
    const condition = {
      type: "expr" as const,
      compare: "lt" as const,
      left: {
        op: "add" as const,
        args: [
          { field: "market.price", symbol: "יורו" },
          { field: "market.price", symbol: "דולר" },
        ],
      },
      right: { const: 10 },
    };
    const gate = evaluateComposeCondition({
      condition,
      facts: {
        exprFieldValues: { [eurKey]: 6, [usdKey]: 5 },
      },
      lastReportSha: "",
    });
    expect(gate.skipSend).toBe(true);
    expect(gate.immediateSha).toBe("expr:idle");
    const hold = evaluateComposeCondition({
      condition,
      facts: {
        exprFieldValues: { [eurKey]: 4, [usdKey]: 3.6 },
      },
      lastReportSha: "expr:idle",
    });
    expect(hold.skipSend).toBe(false);
    expect(hold.immediateSha).toBe("expr:hold");
  });

  it("expr: approx for כ־", () => {
    expect(compareWatchExpr(9.7, "approx", 10, 0.5)).toBe(true);
    expect(compareWatchExpr(8, "approx", 10, 0.5)).toBe(false);
  });

  it("field_changed: skips until value differs from baseline", () => {
    const key = watchFieldKey({
      field: "weather.temp_now",
      place: "פתח תקווה",
    });
    const encoded = encodeFieldValueSha(22);
    expect(
      evaluateComposeCondition({
        condition: {
          type: "field_changed",
          field: "weather.temp_now",
          place: "פתח תקווה",
        },
        facts: { exprFieldValues: { [key]: 22 } },
        lastReportSha: encoded,
      }).skipSend,
    ).toBe(true);
    const gate = evaluateComposeCondition({
      condition: {
        type: "field_changed",
        field: "weather.temp_now",
        place: "פתח תקווה",
      },
      facts: { exprFieldValues: { [key]: 28 } },
      lastReportSha: encoded,
    });
    expect(gate.skipSend).toBe(false);
    expect(gate.shaAfterSend).toBe(encodeFieldValueSha(28));
  });

  it("evalWatchExprNode mul and add", () => {
    const tempKey = watchFieldKey({
      field: "weather.temp_now",
      place: "פתח תקווה",
    });
    const eurKey = watchFieldKey({ field: "market.price", symbol: "יורו" });
    const usdKey = watchFieldKey({ field: "market.price", symbol: "דולר" });
    expect(
      evalWatchExprNode(
        {
          op: "mul",
          args: [
            { field: "weather.temp_now", place: "פתח תקווה" },
            { const: 2 },
          ],
        },
        { [tempKey]: 25 },
      ),
    ).toBe(50);
    expect(
      evalWatchExprNode(
        {
          op: "add",
          args: [
            { field: "market.price", symbol: "יורו" },
            { field: "market.price", symbol: "דולר" },
          ],
        },
        { [eurKey]: 4, [usdKey]: 3.6 },
      ),
    ).toBeCloseTo(7.6);
  });

  it("multi-source: collectConditionFieldRefs needs weather+market", () => {
    const refs = collectConditionFieldRefs({
      type: "expr",
      compare: "lt",
      left: {
        op: "add",
        args: [
          { field: "weather.temp_now", place: "תל אביב" },
          { field: "market.price", symbol: "דולר" },
        ],
      },
      right: { const: 100 },
    });
    expect(sourcesNeededForRefs(refs)).toEqual({
      weather: true,
      market: true,
    });
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
