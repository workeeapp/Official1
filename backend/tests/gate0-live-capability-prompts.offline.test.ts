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
const configPath = resolve(root, "LLM.config.json");

describe("Gate 0 live capability prompt markers", () => {
  const chat = readFileSync(chatPath, "utf8");
  const config = readFileSync(configPath, "utf8");
  const action = readFileSync(actionPath, "utf8");

  it("Weather/Market/Mashov/Jewish/Routes include LIVE CAPABILITY and no Stage B", () => {
    for (const needle of [
      "LIVE CAPABILITY GATE (generic",
      "WEATHER (live):",
      "MARKET (live):",
      "MASHOV (live):",
      "JEWISH / SHABBAT (live):",
      "ROUTES:",
    ]) {
      expect(chat).toContain(needle);
    }
    expect(chat).toMatch(
      /LIVE CAPABILITY GATE \(generic[\s\S]*?FORBIDDEN fetching a nearby aspect/,
    );
    expect(chat).toMatch(
      /WEATHER \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?no Stage B for weather/,
    );
    expect(chat).toMatch(
      /MARKET \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?no Stage B/,
    );
    // FX clause is Market (Hebrew tokens may be ASCII "?" placeholders in runtime).
    expect(chat).toMatch(/MARKET \(live\):[\s\S]*?FX \(/);
    expect(chat).toMatch(
      /MASHOV \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?calendar filter/,
    );
    expect(chat).toMatch(
      /MASHOV \(live\):[\s\S]*?upcoming exam calendar[\s\S]*?mashov=null/,
    );
    expect(chat).toMatch(
      /JEWISH \/ SHABBAT \(live\):[\s\S]*?LIVE CAPABILITY \(F\/Q\/V\/U\):[\s\S]*?no Stage B/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?Google estimates OR official MOT/,
    );
    // Wave 1 capability U: network disruptions not connected — no SX subsystem.
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?Network disruptions[\s\S]*?routes=null[\s\S]*?capability not connected/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?FORBIDDEN inventing SX\/alerts/,
    );
    // Follow-up option N must recalculate — no itinerary store claim.
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?recalculate[\s\S]*?no itinerary store/,
    );
    // Seed/schema prompts (Hebrew) must also refuse disruption checks.
    expect(config).toMatch(
      /Network-wide disruptions\/cancellations[\s\S]*?routes=null[\s\S]*?disclose U/,
    );
    expect(config).toMatch(/FORBIDDEN inventing alerts/);
    expect(action).toMatch(
      /Network-wide disruptions[\s\S]*?routes=null[\s\S]*?disclose U/,
    );
    expect(chat).toMatch(
      /BUS WATCH:[\s\S]*?NOT continuous realtime monitoring/,
    );
  });

  it("requireLiveSelect Stage B only on Places/Flights/Routes chat gates", () => {
    const gates = [
      ...chat.matchAll(
        /requireLiveSelect:\s*(\w+)\.requireLiveSelect\s*===\s*true/g,
      ),
    ].map((m) => m[1]);
    expect(gates.sort()).toEqual(
      ["flightsAction", "placesAction", "routesAction"].sort(),
    );
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
