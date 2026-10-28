/**
 * Focused offline baseline + contracts for transit UX gaps #6/#7/#9:
 * - Semantic: closed-choice open must not swallow missed-bus / mixed / paraphrases
 * - recalculate ACTION parse + board O/D fill (no utterance regex)
 * - disclose_network_disruption alone / mixed
 * - bus_eta poll-fail streak helpers + Google≠SIRI wording
 *
 * Run: npx vitest run tests/routes-transit-ux-gaps.offline.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoutesAction } from "@workee/shared";
import {
  BUS_ETA_POLL_FAIL_NOTIFY_AFTER,
  busEtaPollFailNotifiedSha,
  busEtaPollFailSha,
  fillRoutesOdFromBoard,
  isBusEtaPollFailNotified,
  mapRoutesOpenCommand,
  parseBusEtaPollFailCount,
  ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE,
  ROUTES_DISRUPTION_UNAVAILABLE_HE,
  ROUTES_RECALCULATE_NO_CONTEXT_HE,
  type LastRoutesBoard,
} from "../src/services/routes.js";

const sampleBoard = (): LastRoutesBoard => ({
  origin: "פתח תקווה",
  destination: "תל אביב",
  mode: "transit",
  fetchedAt: "2026-10-28T08:00:00.000Z",
  itineraries: [
    {
      durationText: "40 דקות",
      durationSeconds: 2400,
      distanceMeters: 12000,
      fareText: "",
      leaveByText: "08:10",
      arriveByText: "08:50",
      steps: [],
    },
  ],
});

describe("semantic baseline: closed-choice open vs missed-bus / mixed", () => {
  const missedParaphrases = [
    "פספסתי את האוטובוס, מה עכשיו?",
    "פספסתי את האוטובוס",
    "החמצתי את האוטובוס מה עושים",
    "מה עכשיו אחרי שפספסתי",
    "לא הספקתי לאוטובוס, יש חלופה?",
    "missed the bus what now",
  ];

  it("does not intercept missed-bus paraphrases as board-open", () => {
    for (const msg of missedParaphrases) {
      expect(mapRoutesOpenCommand(msg)).toBeNull();
    }
  });

  it("does not intercept mixed open+new-trip intent", () => {
    expect(mapRoutesOpenCommand("המסלול המומלץ לדיזנגוף")).toBeNull();
    expect(mapRoutesOpenCommand("מסלול 2 ואז לבית אחר")).toBeNull();
    expect(mapRoutesOpenCommand("כל המסלולים מחיפה")).toBeNull();
    expect(mapRoutesOpenCommand("פספסתי — המסלול המומלץ")).toBeNull();
  });

  it("still accepts exact closed choices", () => {
    expect(mapRoutesOpenCommand("המסלול המומלץ")).toBe("recommended");
    expect(mapRoutesOpenCommand("כל המסלולים")).toBe("all");
    expect(mapRoutesOpenCommand("מסלול 2")).toBe(2);
    expect(mapRoutesOpenCommand("הציגי את ההמלצה")).toBe("recommended");
  });
});

describe("missed-bus recalculate ACTION (model-driven)", () => {
  it("parses recalculate with empty O/D (engine fills from board)", () => {
    const a = parseRoutesAction({
      routes: { recalculate: true, aspects: ["summary"] },
    });
    expect(a).toMatchObject({
      origin: "",
      destination: "",
      recalculate: true,
      openItinerary: null,
    });
  });

  it("recalculate wins over open_itinerary (never stale board expand)", () => {
    const a = parseRoutesAction({
      routes: {
        recalculate: true,
        open_itinerary: "recommended",
        aspects: ["summary"],
      },
    });
    expect(a?.recalculate).toBe(true);
    expect(a?.openItinerary).toBeNull();
  });

  it("parses recalculate with explicit O/D (changed destination)", () => {
    const a = parseRoutesAction({
      routes: {
        recalculate: true,
        origin: "פתח תקווה",
        destination: "חולון",
        aspects: ["summary"],
      },
    });
    expect(a).toMatchObject({
      origin: "פתח תקווה",
      destination: "חולון",
      recalculate: true,
      openItinerary: null,
    });
  });

  it("fillRoutesOdFromBoard reuses board without inventing places", () => {
    expect(fillRoutesOdFromBoard("", "", sampleBoard())).toEqual({
      origin: "פתח תקווה",
      destination: "תל אביב",
    });
    expect(fillRoutesOdFromBoard("רמת גן", "", sampleBoard())).toEqual({
      origin: "רמת גן",
      destination: "תל אביב",
    });
    expect(fillRoutesOdFromBoard("", "", null)).toEqual({
      origin: "",
      destination: "",
    });
  });

  it("exposes recalculate-missing-context honesty string", () => {
    expect(ROUTES_RECALCULATE_NO_CONTEXT_HE).toMatch(/מוצא|יעד/);
    expect(ROUTES_RECALCULATE_NO_CONTEXT_HE).not.toMatch(/SIRI|גוגל מצא/);
  });
});

describe("network disruption disclose (no invented SX)", () => {
  it("parses disclose-only ACTION without O/D", () => {
    const a = parseRoutesAction({
      routes: { disclose_network_disruption: true },
    });
    expect(a).toMatchObject({
      origin: "",
      destination: "",
      discloseNetworkDisruption: true,
      recalculate: false,
      openItinerary: null,
    });
  });

  it("parses mixed trip + disclose", () => {
    const a = parseRoutesAction({
      routes: {
        origin: "A",
        destination: "B",
        aspects: ["summary"],
        disclose_network_disruption: true,
      },
    });
    expect(a).toMatchObject({
      origin: "A",
      destination: "B",
      discloseNetworkDisruption: true,
    });
  });

  it("canonical disclose never claims a successful network check", () => {
    expect(ROUTES_DISRUPTION_UNAVAILABLE_HE).toMatch(/לא מחובר|אין לי מידע/);
    expect(ROUTES_DISRUPTION_UNAVAILABLE_HE).not.toMatch(
      /אין שיבושים|בדקתי|הכל תקין/,
    );
  });
});

describe("bus_eta poll failure honesty helpers", () => {
  it("tracks transient fail streak then notified marker", () => {
    expect(parseBusEtaPollFailCount("")).toBe(0);
    expect(parseBusEtaPollFailCount(busEtaPollFailSha(1))).toBe(1);
    expect(parseBusEtaPollFailCount(busEtaPollFailSha(2))).toBe(2);
    expect(BUS_ETA_POLL_FAIL_NOTIFY_AFTER).toBe(3);
    const notified = busEtaPollFailNotifiedSha(
      new Date("2026-10-28T08:00:00.000Z"),
    );
    expect(isBusEtaPollFailNotified(notified)).toBe(true);
    expect(parseBusEtaPollFailCount(notified)).toBe(0);
  });

  it("user-facing poll-unavailable copy is Google estimate honesty, not SIRI", () => {
    expect(ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE).toMatch(/גוגל|Google/i);
    expect(ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE).toMatch(/SIRI|לא/);
    expect(ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE).not.toMatch(/מגיע בעוד/);
  });
});

describe("prompt / source contracts for gaps", () => {
  it("chat ROUTES teaches recalculate + disruption disclose + bus poll honesty", () => {
    const chat = readFileSync(
      resolve(__dirname, "../src/services/chat.service.ts"),
      "utf8",
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?Missed bus\/departure[\s\S]*?recalculate:true[\s\S]*?newly calculated/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?Network disruptions[\s\S]*?routes=null[\s\S]*?capability not connected/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?disclose_network_disruption:true[\s\S]*?do not block the route/,
    );
    expect(chat).toMatch(
      /BUS WATCH:[\s\S]*?NOT MOT SIRI live[\s\S]*?transient poll failures[\s\S]*?honesty notice/,
    );
    expect(chat).toContain("fillRoutesOdFromBoard");
    expect(chat).toContain("ROUTES_DISRUPTION_UNAVAILABLE_HE");
    expect(chat).toContain("ROUTES_RECALCULATE_NO_CONTEXT_HE");
  });

  it("reminder-fire wires persistent bus_eta poll notify", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/services/reminder-fire.ts"),
      "utf8",
    );
    expect(src).toContain("forceBusEtaPollFailNotify");
    expect(src).toContain("ROUTES_BUS_ETA_POLL_UNAVAILABLE_HE");
    expect(src).toContain("BUS_ETA_POLL_FAIL_NOTIFY_AFTER");
  });
});
