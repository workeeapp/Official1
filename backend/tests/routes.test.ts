import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boardingStopMatchesOrigin,
  originSuggestsAreaOrLandmark,
  fetchRoutesFacts,
  formatOfficialBoardingDeparturesHe,
  formatRoutesHebrew,
  geocodeNamedPlaceForNearestStop,
  itineraryWalkTransferBits,
  rankTripItineraries,
  rankTripItinerariesByClosestBoard,
  boardingWalkSecondsBeforeTransit,
  itineraryClosestBoardComparable,
  ROUTES_CLOSEST_BOARD_INSUFFICIENT_HE,
  ROUTES_WALK_PARTIAL_NOTE_HE,
  ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE,
  ROUTES_DISRUPTION_UNAVAILABLE_HE,
  ROUTES_GOOGLE_ETA_NOT_SIRI_INTRO_HE,
  ROUTES_ITINERARY_DISPLAY_CAP,
  ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE,
  ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE,
  ROUTES_STEPS_LOCAL_TRUNCATION_HE,
  ROUTES_STEPS_SUMMARY_DISPLAY_CAP,
  routesMultiAltsCueHe,
  displayLeaveArriveForLead,
  durationTextPreferHe,
  filterRoutesFactsByItineraryIds,
  routesItinerariesToLiveRetrievalRecords,
  parseRoutesAspects,
  resolveRoutesReply,
  toRoutesRfc3339,
  type RouteItineraryOption,
  type RoutesFacts,
} from "../src/services/routes.js";

/** Compact multi cue contract (wording may include optional diff bits). */
function expectMultiAltsCue(text: string, extraCount: number): void {
  expect(text).toContain(`עוד ${extraCount} אפשרויות`);
  expect(text).toContain("לפרטים בקשי לפי קו או שעת יציאה");
  expect(text).toContain("בחיפוש חדש מתקבלות אפשרויות מעודכנות");
  expect(text).not.toContain("לא אזהה אוטומטית");
  expect(text).not.toContain("יציאה/משך/הליכה שונים");
}
import * as gtfsQuery from "../src/services/gtfs-query.js";
import * as siriSm from "../src/services/siri-sm.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Find computeRoutes request body among geocode + Routes fetch calls. */
function computeRoutesBody(
  fetchImpl: { mock: { calls: unknown[][] } },
): Record<string, unknown> {
  for (const call of fetchImpl.mock.calls) {
    const url = String(call[0] ?? "");
    const init = call[1] as { body?: string } | undefined;
    if (url.includes("computeRoutes") || String(init?.body ?? "").includes("TRANSIT")) {
      try {
        return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }
  return {};
}

describe("parseRoutesAspects", () => {
  it("defaults to summary", () => {
    expect(parseRoutesAspects(undefined)).toEqual(["summary"]);
  });

  it("keeps known aspects", () => {
    expect(parseRoutesAspects(["eta", "frequency", "bogus"])).toEqual([
      "eta",
      "frequency",
    ]);
  });
});

describe("toRoutesRfc3339", () => {
  it("returns null for empty", () => {
    expect(toRoutesRfc3339("")).toBeNull();
  });

  it("passes through Zulu ISO", () => {
    expect(toRoutesRfc3339("2026-10-22T07:00:00Z")).toBe(
      "2026-10-22T07:00:00.000Z",
    );
  });
});

describe("boardingStopMatchesOrigin", () => {
  it("matches shared Hebrew tokens", () => {
    expect(
      boardingStopMatchesOrigin(
        "שלום דורני/העצמאות",
        "שלום דורני פתח תקווה",
      ),
    ).toBe(true);
  });

  it("rejects unrelated boarding stop", () => {
    expect(
      boardingStopMatchesOrigin("קניון עזריאלי", "שלום דורני פתח תקווה"),
    ).toBe(false);
  });
});

describe("originSuggestsAreaOrLandmark", () => {
  it("detects אזור / עירייה landmarks", () => {
    expect(originSuggestsAreaOrLandmark("אזור עיריית פתח תקווה")).toBe(true);
    expect(originSuggestsAreaOrLandmark("עיריית פתח תקווה")).toBe(true);
    expect(originSuggestsAreaOrLandmark("קניון גדול בפתח תקווה")).toBe(true);
  });

  it("does not treat a named stop as an area", () => {
    expect(originSuggestsAreaOrLandmark("שלום דורני פתח תקווה")).toBe(false);
    expect(originSuggestsAreaOrLandmark("תחנת פינסקר גיסין")).toBe(false);
  });
});

describe("formatRoutesHebrew", () => {
  const base: RoutesFacts = {
    origin: "ז׳בוטינסקי פתח תקווה",
    destination: "דיזנגוף סנטר",
    departure: "",
    arrival: "",
    line: "",
    headsign: "",
    mode: "transit",
    aspects: ["summary"],
    durationText: "45 דקות",
    durationSeconds: 2700,
    distanceMeters: 12000,
    leaveByText: "08:15",
    arriveByText: "09:00",
    fareText: "",
    etaMinutes: null,
    headwaySeconds: null,
    steps: [
      {
        travelMode: "WALK",
        instruction: "הליכה לתחנה",
        line: "",
        headsign: "",
        fromStop: "",
        toStop: "תחנה",
        departureTime: "",
        departureIso: "",
        arrivalTime: "",
        durationText: "5 דקות",
        durationSeconds: 300,
        headwaySeconds: null,
      },
      {
        travelMode: "TRANSIT",
        instruction: "",
        line: "51",
        headsign: "תל אביב",
        fromStop: "ארנס",
        toStop: "דיזנגוף",
        departureTime: "08:20",
        departureIso: "2026-10-22T05:20:00Z",
        arrivalTime: "08:55",
        durationText: "35 דקות",
        durationSeconds: 2100,
        headwaySeconds: 720,
      },
    ],
    navigateAddress: "דיזנגוף סנטר",
    lineMatchFailed: false,
    matchedFromStop: "",
    matchedLine: "",
    stopLines: [],
    stopDisplayName: "",
    itineraries: [],
    prefer: "",
    closestBoardInsufficient: false,
  };

  const sampleStep = (
    overrides: Partial<RoutesFacts["steps"][number]> = {},
  ): RoutesFacts["steps"][number] => ({
    travelMode: "TRANSIT",
    instruction: "",
    line: "51",
    headsign: "תל אביב",
    fromStop: "ארנס",
    toStop: "דיזנגוף",
    departureTime: "08:20",
    departureIso: "2026-10-22T05:20:00Z",
    arrivalTime: "08:55",
    durationText: "35 דקות",
    durationSeconds: 2100,
    headwaySeconds: 720,
    ...overrides,
  });

  const sampleItinerary = (
    overrides: Partial<RouteItineraryOption> = {},
  ): RouteItineraryOption => ({
    durationText: "45 דקות",
    durationSeconds: 2700,
    distanceMeters: 12000,
    fareText: "",
    leaveByText: "08:15",
    arriveByText: "09:00",
    steps: [sampleStep()],
    ...overrides,
  });

  it("formats stop-board lines", () => {
    const text = formatRoutesHebrew({
      ...base,
      destination: "",
      aspects: ["lines"],
      stopDisplayName: "שלום דורני/העצמאות",
      stopLines: ["1", "66", "82"],
    });
    expect(text).toContain("שלום דורני");
    expect(text).toMatch(/קו 1/);
    expect(text).toMatch(/קו 66/);
    expect(text).not.toMatch(/מאיפה ולאן/);
  });

  it("refuses empty stop board", () => {
    const text = formatRoutesHebrew({
      ...base,
      destination: "",
      aspects: ["lines"],
      stopLines: [],
    });
    expect(text).toMatch(/לא מצאתי רשימת קווים/);
  });

  it("formats a trip summary with steps", () => {
    const text = formatRoutesHebrew(base);
    expect(text).toContain("מסלול בתחבורה ציבורית");
    expect(text).toContain("45 דקות");
    expect(text).toContain("קו 51");
    expect(text).not.toContain(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
  });

  it("discloses local step truncation when steps exceed summary display cap", () => {
    const manySteps = Array.from(
      { length: ROUTES_STEPS_SUMMARY_DISPLAY_CAP + 3 },
      (_, i) => ({
        travelMode: i % 2 === 0 ? "WALK" : "TRANSIT",
        instruction: i % 2 === 0 ? `הליכה ${i}` : "",
        line: i % 2 === 0 ? "" : String(50 + i),
        headsign: "",
        fromStop: `תחנה ${i}`,
        toStop: `תחנה ${i + 1}`,
        departureTime: "",
        departureIso: "",
        arrivalTime: "",
        durationText: "2 דק׳",
        headwaySeconds: null as number | null,
      }),
    );
    const text = formatRoutesHebrew({
      ...base,
      aspects: ["summary"],
      steps: manySteps,
    });
    expect(text).toContain("1. הליכה");
    expect(text).toContain(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
    // Cap hides later steps from the numbered list body before the note.
    expect(text).not.toMatch(
      new RegExp(`${ROUTES_STEPS_SUMMARY_DISPLAY_CAP + 1}\\. `),
    );
  });

  it("omits step truncation note when steps fit under the display cap", () => {
    const text = formatRoutesHebrew({
      ...base,
      aspects: ["summary"],
      steps: base.steps.slice(0, 2),
    });
    expect(text).toContain("קו 51");
    expect(text).not.toContain(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
  });

  it("reuses stop-board overflow wording when lines exceed 24", () => {
    const stopLines = Array.from({ length: 26 }, (_, i) => String(i + 1));
    const text = formatRoutesHebrew({
      ...base,
      destination: "",
      aspects: ["lines"],
      stopDisplayName: "תחנה",
      stopLines,
    });
    expect(text).toContain("ועוד 2");
    expect(text).not.toContain(ROUTES_STEPS_LOCAL_TRUNCATION_HE);
  });

  it("formats eta-only reply", () => {
    const text = formatRoutesHebrew({
      ...base,
      line: "51",
      aspects: ["eta"],
      etaMinutes: 12,
      matchedLine: "51",
      matchedFromStop: "ארנס",
    });
    expect(text).toMatch(/קו 51/);
    expect(text).toMatch(/בעוד כ־12 דקות/);
    expect(text).toContain("ארנס");
  });

  it("refuses eta when line match failed", () => {
    const text = formatRoutesHebrew({
      ...base,
      line: "66",
      aspects: ["eta"],
      etaMinutes: null,
      leaveByText: "",
      lineMatchFailed: true,
    });
    expect(text).toMatch(/לא מצאתי קו 66/);
    expect(text).not.toMatch(/קו 66 יוצא/);
    expect(text).not.toMatch(/4:50|08:15|בעוד/);
  });

  it("formats frequency from headway", () => {
    const text = formatRoutesHebrew({
      ...base,
      line: "51",
      aspects: ["frequency"],
      headwaySeconds: 600,
      matchedLine: "51",
    });
    expect(text).toMatch(/כל כ־10 דקות/);
  });

  it("formats leave-by when arrival is set", () => {
    const text = formatRoutesHebrew({
      ...base,
      arrival: "2026-10-22T10:00",
      leaveByText: "09:10",
      aspects: ["summary"],
    });
    expect(text).toMatch(/צא בסביבות/);
    expect(text).toContain("09:10");
  });

  it("keeps single-route wording when only one itinerary", () => {
    const text = formatRoutesHebrew({
      ...base,
      itineraries: [sampleItinerary()],
    });
    expect(text).toContain("מסלול בתחבורה ציבורית");
    expect(text).not.toContain("אפשרויות");
    expect(text).not.toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(text).toContain("קו 51");
  });

  const walkThenBoard = (
    walkSec: number,
    line: string,
    fromStop: string,
    leaveBy: string,
  ): RouteItineraryOption => ({
    durationText: "40 דקות",
    durationSeconds: 2400,
    distanceMeters: 9000,
    fareText: "",
    leaveByText: leaveBy,
    arriveByText: "09:30",
    steps: [
      {
        travelMode: "WALK",
        instruction: walkSec > 0 ? "הליכה לתחנה" : "",
        line: "",
        headsign: "",
        fromStop: "",
        toStop: fromStop,
        departureTime: "",
        departureIso: "",
        arrivalTime: "",
        durationText: walkSec > 0 ? `${Math.round(walkSec / 60)} דקות` : "0 דקות",
        durationSeconds: walkSec,
        headwaySeconds: null,
      },
      {
        travelMode: "TRANSIT",
        instruction: "",
        line,
        headsign: "תל אביב",
        fromStop,
        toStop: "עזריאלי",
        departureTime: leaveBy,
        departureIso: "",
        arrivalTime: "09:20",
        durationText: "30 דקות",
        durationSeconds: 1800,
        headwaySeconds: null,
      },
    ],
  });

  it("leads with closest_board answer among options", () => {
    const earlierFar = walkThenBoard(900, "50", "תחנה רחוקה", "08:00");
    const laterNear = walkThenBoard(180, "238", "תחנה קרובה", "08:40");
    const ranked = rankTripItinerariesByClosestBoard([earlierFar, laterNear]);
    const text = formatRoutesHebrew({
      ...base,
      prefer: "closest_board",
      closestBoardInsufficient: false,
      itineraries: ranked,
      steps: ranked[0]!.steps,
      leaveByText: ranked[0]!.leaveByText,
      durationText: ranked[0]!.durationText,
    });
    expect(text).toMatch(/קו 238/);
    expect(text).toMatch(/תחנה קרובה/);
    expect(text).toMatch(/הליכה כ־3 דקות/);
    expect(text).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(text.indexOf("238")).toBeLessThan(text.indexOf("אפשרויות"));
  });

  it("discloses when closest_board has no comparable boarding walk", () => {
    const noBoard: RouteItineraryOption = {
      durationText: "20 דקות",
      durationSeconds: 1200,
      distanceMeters: 1000,
      fareText: "",
      leaveByText: "08:00",
      arriveByText: "08:20",
      steps: [
        {
          travelMode: "WALK",
          instruction: "",
          line: "",
          headsign: "",
          fromStop: "",
          toStop: "",
          departureTime: "",
          departureIso: "",
          arrivalTime: "",
          durationText: "",
          durationSeconds: null,
          headwaySeconds: null,
        },
      ],
    };
    expect(itineraryClosestBoardComparable(noBoard)).toBe(false);
    const text = formatRoutesHebrew({
      ...base,
      prefer: "closest_board",
      closestBoardInsufficient: true,
      itineraries: rankTripItineraries([
        noBoard,
        walkThenBoard(300, "1", "ס", "08:10"),
      ]),
      steps: noBoard.steps,
    });
    expect(text).toContain(ROUTES_CLOSEST_BOARD_INSUFFICIENT_HE);
    expect(text).not.toMatch(/הקו עם תחנת העלייה הקרובה ביותר/);
  });

  it("omits empty zero-minute walk steps from display", () => {
    const text = formatRoutesHebrew({
      ...base,
      steps: [
        {
          travelMode: "WALK",
          instruction: "",
          line: "",
          headsign: "",
          fromStop: "",
          toStop: "",
          departureTime: "",
          departureIso: "",
          arrivalTime: "",
          durationText: "0 דקות",
          durationSeconds: 0,
          headwaySeconds: null,
        },
        sampleStep({ line: "1", fromStop: "בית", toStop: "עזריאלי" }),
      ],
    });
    expect(text).not.toMatch(/הליכה — הליכה \(0 דקות\)/);
    expect(text).toContain(ROUTES_WALK_PARTIAL_NOTE_HE);
    expect(text).toMatch(/קו 1/);
  });

  it("formats multiple Google itineraries with compact lead (no secondary steps)", () => {
    const text = formatRoutesHebrew({
      ...base,
      itineraries: [
        sampleItinerary({
          durationText: "45 דקות",
          leaveByText: "08:15",
          arriveByText: "09:00",
          steps: [
            sampleStep({
              travelMode: "WALK",
              line: "",
              instruction: "הליכה לתחנה",
              durationSeconds: 300,
              durationText: "5 דקות",
              departureTime: "",
              arrivalTime: "",
              fromStop: "",
              toStop: "ארנס",
            }),
            sampleStep({ line: "51" }),
          ],
        }),
        sampleItinerary({
          durationText: "52 דקות",
          leaveByText: "08:05",
          arriveByText: "08:57",
          fareText: "₪6",
          steps: [
            sampleStep({ line: "66", fromStop: "שלום דורני" }),
            sampleStep({ line: "1", fromStop: "השלום", toStop: "דיזנגוף" }),
          ],
        }),
      ],
    });
    expect(text).toContain("מצאתי 2 אפשרויות");
    expect(text).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(text).toContain("המלצה:");
    expect(text).toContain("משך משוער *45 דקות*");
    expect(text).toContain("קו 51");
    expect(text).toContain("הליכה משוערת 5 דקות");
    expect(text).toContain("בלי החלפה");
    expectMultiAltsCue(text, 1);
    expect(text).toMatch(/עוד 1 אפשרויות \([^)]*יציאה/);
    // Secondary option not expanded (no full option-2 body / its lines).
    expect(text).not.toContain("*אפשרות 2*");
    expect(text).not.toContain("משך משוער *52 דקות*");
    expect(text).not.toContain("קו 66");
    // summary multi: no step-by-step dump for primary walk instruction line.
    expect(text).not.toMatch(/1\. הליכה — הליכה לתחנה/);
    expect(text).not.toContain("מסלול בתחבורה ציבורית מ«");
    expect(text).toContain("מגוגל");
    expect(text).not.toContain("SIRI");
  });

  it("multi with steps aspect shows primary steps only", () => {
    const text = formatRoutesHebrew({
      ...base,
      aspects: ["summary", "steps"],
      itineraries: [
        sampleItinerary({
          durationText: "45 דקות",
          leaveByText: "08:15",
          steps: [
            sampleStep({
              travelMode: "WALK",
              line: "",
              instruction: "הליכה לתחנה",
              durationSeconds: 300,
              durationText: "5 דקות",
              departureTime: "",
              arrivalTime: "",
              fromStop: "",
              toStop: "ארנס",
            }),
            sampleStep({ line: "51" }),
          ],
        }),
        sampleItinerary({
          durationText: "52 דקות",
          leaveByText: "08:05",
          steps: [
            sampleStep({
              travelMode: "WALK",
              line: "",
              instruction: "הליכה משנית",
              durationSeconds: 600,
              durationText: "10 דקות",
              fromStop: "",
              toStop: "אחר",
            }),
            sampleStep({ line: "66", fromStop: "שלום דורני" }),
          ],
        }),
      ],
    });
    expect(text).toMatch(/1\. הליכה — הליכה לתחנה/);
    expect(text).toContain("קו 51");
    expect(text).not.toContain("הליכה משנית");
    expect(text).not.toContain("קו 66");
  });

  it("single itinerary summary still shows basic directions", () => {
    const text = formatRoutesHebrew(base);
    expect(text).toContain("מסלול בתחבורה ציבורית");
    expect(text).toContain("קו 51");
    expect(text).toMatch(/הליכה/);
    expect(text).not.toContain("עוד 1 אפשרויות");
    expect(text).not.toContain("בחיפוש חדש מתקבלות אפשרויות מעודכנות");
  });

  it("itineraryWalkTransferBits only uses provider step fields", () => {
    expect(
      itineraryWalkTransferBits([
        sampleStep({
          travelMode: "WALK",
          line: "",
          durationSeconds: 420,
          durationText: "7 דקות",
        }),
        sampleStep({ line: "51" }),
      ]),
    ).toEqual(["הליכה משוערת 7 דקות", "בלי החלפה"]);
    expect(
      itineraryWalkTransferBits([
        sampleStep({ line: "51" }),
        sampleStep({ line: "66" }),
      ]),
    ).toEqual(["1 החלפות"]);
    // No invented wait when Google omitted it.
    expect(
      itineraryWalkTransferBits([sampleStep({ line: "1" })]).join(" "),
    ).not.toMatch(/המתנה|wait/i);
  });

  it("omits missing optional fields on multi itineraries", () => {
    const text = formatRoutesHebrew({
      ...base,
      aspects: ["summary"],
      itineraries: [
        sampleItinerary({
          durationText: "40 דקות",
          leaveByText: "",
          arriveByText: "",
          fareText: "",
          steps: [
            sampleStep({
              line: "1",
              departureTime: "",
              arrivalTime: "",
              fromStop: "",
              toStop: "",
              headsign: "",
            }),
          ],
        }),
        sampleItinerary({
          durationText: "",
          leaveByText: "",
          arriveByText: "",
          fareText: "",
          steps: [sampleStep({ line: "82", departureTime: "", arrivalTime: "" })],
        }),
      ],
    });
    expect(text).toContain("מצאתי 2 אפשרויות");
    expect(text).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(text).toContain("המלצה:");
    expect(text).toContain("משך משוער *40 דקות*");
    expect(text).not.toMatch(/יציאה משוערת/);
    expect(text).not.toMatch(/עלייה משוערת/);
    expect(text).not.toMatch(/הגעה משוערת/);
    expect(text).not.toMatch(/מחיר משוער/);
    expect(text).not.toMatch(/→/);
    expect(text).toContain("קו 1");
    // Secondary line not expanded in compact first response.
    expect(text).not.toContain("קו 82");
    expectMultiAltsCue(text, 1);
  });

  it("exports disruption-unavailable disclose for capability U", () => {
    expect(ROUTES_DISRUPTION_UNAVAILABLE_HE).toMatch(/שיבוש|ביטול/);
    expect(ROUTES_DISRUPTION_UNAVAILABLE_HE).toMatch(/לא מחובר/);
    expect(ROUTES_DISRUPTION_UNAVAILABLE_HE).not.toMatch(/תחזית חיה/);
  });

  it("labels boarding leave and keeps consistent door-to-door duration", () => {
    const text = formatRoutesHebrew({
      ...base,
      itineraries: [
        sampleItinerary({
          durationText: "40 דקות",
          durationSeconds: 2400,
          leaveByText: "08:20",
          arriveByText: "08:55",
          leaveIsBoarding: true,
          steps: [
            sampleStep({
              travelMode: "WALK",
              line: "",
              durationSeconds: 300,
              durationText: "5 דקות",
              departureTime: "",
              arrivalTime: "",
              fromStop: "",
              toStop: "ארנס",
            }),
            sampleStep({
              line: "1",
              departureTime: "08:20",
              departureIso: "2026-10-22T05:20:00Z",
              arrivalTime: "08:55",
            }),
          ],
        }),
        sampleItinerary({
          durationText: "48 דקות",
          durationSeconds: 2880,
          leaveByText: "08:05",
          arriveByText: "08:50",
          leaveIsBoarding: true,
          steps: [sampleStep({ line: "66", departureTime: "08:05" })],
        }),
      ],
    });
    expect(text).toContain("משך משוער *40 דקות*");
    expect(text).toContain("עלייה משוערת 08:20");
    expect(text).toContain("הגעה משוערת 08:55");
    expect(text).toContain("קו 1");
    expect(text).toContain("הליכה משוערת 5 דקות");
    expect(text).not.toContain("קו 66");
    expect(text).not.toMatch(/mins/i);
    expectMultiAltsCue(text, 1);
  });

  it("omits unreliable midnight clocks without ISO when they conflict with duration", () => {
    const opt = sampleItinerary({
      durationText: "40 דקות",
      durationSeconds: 2400,
      leaveByText: "0:00",
      arriveByText: "0:25",
      leaveIsBoarding: true,
      steps: [
        sampleStep({
          line: "1",
          departureTime: "0:00",
          departureIso: "",
          arrivalTime: "0:25",
        }),
      ],
    });
    const clocks = displayLeaveArriveForLead(opt);
    expect(clocks.leaveByText).toBe("");
    expect(clocks.arriveByText).toBe("");
    const text = formatRoutesHebrew({
      ...base,
      itineraries: [opt, sampleItinerary({ leaveByText: "08:00", arriveByText: "08:40" })],
    });
    expect(text).toContain("משך משוער *40 דקות*");
    expect(text).toContain("קו 1");
    expect(text).not.toMatch(/יציאה משוערת/);
    expect(text).not.toMatch(/עלייה משוערת/);
    expect(text).not.toMatch(/הגעה משוערת 0:25/);
  });

  it("cue stays neutral when alternatives are clones", () => {
    const twin = sampleItinerary({
      durationText: "40 דקות",
      durationSeconds: 2400,
      leaveByText: "08:20",
      arriveByText: "09:00",
      steps: [sampleStep({ line: "1", departureTime: "08:20" })],
    });
    const cue = routesMultiAltsCueHe(1, [twin, { ...twin }]);
    expect(cue).toBe(
      "עוד 1 אפשרויות — לפרטים בקשי לפי קו או שעת יציאה. בחיפוש חדש מתקבלות אפשרויות מעודכנות.",
    );
    expect(cue).not.toContain("יציאה/");
    expect(cue).not.toContain("לא אזהה אוטומטית");
  });
});

describe("durationTextPreferHe / displayLeaveArriveForLead", () => {
  it("prefers Hebrew from seconds over English localized mins", () => {
    expect(durationTextPreferHe(2400, "40 mins")).toBe("40 דקות");
    expect(durationTextPreferHe(null, "40 mins")).toBe("40 דקות");
    expect(durationTextPreferHe(null, "45 דקות")).toBe("45 דקות");
    expect(durationTextPreferHe(null, "about an hour")).toBe("");
  });

  it("maps Google English duration text to Hebrew in multi lead", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "2400s",
            localizedValues: { duration: { text: "40 mins" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "WALK",
                    staticDuration: "300s",
                    navigationInstruction: { instructions: "הליכה" },
                  },
                  {
                    travelMode: "TRANSIT",
                    staticDuration: "2100s",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "בית" },
                        arrivalStop: { name: "בורסה" },
                        departureTime: "2026-10-22T05:20:00Z",
                        arrivalTime: "2026-10-22T05:55:00Z",
                      },
                      transitLine: { nameShort: "1" },
                      localizedValues: {
                        departureTime: { time: { text: "0:00" } },
                        arrivalTime: { time: { text: "0:25" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            duration: "2700s",
            localizedValues: { duration: { text: "45 mins" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "אחר" },
                        arrivalStop: { name: "בורסה" },
                        departureTime: "2026-10-22T05:30:00Z",
                        arrivalTime: "2026-10-22T06:00:00Z",
                      },
                      transitLine: { nameShort: "50" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "מיקום הבית",
      destination: "בורסה",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/משך משוער \*40 דקות\*/);
    expect(text).not.toMatch(/mins/i);
    // ISO wins over localized 0:00 / 0:25.
    expect(text).toContain("עלייה משוערת");
    expect(text).not.toMatch(/עלייה משוערת 0:00/);
    expect(text).not.toMatch(/הגעה משוערת 0:25/);
    expectMultiAltsCue(text, 1);
  });

  it("keeps boarding clocks when walk explains duration gap", () => {
    const clocks = displayLeaveArriveForLead({
      durationText: "40 דקות",
      durationSeconds: 2400,
      distanceMeters: null,
      fareText: "",
      leaveByText: "08:20",
      arriveByText: "08:55",
      leaveIsBoarding: true,
      steps: [
        {
          travelMode: "WALK",
          instruction: "",
          line: "",
          headsign: "",
          fromStop: "",
          toStop: "ארנס",
          departureTime: "",
          departureIso: "",
          arrivalTime: "",
          durationText: "5 דקות",
          durationSeconds: 300,
          headwaySeconds: null,
        },
        {
          travelMode: "TRANSIT",
          instruction: "",
          line: "1",
          headsign: "",
          fromStop: "ארנס",
          toStop: "בורסה",
          departureTime: "08:20",
          departureIso: "2026-10-22T05:20:00Z",
          arrivalTime: "08:55",
          durationText: "35 דקות",
          durationSeconds: 2100,
          headwaySeconds: null,
        },
      ],
    });
    expect(clocks.leaveByText).toBe("08:20");
    expect(clocks.arriveByText).toBe("08:55");
    expect(clocks.leaveIsBoarding).toBe(true);
  });
});

describe("same-turn itinerary id filter (not WhatsApp buttons)", () => {
  it("maps itin indexes and filters to the selected option", () => {
    const facts: RoutesFacts = {
      origin: "א",
      destination: "ב",
      departure: "",
      arrival: "",
      line: "",
      headsign: "",
      mode: "transit",
      aspects: ["summary"],
      durationText: "40 דקות",
      durationSeconds: 2400,
      distanceMeters: null,
      leaveByText: "08:20",
      arriveByText: "09:00",
      fareText: "",
      etaMinutes: null,
      headwaySeconds: null,
      steps: [],
      navigateAddress: "",
      lineMatchFailed: false,
      matchedFromStop: "",
      matchedLine: "",
      stopLines: [],
      stopDisplayName: "",
      prefer: "",
      closestBoardInsufficient: false,
      itineraries: [
        {
          durationText: "40 דקות",
          durationSeconds: 2400,
          distanceMeters: null,
          fareText: "",
          leaveByText: "08:20",
          arriveByText: "09:00",
          leaveIsBoarding: true,
          steps: [
            {
              travelMode: "TRANSIT",
              instruction: "",
              line: "1",
              headsign: "",
              fromStop: "א",
              toStop: "ב",
              departureTime: "08:20",
              departureIso: "",
              arrivalTime: "09:00",
              durationText: "40 דקות",
              durationSeconds: 2400,
              headwaySeconds: null,
            },
          ],
        },
        {
          durationText: "50 דקות",
          durationSeconds: 3000,
          distanceMeters: null,
          fareText: "",
          leaveByText: "08:05",
          arriveByText: "08:55",
          leaveIsBoarding: true,
          steps: [
            {
              travelMode: "TRANSIT",
              instruction: "",
              line: "66",
              headsign: "",
              fromStop: "א",
              toStop: "ב",
              departureTime: "08:05",
              departureIso: "",
              arrivalTime: "08:55",
              durationText: "50 דקות",
              durationSeconds: 3000,
              headwaySeconds: null,
            },
          ],
        },
      ],
    };
    const records = routesItinerariesToLiveRetrievalRecords(facts);
    expect(records.map((r) => r.id)).toEqual(["itin:0", "itin:1"]);
    const onlySecond = filterRoutesFactsByItineraryIds(facts, ["itin:1"]);
    expect(onlySecond.itineraries).toHaveLength(1);
    expect(onlySecond.durationText).toBe("50 דקות");
    expect(transitLinesFromFacts(onlySecond)).toContain("66");
    const missing = filterRoutesFactsByItineraryIds(facts, ["itin:9"]);
    expect(missing.itineraries).toHaveLength(0);
    expect(missing.durationText).toBe("");
  });
});

function transitLinesFromFacts(facts: RoutesFacts): string {
  return facts.itineraries
    .flatMap((i) => i.steps.map((s) => s.line))
    .filter(Boolean)
    .join(",");
}

describe("resolveRoutesReply", () => {
  it("asks when destination missing", async () => {
    const { text } = await resolveRoutesReply({
      origin: "תל אביב",
      destination: "",
    });
    expect(text).toMatch(/מאיפה ולאן/);
  });

  it("asks for pin when origin is speaker without coords", async () => {
    const { text } = await resolveRoutesReply({
      origin: "speaker",
      destination: "דיזנגוף",
    });
    expect(text).toMatch(/שלח מיקום/);
  });

  it("explains missing API key", async () => {
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      apiKey: "",
    });
    expect(text).toContain("לא מוגדר");
  });

  function jerusalemHmFromNow(minutesFromNow: number): string {
    const d = new Date(Date.now() + minutesFromNow * 60_000);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  }

  function mockRoutesPayload(opts: {
    line: string;
    fromStop: string;
    departureText?: string;
    departureInMinutes?: number;
    altLine?: string;
    altFromStop?: string;
  }) {
    const mins = opts.departureInMinutes ?? 15;
    const depIso = new Date(Date.now() + mins * 60_000).toISOString();
    // Keep localized text aligned with ISO (engine prefers ISO → Jerusalem HH:mm).
    const depHm = opts.departureText ?? jerusalemHmFromNow(mins);
    const primary = {
      duration: "1800s",
      localizedValues: { duration: { text: "30 דקות" } },
      legs: [
        {
          steps: [
            {
              travelMode: "TRANSIT",
              transitDetails: {
                headsign: "תל אביב",
                headway: "600s",
                stopDetails: {
                  departureStop: { name: opts.fromStop },
                  arrivalStop: { name: "השלום" },
                  departureTime: depIso,
                },
                transitLine: { nameShort: opts.line },
                localizedValues: {
                  departureTime: {
                    time: { text: depHm },
                  },
                },
              },
            },
          ],
        },
      ],
    };
    const routes = [primary];
    if (opts.altLine) {
      routes.push({
        ...primary,
        legs: [
          {
            steps: [
              {
                travelMode: "TRANSIT",
                transitDetails: {
                  headsign: "תל אביב",
                  headway: "600s",
                  stopDetails: {
                    departureStop: {
                      name: opts.altFromStop ?? opts.fromStop,
                    },
                    arrivalStop: { name: "השלום" },
                    departureTime: depIso,
                  },
                  transitLine: { nameShort: opts.altLine },
                  localizedValues: {
                    departureTime: {
                      time: { text: depHm },
                    },
                  },
                },
              },
            ],
          },
        ],
      });
    }
    return { routes };
  }

  it("formats mocked Routes response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({ line: "51", fromStop: "ארנס" }),
    }));
    const { text, navigateAddress } = await resolveRoutesReply({
      origin: "ארנס פתח תקווה",
      destination: "תל אביב",
      line: "51",
      aspects: ["eta"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/קו 51/);
    expect(text).toMatch(/בעוד כ־/);
    expect(navigateAddress).toBe("תל אביב");
    expect(fetchImpl).toHaveBeenCalled();
    const body = computeRoutesBody(fetchImpl);
    expect(body.computeAlternativeRoutes).toBe(true);
    expect(body.transitPreferences).toEqual({
      allowedTravelModes: ["BUS"],
    });
  });

  it("refuses when asked line is absent from Google route", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({
          line: "1",
          fromStop: "שלום דורני",
          departureText: "04:50",
          departureInMinutes: 40,
        }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "שלום דורני פתח תקווה",
      destination: "דיזנגוף סנטר",
      line: "66",
      aspects: ["eta"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/לא מצאתי קו 66/);
    expect(text).not.toMatch(/קו 66 יוצא/);
    expect(text).not.toContain("04:50");
    expect(text).not.toMatch(/בעוד כ־/);
  });

  it("succeeds when matching line boards at asked stop", async () => {
    const expectHm = jerusalemHmFromNow(18);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({
          line: "66",
          fromStop: "שלום דורני/העצמאות",
          departureText: expectHm,
          departureInMinutes: 18,
        }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "שלום דורני פתח תקווה",
      destination: "דיזנגוף סנטר",
      line: "66",
      aspects: ["eta"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/קו 66/);
    expect(text).toMatch(/בעוד כ־18 דקות/);
    // Clock comes from ISO → Asia/Jerusalem (aligned with fixture minutes).
    expect(text).toMatch(/ב־\d{2}:\d{2}/);
    expect(text).toContain("שלום דורני");
  });

  it("refuses matching line that boards at unrelated stop", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({
          line: "66",
          fromStop: "קניון עזריאלי תל אביב",
          departureText: "04:50",
          departureInMinutes: 25,
        }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "שלום דורני פתח תקווה",
      destination: "דיזנגוף סנטר",
      line: "66",
      aspects: ["eta"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/לא מצאתי קו 66/);
    expect(text).not.toContain("04:50");
  });

  it("finds matching line on an alternative route", async () => {
    const expectHm = jerusalemHmFromNow(22);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({
          line: "1",
          fromStop: "שלום דורני",
          altLine: "66",
          altFromStop: "שלום דורני/העצמאות",
          departureText: expectHm,
          departureInMinutes: 22,
        }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "שלום דורני פתח תקווה",
      destination: "דיזנגוף סנטר",
      line: "66",
      aspects: ["eta"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/קו 66/);
    expect(text).toMatch(/בעוד כ־22 דקות/);
    expect(text).toMatch(/ב־\d{2}:\d{2}/);
  });

  it("lists lines from Places transitStation stop board", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            displayName: { text: "שלום דורני" },
            transitStation: {
              displayName: { text: "שלום דורני/העצמאות" },
              agencies: [
                {
                  displayName: { text: "מטרופולין" },
                  lines: [
                    {
                      vehicleType: "BUS",
                      shortDisplayName: { text: "66" },
                      displayName: { text: "קו 66" },
                    },
                    {
                      vehicleType: "BUS",
                      shortDisplayName: { text: "1" },
                      displayName: { text: "קו 1" },
                    },
                    {
                      vehicleType: "BUS",
                      shortDisplayName: { text: "82" },
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "שלום דורני פתח תקווה",
      destination: "",
      aspects: ["lines"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("שלום דורני");
    expect(text).toMatch(/קו 66/);
    expect(text).toMatch(/קו 1/);
    expect(text).toMatch(/קו 82/);
    expect(fetchImpl).toHaveBeenCalled();
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0] ?? "");
    expect(url).toContain("places:searchText");
  });

  it("refuses stop board when Places has no transitStation lines", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        places: [{ displayName: { text: "קפה בשכונה" } }],
      }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "שלום דורני פתח תקווה",
      destination: "",
      aspects: ["lines"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/לא מצאתי רשימת קווים/);
  });

  it("maps multiple Google routes into multi-option trip summary", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "2700s",
            distanceMeters: 12000,
            localizedValues: { duration: { text: "45 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      headsign: "תל אביב",
                      stopDetails: {
                        departureStop: { name: "ארנס" },
                        arrivalStop: { name: "דיזנגוף" },
                        departureTime: "2026-10-22T05:20:00Z",
                      },
                      transitLine: { nameShort: "51" },
                      localizedValues: {
                        departureTime: { time: { text: "08:20" } },
                        arrivalTime: { time: { text: "08:55" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            duration: "3120s",
            distanceMeters: 14000,
            localizedValues: { duration: { text: "52 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      headsign: "תל אביב",
                      stopDetails: {
                        departureStop: { name: "שלום דורני" },
                        arrivalStop: { name: "השלום" },
                        departureTime: "2026-10-22T05:10:00Z",
                      },
                      transitLine: { nameShort: "66" },
                      localizedValues: {
                        departureTime: { time: { text: "08:10" } },
                        arrivalTime: { time: { text: "08:55" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const result = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { text } = result;
    expect(text).toContain("מצאתי 2 אפשרויות");
    expect(text).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(text).toContain("המלצה:");
    // Compact multi: primary only (earlier leave 66 @ 08:10); secondary deferred.
    expect(text).toContain("קו 66");
    expect(text).not.toContain("קו 51");
    expect(text).toContain("עלייה משוערת");
    expectMultiAltsCue(text, 1);
    // No itinerary-selection WhatsApp buttons on multi replies.
    expect(result).not.toHaveProperty("buttons");
    expect(Object.keys(result).sort()).toEqual(
      ["navigateAddress", "text"].sort(),
    );
    const body = computeRoutesBody(fetchImpl);
    expect(body.computeAlternativeRoutes).toBe(true);
    expect(body.transitPreferences).toBeUndefined();
  });

  it("keeps single-route summary when Google returns one alternative", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({ line: "51", fromStop: "ארנס" }),
    }));
    const facts = await fetchRoutesFacts({
      origin: "ארנס פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.itineraries).toHaveLength(1);
    expect(facts.itineraries[0]?.steps.some((s) => s.line === "51")).toBe(
      true,
    );
    const text = formatRoutesHebrew(facts);
    expect(text).toContain("מסלול בתחבורה ציבורית");
    expect(text).not.toContain("אפשרויות");
    const body = computeRoutesBody(fetchImpl);
    expect(body.computeAlternativeRoutes).toBe(true);
  });

  it("maps sparse Google fields without inventing leave/arrive/fare", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "1800s",
            localizedValues: { duration: { text: "30 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      transitLine: { nameShort: "1" },
                    },
                  },
                ],
              },
            ],
          },
          {
            duration: "2100s",
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      transitLine: { nameShort: "82" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const facts = await fetchRoutesFacts({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.itineraries).toHaveLength(2);
    expect(facts.itineraries.every((i) => i.leaveByText === "")).toBe(true);
    expect(facts.itineraries.every((i) => i.arriveByText === "")).toBe(true);
    expect(facts.itineraries.every((i) => i.fareText === "")).toBe(true);
    const text = formatRoutesHebrew(facts);
    expect(text).toContain("מצאתי 2 אפשרויות");
    expect(text).toContain("המלצה:");
    expect(text).not.toMatch(/יציאה משוערת/);
    expect(text).not.toMatch(/עלייה משוערת/);
    expect(text).not.toMatch(/הגעה משוערת/);
    expect(text).not.toMatch(/מחיר משוער/);
    expect(text).toContain("קו 1");
    // Secondary alternative line deferred in compact first response.
    expect(text).not.toContain("קו 82");
    expectMultiAltsCue(text, 1);
  });

  it("reports zero results when Google returns no routes", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ routes: [] }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "אילת",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/לא מצאתי מסלול בתחבורה ציבורית/);
    expect(text).toContain("פתח תקווה");
    expect(text).toContain("אילת");
    expect(text).not.toContain("אפשרויות");
  });

  it("surfaces provider HTTP errors without inventing itineraries", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { status: "UNAVAILABLE", message: "down" } }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).not.toContain("אפשרויות");
    expect(text).not.toMatch(/קו 51|קו 66/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("never presents a line absent from the Google routes payload", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "1800s",
            localizedValues: { duration: { text: "30 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: { transitLine: { nameShort: "51" } },
                  },
                ],
              },
            ],
          },
          {
            duration: "2100s",
            localizedValues: { duration: { text: "35 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: { transitLine: { nameShort: "66" } },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("המלצה:");
    expect(text).toContain("קו 51");
    // Compact: secondary line not expanded; still must not invent absent lines.
    expect(text).not.toContain("קו 66");
    expect(text).not.toContain("קו 999");
    expect(text).not.toContain("קו 1");
    expectMultiAltsCue(text, 1);
  });

  it(`caps displayed alternatives at ${ROUTES_ITINERARY_DISPLAY_CAP} from provider routes`, async () => {
    const mkRoute = (line: string) => ({
      duration: "1800s",
      localizedValues: { duration: { text: "30 דקות" } },
      legs: [
        {
          steps: [
            {
              travelMode: "TRANSIT",
              transitDetails: { transitLine: { nameShort: line } },
            },
          ],
        },
      ],
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          mkRoute("11"),
          mkRoute("22"),
          mkRoute("33"),
          mkRoute("44"),
          mkRoute("55"),
        ],
      }),
    }));
    const facts = await fetchRoutesFacts({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.itineraries).toHaveLength(ROUTES_ITINERARY_DISPLAY_CAP);
    const text = formatRoutesHebrew(facts);
    expect(text).toContain(`מצאתי ${ROUTES_ITINERARY_DISPLAY_CAP} אפשרויות`);
    expect(text).toContain("המלצה:");
    expect(text).toContain("קו 11");
    // Cap still applied to itineraries[]; compact body shows primary only.
    expect(text).not.toContain("קו 22");
    expect(text).not.toContain("קו 33");
    expect(text).not.toContain("קו 44");
    expect(text).not.toContain("קו 55");
    expectMultiAltsCue(text, ROUTES_ITINERARY_DISPLAY_CAP - 1);
  });

  it("line-ETA path does not surface multi-option trip compare", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "1800s",
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "ארנס" },
                        departureTime: "2026-10-22T05:20:00Z",
                      },
                      transitLine: { nameShort: "51" },
                      localizedValues: {
                        departureTime: { time: { text: "08:20" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            duration: "2100s",
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "ארנס" },
                        departureTime: "2026-10-22T05:30:00Z",
                      },
                      transitLine: { nameShort: "51" },
                      localizedValues: {
                        departureTime: { time: { text: "08:30" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const facts = await fetchRoutesFacts({
      origin: "ארנס פתח תקווה",
      destination: "תל אביב",
      line: "51",
      aspects: ["eta"],
      apiKey: "test-key",
      now: new Date("2026-10-22T05:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.itineraries).toEqual([]);
    const text = formatRoutesHebrew(facts);
    expect(text).not.toContain("אפשרויות");
    expect(text).toMatch(/יוצא|בעוד/);
  });

  it("area-origin frequency accepts line match when boarding stop tokens differ", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "2400s",
            legs: [
              {
                steps: [
                  {
                    travelMode: "WALK",
                    staticDuration: "300s",
                  },
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "פינסקר/גיסין" },
                        departureTime: "2026-10-25T05:15:00Z",
                      },
                      transitLine: { nameShort: "66" },
                      headway: "720s",
                      localizedValues: {
                        departureTime: { time: { text: "08:15" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const facts = await fetchRoutesFacts({
      origin: "אזור עיריית פתח תקווה",
      destination: "תל אביב-יפו",
      line: "66",
      aspects: ["frequency"],
      apiKey: "test-key",
      now: new Date("2026-10-25T05:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.lineMatchFailed).toBe(false);
    expect(facts.headwaySeconds).toBe(720);
    expect(facts.matchedFromStop).toBe("פינסקר/גיסין");
    const text = formatRoutesHebrew(facts);
    expect(text).toMatch(/תדירות/);
    expect(text).toContain("פינסקר/גיסין");
    expect(text).not.toMatch(/לא מצאתי קו 66/);
  });

  it("named-stop frequency still fails closed on walk-away boarding stop", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "2400s",
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "קניון עזריאלי" },
                      },
                      transitLine: { nameShort: "66" },
                      headway: "600s",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const facts = await fetchRoutesFacts({
      origin: "שלום דורני פתח תקווה",
      destination: "תל אביב",
      line: "66",
      aspects: ["frequency"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(facts.lineMatchFailed).toBe(true);
    expect(formatRoutesHebrew(facts)).toMatch(/לא מצאתי קו 66/);
  });

  it("Gate 1: Routes Stage B is wired for Google boards (not GTFS/SIRI)", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/services/routes.ts"),
      "utf8",
    );
    expect(src).toContain("runLivePostSelect");
    expect(src).toContain("requireLiveSelect");
    expect(src).toContain("routesItinerariesToLiveRetrievalRecords");
    expect(src).toContain("routesStopLinesToLiveRetrievalRecords");
    // MOT schedule / nearest / live_arrivals stay structured-filter only.
    expect(src).toMatch(
      /MOT schedule \/ nearest \/ SIRI: structured filters only — no Stage B/,
    );
  });
});

describe("nearest_stop named place geocode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("geocodeNamedPlaceForNearestStop uses Places location when available", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        places: [
          {
            displayName: { text: "דיזנגוף סנטר" },
            formattedAddress: "דיזנגוף, תל אביב",
            location: { latitude: 32.074, longitude: 34.781 },
          },
        ],
      }),
    }));
    const geo = await geocodeNamedPlaceForNearestStop({
      query: "דיזנגוף",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(geo.ok).toBe(true);
    if (!geo.ok) return;
    expect(geo.lat).toBeCloseTo(32.074);
    expect(geo.lng).toBeCloseTo(34.781);
    expect(geo.label).toMatch(/דיזנגוף/);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("geocodeNamedPlaceForNearestStop asks when Places hits are far apart", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        places: [
          {
            displayName: { text: "דיזנגוף תל אביב" },
            location: { latitude: 32.074, longitude: 34.781 },
          },
          {
            displayName: { text: "דיזנגוף חיפה" },
            location: { latitude: 32.8, longitude: 35.0 },
          },
        ],
      }),
    }));
    const geo = await geocodeNamedPlaceForNearestStop({
      query: "דיזנגוף",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(geo.ok).toBe(false);
    if (geo.ok) return;
    expect(geo.kind).toBe("ambiguous");
    expect(geo.options?.length).toBeGreaterThan(1);
  });

  it("nearest_stop with named origin geocodes then queries GTFS (no invented coords)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        places: [
          {
            displayName: { text: "בית ספר משה ארנס" },
            location: { latitude: 32.1, longitude: 34.88 },
          },
        ],
      }),
    }));
    const nearestSpy = vi.spyOn(gtfsQuery, "queryNearestStop").mockResolvedValue({
      ok: true,
      sourceHe: "לוח זמנים רשמי (משרד התחבורה) — מתוזמן, לא זמן אמת",
      stops: [
        {
          stopCode: "21224",
          stopName: "שלום דורני / ארנס",
          distanceMeters: 120,
          line: "31",
          directionLabel: "1",
          agencyName: "דן",
        },
      ],
    });

    const { text, navigateAddress } = await resolveRoutesReply({
      origin: "בית ספר משה ארנס",
      destination: "",
      line: "31",
      aspects: ["nearest_stop"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(nearestSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lat: 32.1,
        lng: 34.88,
        line: "31",
      }),
    );
    expect(text).toMatch(/שלום דורני/);
    expect(text).toMatch(/חיפוש ליד/);
    expect(navigateAddress).toMatch(/שלום דורני/);
  });

  it("nearest_stop speaker without pin still asks for WhatsApp location", async () => {
    const { text } = await resolveRoutesReply({
      origin: "speaker",
      destination: "",
      line: "51",
      aspects: ["nearest_stop"],
    });
    expect(text).toMatch(/שלח מיקום/);
  });

  it("nearest_stop with pin coords skips geocode", async () => {
    const fetchImpl = vi.fn();
    const nearestSpy = vi.spyOn(gtfsQuery, "queryNearestStop").mockResolvedValue({
      ok: true,
      sourceHe: "לוח זמנים רשמי",
      stops: [
        {
          stopCode: "1",
          stopName: "תחנה",
          distanceMeters: 50,
          line: "51",
          directionLabel: "",
          agencyName: "",
        },
      ],
    });
    await resolveRoutesReply({
      origin: "speaker",
      destination: "",
      line: "51",
      aspects: ["nearest_stop"],
      originLat: 32.09,
      originLng: 34.85,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: "test-key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(nearestSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lat: 32.09, lng: 34.85, line: "51" }),
    );
  });

  it("nearest_stop with saved filing origin uses coords and skips geocode", async () => {
    const fetchImpl = vi.fn();
    const nearestSpy = vi.spyOn(gtfsQuery, "queryNearestStop").mockResolvedValue({
      ok: true,
      sourceHe: "לוח זמנים רשמי",
      stops: [
        {
          stopCode: "21224",
          stopName: "שלום דורני / ארנס",
          distanceMeters: 90,
          line: "31",
          directionLabel: "1",
          agencyName: "דן",
        },
      ],
    });
    const { text } = await resolveRoutesReply({
      origin: "מיקום הבית",
      destination: "",
      line: "31",
      aspects: ["nearest_stop"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      snapshot: {
        filing: [
          {
            filing_id: "f-home",
            item_name: "מיקום הבית",
            item_info: "32.099279, 34.8923104",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
        lists: [],
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(nearestSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lat: 32.099279,
        lng: 34.8923104,
        line: "31",
      }),
    );
    expect(text).toMatch(/חיפוש ליד «מיקום הבית»/);
    expect(text).toMatch(/שלום דורני/);
  });
});

describe("origin→destination trip boarding workflow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drive mode calls Google Routes with travelMode DRIVE", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("places:searchText")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                displayName: { text: "פתח תקווה" },
                location: { latitude: 32.09, longitude: 34.88 },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              duration: "1200s",
              distanceMeters: 18000,
              localizedValues: { duration: { text: "20 דקות" } },
              legs: [
                {
                  steps: [
                    {
                      travelMode: "DRIVE",
                      staticDuration: "1200s",
                      navigationInstruction: { instructions: "צפון בנתיבי איילון" },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      };
    });
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      mode: "drive",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/ברכב/);
    expect(text).toContain(ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE);
    expect(text).not.toMatch(/מתוזמנות רשמיות|תחבורה ציבורית/);
    const body = computeRoutesBody(fetchImpl);
    expect(body.travelMode).toBe("DRIVE");
    expect(body.routingPreference).toBe("TRAFFIC_AWARE");
  });

  const walkThenBoard = (
    walkSec: number,
    line: string,
    fromStop: string,
    leaveBy: string,
  ): RouteItineraryOption => ({
    durationText: "40 דקות",
    durationSeconds: 2400,
    distanceMeters: 9000,
    fareText: "",
    leaveByText: leaveBy,
    arriveByText: "09:30",
    steps: [
      {
        travelMode: "WALK",
        instruction: walkSec > 0 ? "הליכה לתחנה" : "",
        line: "",
        headsign: "",
        fromStop: "",
        toStop: fromStop,
        departureTime: "",
        departureIso: "",
        arrivalTime: "",
        durationText: walkSec > 0 ? `${Math.round(walkSec / 60)} דקות` : "0 דקות",
        durationSeconds: walkSec,
        headwaySeconds: null,
      },
      {
        travelMode: "TRANSIT",
        instruction: "",
        line,
        headsign: "תל אביב",
        fromStop,
        toStop: "עזריאלי",
        departureTime: leaveBy,
        departureIso: "",
        arrivalTime: "09:20",
        durationText: "30 דקות",
        durationSeconds: 1800,
        headwaySeconds: null,
      },
    ],
  });

  it("rankTripItineraries prefers earlier leave then shorter walk", () => {
    const ranked = rankTripItineraries([
      {
        durationText: "50 דקות",
        durationSeconds: 3000,
        distanceMeters: 10000,
        fareText: "",
        leaveByText: "09:00",
        arriveByText: "09:50",
        steps: [
          {
            travelMode: "WALK",
            instruction: "",
            line: "",
            headsign: "",
            fromStop: "",
            toStop: "",
            departureTime: "",
            departureIso: "",
            arrivalTime: "",
            durationText: "10 דקות",
            durationSeconds: 600,
            headwaySeconds: null,
          },
        ],
      },
      {
        durationText: "45 דקות",
        durationSeconds: 2700,
        distanceMeters: 9000,
        fareText: "",
        leaveByText: "08:30",
        arriveByText: "09:15",
        steps: [
          {
            travelMode: "WALK",
            instruction: "",
            line: "",
            headsign: "",
            fromStop: "",
            toStop: "",
            departureTime: "",
            departureIso: "",
            arrivalTime: "",
            durationText: "5 דקות",
            durationSeconds: 300,
            headwaySeconds: null,
          },
        ],
      },
    ]);
    expect(ranked[0]?.leaveByText).toBe("08:30");
  });

  it("closest_board ranks by boarding walk, not earliest leave", () => {
    const earlierFar = walkThenBoard(900, "50", "תחנה רחוקה", "08:00");
    const laterNear = walkThenBoard(180, "238", "תחנה קרובה", "08:40");
    const defaultRank = rankTripItineraries([earlierFar, laterNear]);
    expect(defaultRank[0]?.leaveByText).toBe("08:00");
    expect(defaultRank[0]?.steps.find((s) => s.line)?.line).toBe("50");

    const closest = rankTripItinerariesByClosestBoard([earlierFar, laterNear]);
    expect(closest[0]?.steps.find((s) => s.line)?.line).toBe("238");
    expect(boardingWalkSecondsBeforeTransit(closest[0]!.steps)).toBe(180);
    expect(itineraryClosestBoardComparable(laterNear)).toBe(true);
  });

  it("asks when destination geocode is ambiguous (does not call Google)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            displayName: { text: "דיזנגוף תל אביב" },
            location: { latitude: 32.074, longitude: 34.781 },
          },
          {
            displayName: { text: "דיזנגוף חיפה" },
            location: { latitude: 32.82, longitude: 34.98 },
          },
        ],
      }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "speaker",
      destination: "דיזנגוף",
      aspects: ["summary"],
      originLat: 32.09,
      originLng: 34.85,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/כמה מקומות/);
    expect(text).toMatch(/דיזנגוף/);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0] ?? ""));
    expect(urls.some((u) => u.includes("computeRoutes"))).toBe(false);
  });

  it("passes geocoded origin/destination latLng to Google Routes", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("places:searchText")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                displayName: { text: "פתח תקווה" },
                location: { latitude: 32.09, longitude: 34.88 },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              duration: "1800s",
              localizedValues: { duration: { text: "30 דקות" } },
              legs: [
                {
                  steps: [
                    {
                      travelMode: "WALK",
                      staticDuration: "300s",
                      navigationInstruction: {
                        instructions: "הליכה לתחנה",
                      },
                    },
                    {
                      travelMode: "TRANSIT",
                      transitDetails: {
                        headsign: "תל אביב",
                        stopDetails: {
                          departureStop: { name: "ארנס" },
                          arrivalStop: { name: "השלום" },
                          departureTime: "2026-10-22T05:20:00Z",
                        },
                        transitLine: { nameShort: "51" },
                        localizedValues: {
                          departureTime: { time: { text: "08:20" } },
                          arrivalTime: { time: { text: "08:50" } },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      };
    });
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/מסלול|תחבורה|קו 51/);
    expect(text).toMatch(/הליכה|ארנס/);
    const body = computeRoutesBody(fetchImpl);
    expect(body.origin).toEqual({
      location: { latLng: { latitude: 32.09, longitude: 34.88 } },
    });
    expect(body.destination).toEqual({
      location: { latLng: { latitude: 32.09, longitude: 34.88 } },
    });
  });

  const boardFacts = (): RoutesFacts => ({
    origin: "המיקום שלך",
    destination: "תל אביב",
    departure: "",
    arrival: "",
    line: "",
    headsign: "",
    mode: "transit",
    aspects: ["summary"],
    durationText: "30 דקות",
    durationSeconds: 1800,
    distanceMeters: 8000,
    leaveByText: "08:20",
    arriveByText: "08:50",
    fareText: "",
    etaMinutes: null,
    headwaySeconds: null,
    steps: [
      {
        travelMode: "TRANSIT",
        instruction: "",
        line: "51",
        headsign: "תל אביב",
        fromStop: "ארנס",
        toStop: "השלום",
        departureTime: "08:20",
        departureIso: "2026-10-22T05:20:00Z",
        arrivalTime: "08:50",
        durationText: "30 דקות",
        durationSeconds: 1800,
        headwaySeconds: null,
      },
    ],
    itineraries: [],
    navigateAddress: "תל אביב",
    lineMatchFailed: false,
    matchedFromStop: "ארנס",
    matchedLine: "51",
    stopLines: [],
    stopDisplayName: "",
    prefer: "",
    closestBoardInsufficient: false,
  });

  it("appends labeled GTFS boarding departures after Google journey", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(true);
    vi.spyOn(gtfsQuery, "querySchedule").mockResolvedValue({
      ok: true,
      sourceHe: gtfsQuery.GTFS_OFFICIAL_SOURCE_HE,
      departures: [
        {
          stopCode: "21566",
          stopName: "ארנס",
          line: "51",
          agencyName: "דן",
          directionLabel: "",
          headsign: "תל אביב",
          departureTime: "08:25",
          depSeconds: 8 * 3600 + 25 * 60,
          serviceDate: "2026-10-22",
        },
      ],
    });
    const extra = await formatOfficialBoardingDeparturesHe(boardFacts());
    expect(extra).toMatch(/מתוזמנות רשמיות/);
    expect(extra).toMatch(/לא זמני Google/);
    expect(extra).toContain("08:25");
    expect(extra).toContain("קו 51");
    expect(extra).toContain(gtfsQuery.GTFS_OFFICIAL_SOURCE_HE);
    expect(extra).not.toMatch(/SIRI|תחזית חיה/);
  });

  it("resolve multi + MOT enrichment keeps schedule facts without אפשרות N labels", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(true);
    vi.spyOn(siriSm, "isSiriSmConfigured").mockReturnValue(false);
    vi.spyOn(gtfsQuery, "querySchedule").mockImplementation(
      async (_prisma, input: { stopCode?: string; line?: string }) => {
        const stop = String(input.stopCode ?? "");
        const line = String(input.line ?? "");
        const stopName =
          stop.includes("שלום") || stop.includes("דורני")
            ? "שלום דורני"
            : "ארנס";
        const dep = line === "66" ? "08:12" : "08:22";
        return {
          ok: true as const,
          sourceHe: gtfsQuery.GTFS_OFFICIAL_SOURCE_HE,
          departures: [
            {
              stopCode: line === "66" ? "21224" : "21566",
              stopName,
              line: line || "51",
              agencyName: "דן",
              directionLabel: "",
              headsign: "תל אביב",
              departureTime: dep,
              depSeconds:
                Number(dep.slice(0, 2)) * 3600 + Number(dep.slice(3)) * 60,
              serviceDate: "2026-10-22",
            },
          ],
        };
      },
    );

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "2700s",
            distanceMeters: 12000,
            localizedValues: { duration: { text: "45 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      headsign: "תל אביב",
                      stopDetails: {
                        departureStop: { name: "ארנס" },
                        arrivalStop: { name: "דיזנגוף" },
                        departureTime: "2026-10-22T05:20:00Z",
                      },
                      transitLine: { nameShort: "51" },
                      localizedValues: {
                        departureTime: { time: { text: "08:20" } },
                        arrivalTime: { time: { text: "08:55" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            duration: "3120s",
            distanceMeters: 14000,
            localizedValues: { duration: { text: "52 דקות" } },
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      headsign: "תל אביב",
                      stopDetails: {
                        departureStop: { name: "שלום דורני" },
                        arrivalStop: { name: "השלום" },
                        departureTime: "2026-10-22T05:10:00Z",
                      },
                      transitLine: { nameShort: "66" },
                      localizedValues: {
                        departureTime: { time: { text: "08:10" } },
                        arrivalTime: { time: { text: "08:55" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));

    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Compact multi lead + recalculation cue.
    expect(text).toContain("מצאתי 2 אפשרויות");
    expect(text).toContain("המלצה:");
    expectMultiAltsCue(text, 1);
    // MOT enrichment still present with useful schedule rows.
    expect(text).toMatch(/מתוזמנות רשמיות/);
    expect(text).toContain("08:12");
    expect(text).toContain("08:22");
    expect(text).toContain(gtfsQuery.GTFS_OFFICIAL_SOURCE_HE);
    // Residual risk #1: enrichment must not reintroduce stable option indexes.
    expect(text).not.toMatch(/אפשרות\s*1/);
    expect(text).not.toMatch(/אפשרות\s*2/);
  });

  it("skips official boarding block when GTFS is disabled", async () => {
    const enabled = vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(false);
    const sched = vi.spyOn(gtfsQuery, "querySchedule");
    const extra = await formatOfficialBoardingDeparturesHe(boardFacts());
    expect(extra).toBe("");
    expect(enabled).toHaveBeenCalled();
    expect(sched).not.toHaveBeenCalled();
  });

  it("keeps Google-only reply when boarding stop schedule is ambiguous", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(true);
    vi.spyOn(gtfsQuery, "querySchedule").mockResolvedValue({
      ok: false,
      kind: "ambiguous",
      ambiguity: {
        kind: "stop",
        messageHe: "מצאתי כמה תחנות",
        options: ["ארנס א", "ארנס ב"],
      },
    });
    const extra = await formatOfficialBoardingDeparturesHe(boardFacts());
    expect(extra).toBe("");
  });

  it("trip reply still returns Google estimates when GTFS enrichment is empty", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(false);
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("places:searchText")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                displayName: { text: "פתח תקווה" },
                location: { latitude: 32.09, longitude: 34.88 },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              duration: "1800s",
              localizedValues: { duration: { text: "30 דקות" } },
              legs: [
                {
                  steps: [
                    {
                      travelMode: "TRANSIT",
                      transitDetails: {
                        stopDetails: {
                          departureStop: { name: "ארנס" },
                          arrivalStop: { name: "השלום" },
                          departureTime: "2026-10-22T05:20:00Z",
                        },
                        transitLine: { nameShort: "51" },
                        localizedValues: {
                          departureTime: { time: { text: "08:20" } },
                          arrivalTime: { time: { text: "08:50" } },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      };
    });
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/מסלול|תחבורה|קו 51/);
    expect(text).toMatch(/משוער|08:20|08:50/);
    expect(text).not.toMatch(/מתוזמנות רשמיות|SIRI|תחזית חיה/);
  });

  it("live_arrivals with stop name falls back to labeled Google ETA when GTFS off", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(false);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            duration: "1800s",
            legs: [
              {
                steps: [
                  {
                    travelMode: "TRANSIT",
                    transitDetails: {
                      stopDetails: {
                        departureStop: { name: "פינסקר/גיסין" },
                        departureTime: "2026-10-25T17:00:00Z",
                      },
                      transitLine: { nameShort: "51" },
                      localizedValues: {
                        departureTime: { time: { text: "20:00" } },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));
    const { text } = await resolveRoutesReply({
      origin: "פינסקר גיסין",
      destination: "תל אביב",
      line: "51",
      aspects: ["live_arrivals"],
      apiKey: "test-key",
      now: new Date("2026-10-25T16:50:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain(ROUTES_GOOGLE_ETA_NOT_SIRI_INTRO_HE);
    expect(text).toMatch(/הערכת Google/);
    expect(text).toMatch(/לא תחזית SIRI/);
    expect(text).toMatch(/קוד תחנה/);
    expect(text).toMatch(/יוצא|בעוד|קו 51/);
    expect(text).not.toBe("לתחזית חיה צריך קוד תחנה רשמי (מספר).");
  });

  it("live_arrivals unavailable SIRI with line falls back to labeled schedule-only", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(true);
    vi.spyOn(gtfsQuery, "getActiveGenerationId").mockResolvedValue(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    vi.spyOn(gtfsQuery, "resolveScheduleStopRef").mockResolvedValue({
      ok: true,
      via: "stop_code",
      match: { stopCode: "21566", stopName: "ארנס" },
    });
    vi.spyOn(siriSm, "fetchSiriStopArrivals").mockResolvedValue({
      ok: false,
      kind: "disabled",
      messageHe: siriSm.SIRI_DISABLED_HE,
    });
    vi.spyOn(gtfsQuery, "querySchedule").mockResolvedValue({
      ok: true,
      sourceHe: gtfsQuery.GTFS_OFFICIAL_SOURCE_HE,
      departures: [
        {
          stopCode: "21566",
          stopName: "ארנס",
          line: "51",
          agencyName: "דן",
          directionLabel: "",
          headsign: "תל אביב",
          departureTime: "08:25",
          depSeconds: 8 * 3600 + 25 * 60,
          serviceDate: "2026-10-25",
        },
      ],
    });

    const { text } = await resolveRoutesReply({
      origin: "21566",
      destination: "",
      stopCode: "21566",
      line: "51",
      aspects: ["live_arrivals"],
    });
    expect(text).toContain(siriSm.SIRI_DISABLED_HE);
    expect(text).toContain(ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE);
    expect(text).toContain(gtfsQuery.GTFS_OFFICIAL_SOURCE_HE);
    expect(text).toMatch(/יציאות מתוזמנות/);
    expect(text).toMatch(/08:25/);
    expect(text).not.toContain(siriSm.SIRI_LIVE_SOURCE_HE);
    expect(text).not.toMatch(/תחזית חיה \(SIRI\)/);
  });

  it("live_arrivals stale SIRI falls back to labeled schedule-only", async () => {
    vi.spyOn(gtfsQuery, "isGtfsEnabled").mockReturnValue(true);
    vi.spyOn(gtfsQuery, "getActiveGenerationId").mockResolvedValue(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    vi.spyOn(gtfsQuery, "resolveScheduleStopRef").mockResolvedValue({
      ok: true,
      via: "stop_code",
      match: { stopCode: "21566", stopName: "ארנס" },
    });
    vi.spyOn(siriSm, "fetchSiriStopArrivals").mockResolvedValue({
      ok: false,
      kind: "stale",
      messageHe: siriSm.SIRI_STALE_HE,
    });
    vi.spyOn(gtfsQuery, "querySchedule").mockResolvedValue({
      ok: true,
      sourceHe: gtfsQuery.GTFS_OFFICIAL_SOURCE_HE,
      departures: [
        {
          stopCode: "21566",
          stopName: "ארנס",
          line: "51",
          agencyName: "דן",
          directionLabel: "",
          headsign: "תל אביב",
          departureTime: "09:10",
          depSeconds: 9 * 3600 + 10 * 60,
          serviceDate: "2026-10-25",
        },
      ],
    });

    const { text } = await resolveRoutesReply({
      origin: "21566",
      destination: "",
      stopCode: "21566",
      line: "51",
      aspects: ["live_arrivals"],
    });
    expect(text).toContain(siriSm.SIRI_STALE_HE);
    expect(text).toContain(ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE);
    expect(text).toMatch(/יציאות מתוזמנות/);
    expect(text).toMatch(/09:10/);
    expect(text).toContain(gtfsQuery.GTFS_OFFICIAL_SOURCE_HE);
    expect(text).not.toContain(siriSm.SIRI_LIVE_SOURCE_HE);
  });

  it("schedule aspect labels official MOT timetable as scheduled-only (not live)", async () => {
    vi.spyOn(gtfsQuery, "querySchedule").mockResolvedValue({
      ok: true,
      sourceHe: gtfsQuery.GTFS_OFFICIAL_SOURCE_HE,
      departures: [
        {
          stopCode: "21566",
          stopName: "ארנס",
          line: "51",
          agencyName: "דן",
          directionLabel: "",
          headsign: "תל אביב",
          departureTime: "07:40",
          depSeconds: 7 * 3600 + 40 * 60,
          serviceDate: "2026-10-25",
        },
      ],
    });

    const { text } = await resolveRoutesReply({
      origin: "21566",
      destination: "",
      stopCode: "21566",
      line: "51",
      aspects: ["schedule"],
    });
    expect(text).toMatch(/יציאות מתוזמנות/);
    expect(text).toContain(gtfsQuery.GTFS_OFFICIAL_SOURCE_HE);
    expect(text).toMatch(/07:40/);
    expect(text).toMatch(/קו 51/);
    expect(text).not.toContain(ROUTES_SCHEDULE_NOT_LIVE_INTRO_HE);
    expect(text).not.toContain(siriSm.SIRI_LIVE_SOURCE_HE);
    expect(text).not.toMatch(/תחזית חיה|SIRI/);
    expect(text).toMatch(/מתוזמן, לא זמן אמת/);
  });
});

describe("saved location origin/destination in resolveRoutesReply", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSavedRoutesPayload() {
    const depIso = new Date(Date.now() + 18 * 60_000).toISOString();
    return {
      routes: [
        {
          duration: "1800s",
          distanceMeters: 12000,
          localizedValues: { duration: { text: "30 דקות" } },
          legs: [
            {
              steps: [
                {
                  travelMode: "TRANSIT",
                  staticDuration: "1200s",
                  transitDetails: {
                    stopDetails: {
                      departureTime: { time: { text: "16:20" } },
                      arrivalTime: { time: { text: "16:50" } },
                      departureStop: { name: "שלום דורני" },
                      arrivalStop: { name: "דיזנגוף" },
                    },
                    localizedValues: {
                      departureTime: { time: { text: "16:20" } },
                      arrivalTime: { time: { text: "16:50" } },
                    },
                    transitLine: {
                      nameShort: "66",
                      name: "קו 66",
                    },
                    headsign: "תל אביב",
                    stopCount: 12,
                  },
                  departureTime: depIso,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const snapshot = {
    filing: [
      {
        filing_id: "f-home",
        item_name: "מיקום הבית",
        item_info: "32.099279, 34.8923104",
        item_description: "מיקום הבית שנשלח בוואטסאפ",
        owner: "טל",
        scope: "personal" as const,
      },
      {
        filing_id: "f-home-2",
        item_name: "בית הורים",
        item_info: "32.05, 34.75",
        item_description: "",
        owner: "טל",
        scope: "personal" as const,
      },
    ],
    lists: [
      {
        list_type: "tasks",
        owner: "טל",
        scope: "personal" as const,
        items: [
          {
            item_id: "t-work",
            "שם מטלה": "העבודה",
            מקום: "32.085, 34.781",
          },
        ],
      },
      {
        list_type: "custom",
        list_name: "מקומות",
        owner: "טל",
        scope: "personal" as const,
        columns: ["שם", "נקודה"],
        title_field: "שם",
        items: [
          {
            item_id: "c-mall",
            שם: "הקניון הגדול",
            נקודה: "32.08, 34.80",
          },
        ],
      },
    ],
  };

  function mockTransitFetch(opts?: {
    destGeocode?: { lat: number; lng: number; label: string };
  }) {
    return vi.fn(async (url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("places:searchText")) {
        const g = opts?.destGeocode ?? {
          lat: 32.074,
          lng: 34.781,
          label: "דיזנגוף סנטר",
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            places: [
              {
                displayName: { text: g.label },
                location: { latitude: g.lat, longitude: g.lng },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => mockSavedRoutesPayload(),
      };
    });
  }

  it("filing saved origin uses coords (no pin) and notices", async () => {
    const fetchImpl = mockTransitFetch();
    const { text } = await resolveRoutesReply({
      origin: "מיקום הבית",
      destination: "דיזנגוף סנטר",
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("משתמש במיקום השמור «מיקום הבית»");
    expect(text).not.toMatch(/שלח מיקום/);
    const body = computeRoutesBody(fetchImpl);
    const origin = body.origin as { location?: { latLng?: { latitude: number; longitude: number } } };
    expect(origin?.location?.latLng?.latitude).toBeCloseTo(32.099279);
    expect(origin?.location?.latLng?.longitude).toBeCloseTo(34.8923104);
  });

  it("builtin tasks item as origin", async () => {
    const fetchImpl = mockTransitFetch();
    const { text } = await resolveRoutesReply({
      origin: "העבודה",
      destination: "דיזנגוף סנטר",
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("משתמש במיקום השמור «העבודה»");
    const body = computeRoutesBody(fetchImpl);
    const origin = body.origin as { location?: { latLng?: { latitude: number } } };
    expect(origin?.location?.latLng?.latitude).toBeCloseTo(32.085);
  });

  it("custom list item as destination + free-text is not required", async () => {
    const fetchImpl = mockTransitFetch();
    const { text } = await resolveRoutesReply({
      origin: "מיקום הבית",
      destination: "הקניון הגדול",
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("משתמש במיקום השמור «מיקום הבית»");
    expect(text).toContain("משתמש במיקום השמור «הקניון הגדול»");
    const urls = fetchImpl.mock.calls.map((c) => String(c[0] ?? ""));
    expect(urls.some((u) => u.includes("places:searchText"))).toBe(false);
    const body = computeRoutesBody(fetchImpl);
    const dest = body.destination as {
      location?: { latLng?: { latitude: number; longitude: number } };
    };
    expect(dest?.location?.latLng?.latitude).toBeCloseTo(32.08);
    expect(dest?.location?.latLng?.longitude).toBeCloseTo(34.8);
  });

  it("saved origin + free-text destination geocodes only the destination", async () => {
    const fetchImpl = mockTransitFetch({
      destGeocode: { lat: 32.074, lng: 34.781, label: "דיזנגוף סנטר" },
    });
    const { text } = await resolveRoutesReply({
      origin: "f-home",
      destination: "דיזנגוף סנטר",
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("משתמש במיקום השמור «מיקום הבית»");
    const urls = fetchImpl.mock.calls.map((c) => String(c[0] ?? ""));
    expect(urls.some((u) => u.includes("places:searchText"))).toBe(true);
    expect(urls.some((u) => u.includes("computeRoutes"))).toBe(true);
    const body = computeRoutesBody(fetchImpl);
    const origin = body.origin as { location?: { latLng?: { latitude: number } } };
    expect(origin?.location?.latLng?.latitude).toBeCloseTo(32.099279);
  });

  it("ambiguous saved places ask without calling Google Routes", async () => {
    const fetchImpl = mockTransitFetch();
    const { text } = await resolveRoutesReply({
      origin: "בית",
      destination: "דיזנגוף סנטר",
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/כמה מיקומים שמורים/);
    expect(text).toContain("מיקום הבית");
    expect(text).toContain("בית הורים");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("speaker + live pin wins over saved home filing", async () => {
    const fetchImpl = mockTransitFetch();
    const { text } = await resolveRoutesReply({
      origin: "speaker",
      destination: "דיזנגוף סנטר",
      originLat: 32.11,
      originLng: 34.85,
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).not.toContain("מיקום הבית");
    expect(text).not.toContain("משתמש במיקום השמור");
    const body = computeRoutesBody(fetchImpl);
    const origin = body.origin as { location?: { latLng?: { latitude: number; longitude: number } } };
    expect(origin?.location?.latLng?.latitude).toBeCloseTo(32.11);
    expect(origin?.location?.latLng?.longitude).toBeCloseTo(34.85);
  });

  it("speaker without pin asks for WhatsApp even when home filing exists", async () => {
    const fetchImpl = mockTransitFetch();
    const { text } = await resolveRoutesReply({
      origin: "speaker",
      destination: "דיזנגוף סנטר",
      aspects: ["summary"],
      apiKey: "test-key",
      snapshot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toMatch(/שלח מיקום/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("chat.service wires snapshot into resolveRoutesReply", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("snapshot: routesSnapshot");
    expect(src).toMatch(
      /getEmployeeRecordSnapshot\(input\.employeeId\)[\s\S]*resolveRoutesReply/,
    );
  });
});
