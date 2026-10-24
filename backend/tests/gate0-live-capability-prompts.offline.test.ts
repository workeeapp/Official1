/**
 * Gate 0 — prompt-only F/Q/V/U disclose markers (not live Hebrew proof).
 * Asserts instruction text + no schema / Places-Flights functional drift in this gate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");
const chatPath = resolve(process.cwd(), "src/services/chat.service.ts");
const actionPath = resolve(root, "LLM.action.json");

describe("Gate 0 live capability prompt markers", () => {
  const chat = readFileSync(chatPath, "utf8");

  it("Weather/Market/Mashov/Jewish/Routes include LIVE CAPABILITY and no Stage B", () => {
    for (const needle of [
      "WEATHER (live):",
      "MARKET (live):",
      "MASHOV (live):",
      "JEWISH / SHABBAT (live):",
      "ROUTES (live Google public transit):",
    ]) {
      expect(chat).toContain(needle);
    }
    expect(chat).toMatch(
      /WEATHER \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?no Stage B for weather/,
    );
    expect(chat).toMatch(
      /MARKET \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?no Stage B/,
    );
    expect(chat).toMatch(
      /MARKET \(live\):[\s\S]*?FX \(דולר\/יורו/,
    );
    expect(chat).toMatch(
      /MASHOV \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?calendar filter ≠/,
    );
    expect(chat).toMatch(
      /JEWISH \/ SHABBAT \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?no Stage B/,
    );
    expect(chat).toMatch(
      /ROUTES \(live Google public transit\):[\s\S]*?NOT MOT GTFS\/SIRI/,
    );
    expect(chat).toMatch(
      /ROUTES \(live Google public transit\):[\s\S]*?no require_live_select \/ no Stage B/,
    );
    expect(chat).toMatch(
      /BUS WATCH:[\s\S]*?NOT continuous realtime monitoring/,
    );
  });

  it("Gate 0 did not add requireLiveSelect to non-Places/Flights chat gates", () => {
    const gates = [
      ...chat.matchAll(
        /requireLiveSelect:\s*(\w+)\.requireLiveSelect\s*===\s*true/g,
      ),
    ].map((m) => m[1]);
    expect(gates).toEqual(["placesAction", "flightsAction"]);
  });

  it("LLM.action.json live_select.domain enum unchanged (no Gate 0 schema edit)", () => {
    const raw = readFileSync(actionPath, "utf8");
    // Domain enum block for live_select (Gate 0 must not alter schema).
    expect(raw).toMatch(
      /"live_select"[\s\S]*?"domain"[\s\S]*?"enum":\s*\[\s*"places",\s*"flights",\s*"routes",\s*"mashov"\s*\]/,
    );
    // Weather/market/routes must not gain require_live_select in Gate 0.
    const weatherBlock = raw.slice(
      raw.indexOf('"weather"'),
      raw.indexOf('"market"'),
    );
    const marketBlock = raw.slice(
      raw.indexOf('"market"'),
      raw.indexOf('"mashov"'),
    );
    const routesBlock = raw.slice(
      raw.indexOf('"routes"'),
      raw.indexOf('"flights"'),
    );
    expect(weatherBlock).not.toContain("require_live_select");
    expect(marketBlock).not.toContain("require_live_select");
    expect(routesBlock).not.toContain("require_live_select");
  });
});
