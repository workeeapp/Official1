/**
 * LAST_LIVE_LOCATION pack/load/inject — offline, no live providers.
 */
import { describe, expect, it } from "vitest";
import {
  buildLastLiveLocation,
  formatLastLiveLocationContext,
  parseLastLiveLocation,
} from "../src/services/last-live-location.js";
import {
  packAssistantLlmRawForTests,
  pickLastLiveLocationFromAssistantRaws,
  pickLastRoutesBoardFromAssistantRaws,
} from "../src/services/chat.service.js";
import type { LastRoutesBoard } from "../src/services/routes.js";

const sampleBoard = {
  origin: "A",
  destination: "B",
  mode: "transit",
  fetchedAt: "2026-10-30T10:00:00.000Z",
  itineraries: [
    {
      id: "1",
      duration: "10 min",
      summary: "קו 1",
      steps: [],
    },
  ],
} as LastRoutesBoard;

describe("last-live-location parse/build/format", () => {
  it("builds and parses a minimal successful live place", () => {
    const built = buildLastLiveLocation({
      label: "תל אביב",
      lat: 32.08,
      lng: 34.78,
      kind: "geocoded",
      domain: "weather",
      role: "place",
      at: "2026-10-30T12:00:00.000Z",
    });
    expect(built).not.toBeNull();
    expect(parseLastLiveLocation(built)).toEqual(built);
  });

  it("rejects empty label and half-coords", () => {
    expect(
      buildLastLiveLocation({
        label: "  ",
        kind: "soft_place_text",
        domain: "places",
      }),
    ).toBeNull();
    expect(
      buildLastLiveLocation({
        label: "חיפה",
        lat: 32.8,
        lng: null,
        kind: "geocoded",
        domain: "weather",
      }),
    ).toBeNull();
  });

  it("inject text is AVAILABLE only and does not force use", () => {
    const loc = buildLastLiveLocation({
      label: "השרון",
      kind: "area",
      domain: "places",
      role: "area",
    })!;
    const ctx = formatLastLiveLocationContext(loc);
    expect(ctx).toContain("LAST_LIVE_LOCATION:");
    expect(ctx).toContain("AVAILABLE only");
    expect(ctx).toContain("השרון");
    expect(ctx).toMatch(/Stage 2 deixis/);
    expect(ctx).toMatch(/weather\/places\/routes\/jewish/);
    expect(formatLastLiveLocationContext(null)).toBe("");
  });

  it("accepts domain jewish", () => {
    const built = buildLastLiveLocation({
      label: "פתח תקווה",
      kind: "soft_place_text",
      domain: "jewish",
      role: "place",
      at: "2026-10-30T12:00:00.000Z",
    });
    expect(built?.domain).toBe("jewish");
    expect(parseLastLiveLocation(built)?.domain).toBe("jewish");
  });
});

describe("LAST_LIVE_LOCATION pack + newest-first scan", () => {
  it("stores location after successful use; intervening empty assistant does not hide it", () => {
    const loc = buildLastLiveLocation({
      label: "מלון דן",
      lat: 32.1,
      lng: 34.8,
      kind: "soft_place_text",
      domain: "places",
      at: "2026-10-30T11:00:00.000Z",
    })!;
    const withLoc = packAssistantLlmRawForTests({
      request: { ok: true },
      response: { reply: "מצאתי בתי קפה" },
      lastLiveLocation: loc,
    });
    // Reminder / ack row with no location (and no board).
    const intervening = packAssistantLlmRawForTests({
      request: null,
      response: { reply: "תזכורת: לקנות חלב" },
    });
    expect(
      pickLastLiveLocationFromAssistantRaws([intervening, withLoc]),
    ).toEqual(loc);
  });

  it("mention-only / failed turns do not invent a location (no pack field)", () => {
    const empty = packAssistantLlmRawForTests({
      response: { reply: "דיברנו על תל אביב אבל בלי live ACTION" },
    });
    expect(pickLastLiveLocationFromAssistantRaws([empty])).toBeNull();
    expect(
      (empty as Record<string, unknown>).lastLiveLocation,
    ).toBeUndefined();
  });

  it("packing lastRoutesBoard preserves prior LAST_LIVE_LOCATION and vice versa", () => {
    const loc = buildLastLiveLocation({
      label: "פתח תקווה",
      kind: "geocoded",
      domain: "weather",
      at: "2026-10-30T09:00:00.000Z",
    })!;
    const both = packAssistantLlmRawForTests({
      lastRoutesBoard: sampleBoard,
      lastLiveLocation: loc,
    });
    expect(pickLastRoutesBoardFromAssistantRaws([both])?.origin).toBe("A");
    expect(pickLastLiveLocationFromAssistantRaws([both])?.label).toBe(
      "פתח תקווה",
    );

    // Board-only pack (as syncTurnReplies does when only board is fresh) —
    // caller must pass through prior location; helper simulates that.
    const boardOnlyKeepingLoc = packAssistantLlmRawForTests({
      lastRoutesBoard: sampleBoard,
      lastLiveLocation: loc,
    });
    expect(pickLastLiveLocationFromAssistantRaws([boardOnlyKeepingLoc])).toEqual(
      loc,
    );
    expect(
      pickLastRoutesBoardFromAssistantRaws([boardOnlyKeepingLoc])?.destination,
    ).toBe("B");
  });

  it("intervening location-less row does not hide lastRoutesBoard (regression)", () => {
    const withBoard = packAssistantLlmRawForTests({
      lastRoutesBoard: sampleBoard,
    });
    const reminder = packAssistantLlmRawForTests({
      response: { reply: "תזכורת" },
    });
    expect(
      pickLastRoutesBoardFromAssistantRaws([reminder, withBoard])?.destination,
    ).toBe("B");
  });
});
