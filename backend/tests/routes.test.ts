import { describe, expect, it, vi } from "vitest";
import {
  boardingStopMatchesOrigin,
  formatRoutesHebrew,
  ROUTES_STEPS_LOCAL_TRUNCATION_HE,
  ROUTES_STEPS_SUMMARY_DISPLAY_CAP,
  parseRoutesAspects,
  resolveRoutesReply,
  toRoutesRfc3339,
  type RoutesFacts,
} from "../src/services/routes.js";

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

describe("formatRoutesHebrew", () => {
  const base: RoutesFacts = {
    origin: "ז׳בוטינסקי פתח תקווה",
    destination: "דיזנגוף סנטר",
    departure: "",
    arrival: "",
    line: "",
    headsign: "",
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
        headwaySeconds: 720,
      },
    ],
    navigateAddress: "דיזנגוף סנטר",
    lineMatchFailed: false,
    matchedFromStop: "",
    matchedLine: "",
    stopLines: [],
    stopDisplayName: "",
  };

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
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown[])[1]?.body ?? "{}"),
    );
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
});
