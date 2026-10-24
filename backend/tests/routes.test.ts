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
  ROUTES_DRIVE_ESTIMATE_DISCLAIMER_HE,
  ROUTES_ITINERARY_DISPLAY_CAP,
  ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE,
  ROUTES_STEPS_LOCAL_TRUNCATION_HE,
  ROUTES_STEPS_SUMMARY_DISPLAY_CAP,
  parseRoutesAspects,
  resolveRoutesReply,
  toRoutesRfc3339,
  type RouteItineraryOption,
  type RoutesFacts,
} from "../src/services/routes.js";
import * as gtfsQuery from "../src/services/gtfs-query.js";
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

  it("formats multiple Google itineraries with estimate disclaimer", () => {
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
    expect(text).toContain("*אפשרות 1*");
    expect(text).toContain("*אפשרות 2*");
    expect(text).toContain("משך משוער *45 דקות*");
    expect(text).toContain("משך משוער *52 דקות*");
    expect(text).toContain("קו 51");
    expect(text).toContain("קו 66");
    expect(text).toContain("הליכה משוערת 5 דקות");
    expect(text).toContain("בלי החלפה");
    expect(text).toContain("1 החלפות");
    expect(text).toMatch(/משוער/);
    expect(text).not.toContain("מסלול בתחבורה ציבורית מ«");
    // Honesty disclaimer mentions MOT/RT only as what this is *not*.
    expect(text).toContain("מגוגל");
    expect(text).not.toContain("SIRI");
    expect(text).not.toMatch(/הגעות חזויות/);
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
    expect(text).toContain("משך משוער *40 דקות*");
    expect(text).not.toMatch(/יציאה משוערת/);
    expect(text).not.toMatch(/הגעה משוערת/);
    expect(text).not.toMatch(/מחיר משוער/);
    expect(text).not.toMatch(/→/);
    expect(text).toContain("קו 1");
    expect(text).toContain("קו 82");
  });
});

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

  function mockRoutesPayload(opts: {
    line: string;
    fromStop: string;
    departureText?: string;
    departureInMinutes?: number;
    altLine?: string;
    altFromStop?: string;
  }) {
    const depIso = new Date(
      Date.now() + (opts.departureInMinutes ?? 15) * 60_000,
    ).toISOString();
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
                    time: { text: opts.departureText ?? "08:30" },
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
                      time: { text: opts.departureText ?? "08:30" },
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
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({
          line: "66",
          fromStop: "שלום דורני/העצמאות",
          departureText: "16:20",
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
    expect(text).toContain("16:20");
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
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        mockRoutesPayload({
          line: "1",
          fromStop: "שלום דורני",
          altLine: "66",
          altFromStop: "שלום דורני/העצמאות",
          departureText: "17:05",
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
    expect(text).toContain("17:05");
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
    const { text } = await resolveRoutesReply({
      origin: "פתח תקווה",
      destination: "תל אביב",
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toContain("מצאתי 2 אפשרויות");
    expect(text).toContain(ROUTES_MULTI_ESTIMATE_DISCLAIMER_HE);
    expect(text).toContain("קו 51");
    expect(text).toContain("קו 66");
    // Ranked by earlier leave: 66 @ 08:10 before 51 @ 08:20.
    expect(text.indexOf("קו 66")).toBeLessThan(text.indexOf("קו 51"));
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
    expect(text).not.toMatch(/יציאה משוערת/);
    expect(text).not.toMatch(/הגעה משוערת/);
    expect(text).not.toMatch(/מחיר משוער/);
    expect(text).toContain("קו 1");
    expect(text).toContain("קו 82");
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
    expect(text).toContain("קו 51");
    expect(text).toContain("קו 66");
    expect(text).not.toContain("קו 999");
    expect(text).not.toContain("קו 1");
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
    expect(text).toContain("קו 11");
    expect(text).toContain("קו 33");
    expect(text).not.toContain("קו 44");
    expect(text).not.toContain("קו 55");
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
    expect(text).toMatch(/הערכת Google/);
    expect(text).toMatch(/לא תחזית SIRI/);
    expect(text).toMatch(/קוד תחנה/);
    expect(text).toMatch(/יוצא|בעוד|קו 51/);
    expect(text).not.toBe("לתחזית חיה צריך קוד תחנה רשמי (מספר).");
  });
});
