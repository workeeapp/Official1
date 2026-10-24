/**
 * Offline proofs for Places/Flights Stage B wire (live_select).
 * Levels: engine_apply + format contracts. Not live Hebrew model accuracy.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_SELECT_FAILURE_HE,
  LIVE_SELECT_NO_MATCH_HE,
  LIVE_SELECT_UNFILTERED_LABEL_HE,
  type LiveSelectApplyResult,
} from "../src/services/live-retrieval-select.js";
import {
  filterPlacesFactsByIds,
  formatPlacesAfterLiveSelect,
  formatPlacesHebrew,
  placesToLiveRetrievalRecords,
  resolvePlacesReply,
  type PlaceResult,
  type PlacesFacts,
} from "../src/services/places.js";
import {
  filterFlightsFactsByIds,
  flightsToLiveRetrievalRecords,
  formatFlightsAfterLiveSelect,
  formatFlightsHebrew,
  resolveFlightsReply,
  type FlightRow,
  type FlightsFacts,
} from "../src/services/flights.js";
import { parseReplyMetadata } from "@workee/shared";

const placeA: PlaceResult = {
  id: "p-a",
  name: "חניון א",
  phone: "",
  address: "רחוב 1",
  postalCode: "",
  rating: 4.5,
  openNow: true,
  weekdayHours: [],
  mapsUrl: "",
  parking: {
    freeLot: true,
    paidLot: false,
    freeStreet: null,
    paidStreet: null,
    valet: null,
    freeGarage: null,
    paidGarage: null,
  },
  accessibility: null,
  outdoorSeating: null,
  goodForChildren: null,
  payment: null,
};

const placeB: PlaceResult = {
  ...placeA,
  id: "p-b",
  name: "חניון ב",
  parking: {
    freeLot: false,
    paidLot: true,
    freeStreet: null,
    paidStreet: null,
    valet: null,
    freeGarage: null,
    paidGarage: null,
  },
};

const placesFacts: PlacesFacts = {
  query: "חניה",
  place: "תל אביב",
  nearSpeaker: false,
  aspects: ["summary", "parking"],
  intent: "parking",
  openNowFilter: null,
  minRating: null,
  includedType: "parking",
  radiusMeters: null,
  parkingCost: "free",
  results: [placeA, placeB],
};

const flightA: FlightRow = {
  liveRecordId: "f-a",
  flightIata: "LY831",
  flightNumber: "831",
  airlineName: "El Al",
  airlineIata: "LY",
  otherIata: "CDG",
  otherAirportName: "Paris",
  scheduledIso: "2026-10-22T10:00:00+00:00",
  estimatedIso: "2026-10-22T10:00:00+00:00",
  status: "scheduled",
  gate: "B7",
  terminal: "3",
  delayMinutes: null,
  direction: "departures",
};

const flightB: FlightRow = {
  ...flightA,
  liveRecordId: "f-b",
  flightIata: "AF100",
  flightNumber: "100",
  airlineName: "Air France",
  airlineIata: "AF",
};

const flightsFacts: FlightsFacts = {
  airport: "TLV",
  direction: "departures",
  airline: "",
  airlines: [],
  city: "",
  flight: "",
  date: "",
  withinMinutes: null,
  timeFrom: "",
  timeTo: "",
  aspects: ["board"],
  rows: [flightA, flightB],
};

describe("places/flights live_select adapters", () => {
  it("placesToLiveRetrievalRecords exposes ids + parking evidence fields", () => {
    const records = placesToLiveRetrievalRecords(placesFacts);
    expect(records.map((r) => r.id)).toEqual(["p-a", "p-b"]);
    expect(records[0]!.fields?.parking).toMatchObject({ free_lot: true });
  });

  it("filterPlacesFactsByIds keeps retrieval order subset", () => {
    const filtered = filterPlacesFactsByIds(placesFacts, ["p-b", "unknown", "p-a"]);
    expect(filtered.results.map((r) => r.id)).toEqual(["p-a", "p-b"]);
    const onlyB = filterPlacesFactsByIds(placesFacts, ["p-b"]);
    expect(onlyB.results.map((r) => r.id)).toEqual(["p-b"]);
  });

  it("flightsToLiveRetrievalRecords + filter preserve order", () => {
    const records = flightsToLiveRetrievalRecords(flightsFacts);
    expect(records.map((r) => r.id)).toEqual(["f-a", "f-b"]);
    const filtered = filterFlightsFactsByIds(flightsFacts, ["f-b"]);
    expect(filtered.rows.map((r) => r.liveRecordId)).toEqual(["f-b"]);
  });
});

describe("formatPlacesAfterLiveSelect / formatFlightsAfterLiveSelect", () => {
  it("subset shows only verified original rows", () => {
    const outcome: LiveSelectApplyResult = {
      kind: "subset",
      keptIds: ["p-a"],
      mayShowUnfilteredLabeled: false,
    };
    const text = formatPlacesAfterLiveSelect(placesFacts, outcome);
    expect(text).toContain("*חניון א*");
    expect(text).not.toContain("*חניון ב*");
  });

  it("structured_only keeps full board without failure label", () => {
    const text = formatPlacesAfterLiveSelect(placesFacts, {
      kind: "structured_only",
      keptIds: ["p-a", "p-b"],
      mayShowUnfilteredLabeled: false,
    });
    expect(text).toContain("*חניון א*");
    expect(text).toContain("*חניון ב*");
    expect(text).not.toContain(LIVE_SELECT_FAILURE_HE);
    expect(text).not.toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
  });

  it("subset listing every id = completed all-match (no failure label)", () => {
    const text = formatPlacesAfterLiveSelect(placesFacts, {
      kind: "subset",
      keptIds: ["p-a", "p-b"],
      mayShowUnfilteredLabeled: false,
    });
    expect(text).toContain("*חניון א*");
    expect(text).toContain("*חניון ב*");
    expect(text).not.toContain(LIVE_SELECT_FAILURE_HE);
  });

  it("no_match uses select message — not full unfiltered board as success", () => {
    const text = formatPlacesAfterLiveSelect(placesFacts, {
      kind: "no_match",
      keptIds: [],
      messageHe: LIVE_SELECT_NO_MATCH_HE,
      mayShowUnfilteredLabeled: false,
    });
    expect(text).toContain(LIVE_SELECT_NO_MATCH_HE);
    expect(text).not.toContain("חניון א");
  });

  it("failure labels unfiltered board — never silent keep-all success", () => {
    const text = formatPlacesAfterLiveSelect(placesFacts, {
      kind: "failure",
      keptIds: [],
      messageHe: LIVE_SELECT_FAILURE_HE,
      mayShowUnfilteredLabeled: true,
    });
    expect(text).toContain(LIVE_SELECT_FAILURE_HE);
    expect(text).toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
    expect(text).toContain("חניון א");
    const plain = formatPlacesHebrew(placesFacts);
    expect(text).not.toBe(plain);
  });

  it("flights subset / failure / no_match mirror places contracts", () => {
    const subset = formatFlightsAfterLiveSelect(flightsFacts, {
      kind: "subset",
      keptIds: ["f-b"],
      mayShowUnfilteredLabeled: false,
    });
    expect(subset).toContain("AF100");
    expect(subset).not.toContain("LY831");

    const noMatch = formatFlightsAfterLiveSelect(flightsFacts, {
      kind: "no_match",
      keptIds: [],
      mayShowUnfilteredLabeled: false,
    });
    expect(noMatch).toContain(LIVE_SELECT_NO_MATCH_HE);
    expect(noMatch).not.toContain("LY831");

    const failure = formatFlightsAfterLiveSelect(flightsFacts, {
      kind: "failure",
      keptIds: [],
      mayShowUnfilteredLabeled: true,
    });
    expect(failure).toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
    expect(failure).toContain("LY831");
    expect(failure).not.toBe(formatFlightsHebrew(flightsFacts));
  });
});

describe("resolvePlacesReply / resolveFlightsReply Stage B gate", () => {
  const placesFetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      places: [
        {
          id: "places/a",
          displayName: { text: "חניון א" },
          formattedAddress: "רחוב 1",
          parkingOptions: { freeParkingLot: true },
        },
        {
          id: "places/b",
          displayName: { text: "חניון ב" },
          formattedAddress: "רחוב 2",
          parkingOptions: { paidParkingLot: true },
        },
      ],
    }),
  }));

  it("requireLiveSelect=false → zero Stage B calls", async () => {
    const runSelect = vi.fn();
    const text = await resolvePlacesReply({
      query: "חניה",
      place: "תל אביב",
      intent: "parking",
      parkingCost: "free",
      requireLiveSelect: false,
      runSelect,
      apiKey: "test-key",
      fetchImpl: placesFetch as unknown as typeof fetch,
    });
    expect(runSelect).not.toHaveBeenCalled();
    expect(text).toContain("חניון");
    expect(text).not.toContain(LIVE_SELECT_FAILURE_HE);
  });

  it("requireLiveSelect=true with rows → Stage B; completed subset applies", async () => {
    const runSelect = vi.fn(async () => ({
      kind: "subset" as const,
      keptIds: ["places/a"],
      mayShowUnfilteredLabeled: false,
    }));
    const text = await resolvePlacesReply({
      query: "חניה",
      place: "תל אביב",
      intent: "parking",
      requireLiveSelect: true,
      speakerAsk: "חניון חינם ליד הים",
      runSelect,
      apiKey: "test-key",
      fetchImpl: placesFetch as unknown as typeof fetch,
    });
    expect(runSelect).toHaveBeenCalledTimes(1);
    expect(runSelect.mock.calls[0]![0].domain).toBe("places");
    expect(text).toContain("*חניון א*");
    expect(text).not.toContain("*חניון ב*");
    expect(text).not.toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
  });

  it("requireLiveSelect=true + select null/keep_all decline → labeled failure, not silent success", async () => {
    const runSelect = vi.fn(async () => ({
      kind: "failure" as const,
      keptIds: [] as string[],
      messageHe: LIVE_SELECT_FAILURE_HE,
      mayShowUnfilteredLabeled: true,
    }));
    const text = await resolvePlacesReply({
      query: "חניה",
      place: "תל אביב",
      intent: "parking",
      requireLiveSelect: true,
      speakerAsk: "שקט ליד הים",
      runSelect,
      apiKey: "test-key",
      fetchImpl: placesFetch as unknown as typeof fetch,
    });
    expect(runSelect).toHaveBeenCalledTimes(1);
    expect(text).toContain(LIVE_SELECT_FAILURE_HE);
    expect(text).toContain(LIVE_SELECT_UNFILTERED_LABEL_HE);
    expect(text.indexOf(LIVE_SELECT_FAILURE_HE)).toBe(0);
  });

  it("requireLiveSelect=true + empty rows → no Stage B", async () => {
    const emptyFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ places: [] }),
    }));
    const runSelect = vi.fn();
    const text = await resolvePlacesReply({
      query: "חניה",
      place: "איפה שאין",
      requireLiveSelect: true,
      runSelect,
      apiKey: "test-key",
      fetchImpl: emptyFetch as unknown as typeof fetch,
    });
    expect(runSelect).not.toHaveBeenCalled();
    expect(text).toContain("לא מצאתי");
  });

  it("flights: require false skips Stage B; true subsets", async () => {
    const dep = new Date(Date.now() + 45 * 60_000).toISOString();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            flight_status: "scheduled",
            airline: { name: "El Al", iata: "LY" },
            flight: { number: "831", iata: "LY831" },
            departure: {
              iata: "TLV",
              airport: "Ben Gurion",
              scheduled: dep,
              estimated: dep,
              gate: "C3",
            },
            arrival: { iata: "CDG", airport: "Paris", scheduled: dep, estimated: dep },
          },
          {
            flight_status: "scheduled",
            airline: { name: "Air France", iata: "AF" },
            flight: { number: "100", iata: "AF100" },
            departure: {
              iata: "TLV",
              airport: "Ben Gurion",
              scheduled: dep,
              estimated: dep,
              gate: "D1",
            },
            arrival: { iata: "CDG", airport: "Paris", scheduled: dep, estimated: dep },
          },
        ],
      }),
    }));

    const skip = vi.fn();
    await resolveFlightsReply({
      airport: "TLV",
      direction: "departures",
      aspects: ["board"],
      requireLiveSelect: false,
      runSelect: skip,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(skip).not.toHaveBeenCalled();

    const runSelect = vi.fn(async (input: { records: { id: string }[] }) => ({
      kind: "subset" as const,
      keptIds: [input.records[0]!.id],
      mayShowUnfilteredLabeled: false,
    }));
    const text = await resolveFlightsReply({
      airport: "TLV",
      direction: "departures",
      aspects: ["board"],
      requireLiveSelect: true,
      speakerAsk: "רק אל על",
      runSelect,
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(runSelect).toHaveBeenCalledTimes(1);
    expect(runSelect.mock.calls[0]![0].domain).toBe("flights");
    expect(text).toContain("LY831");
    expect(text).not.toContain("AF100");
  });

  it("flights time_from/time_to and airlines filters still apply without Stage B", async () => {
    const base = Date.parse("2026-10-22T16:00:00+03:00");
    const mk = (iata: string, airline: string, offsetMin: number) => {
      const scheduled = new Date(base + offsetMin * 60_000).toISOString();
      return {
        flight_status: "scheduled",
        airline: { name: airline, iata },
        flight: { number: "1", iata: `${iata}1` },
        departure: {
          iata: "TLV",
          airport: "TLV",
          scheduled,
          estimated: scheduled,
        },
        arrival: {
          iata: "CDG",
          airport: "Paris",
          scheduled,
          estimated: scheduled,
        },
      };
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          mk("LY", "El Al", 0), // 16:00
          mk("AF", "Air France", 60), // 17:00
          mk("LH", "Lufthansa", 180), // 19:00 — outside window
        ],
      }),
    }));
    const runSelect = vi.fn();
    const text = await resolveFlightsReply({
      airport: "TLV",
      direction: "departures",
      airlines: ["LY", "AF"],
      timeFrom: "16:00",
      timeTo: "17:30",
      aspects: ["board"],
      requireLiveSelect: false,
      runSelect,
      apiKey: "test-key",
      now: new Date(base - 60_000),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(runSelect).not.toHaveBeenCalled();
    expect(text).toContain("LY1");
    expect(text).toContain("AF1");
    expect(text).not.toContain("LH1");
  });
});

describe("F/Q/U capability contract (parse_shape — not live Hebrew proof)", () => {
  it("free+safe parking: F via parking_cost, require_live_select false (U safety)", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        responses: [
          "אחפש חניה חינם; אין לי דרך לאמת «בטוח» מנתוני גוגל.",
        ],
        metadata: {
          places: {
            query: "חניה",
            place: "תל אביב",
            intent: "parking",
            parking_cost: "free",
            require_live_select: false,
          },
        },
      }),
    );
    expect(meta.places?.parkingCost).toBe("free");
    expect(meta.places?.requireLiveSelect).toBe(false);
    expect(meta.places?.intent).toBe("parking");
  });

  it("V residual sets require_live_select true on places/flights", () => {
    const places = parseReplyMetadata(
      JSON.stringify({
        responses: [],
        metadata: {
          places: {
            query: "מסעדה שקטה",
            place: "תל אביב",
            require_live_select: true,
          },
        },
      }),
    );
    expect(places.places?.requireLiveSelect).toBe(true);

    const flights = parseReplyMetadata(
      JSON.stringify({
        responses: [],
        metadata: {
          flights: {
            direction: "departures",
            airlines: ["LH", "AF", "BA"],
            require_live_select: false,
          },
        },
      }),
    );
    expect(flights.flights?.airlines.length).toBeGreaterThan(0);
    expect(flights.flights?.requireLiveSelect).toBe(false);
  });
});

describe("same-turn live_select schema wording", () => {
  it("LLM.action.json describes same-turn-only select (no LAST_LIVE_RETRIEVAL stash)", () => {
    const action = readFileSync(
      resolve(process.cwd(), "..", "LLM.action.json"),
      "utf8",
    );
    expect(action).not.toContain("LAST_LIVE_RETRIEVAL");
    expect(action).toMatch(/Same-turn post-retrieval live board selection/i);
    expect(action).toMatch(/no cross-turn live retrieval stash/i);
    expect(action).toMatch(/do NOT return null/i);
  });
});

describe("Stage B isolation (source contract)", () => {
  it("Weather/Market/Routes/Mashov/Jewish resolvers do not call runLivePostSelect", () => {
    const root = resolve(process.cwd(), "src/services");
    for (const file of [
      "weather.ts",
      "market.ts",
      "routes.ts",
      "mashov.ts",
      "jewish.ts",
    ]) {
      const src = readFileSync(resolve(root, file), "utf8");
      expect(src).not.toContain("runLivePostSelect");
      expect(src).not.toContain("requireLiveSelect");
    }
  });

  it("chat wires requireLiveSelect only into places and flights resolves", () => {
    const chat = readFileSync(
      resolve(process.cwd(), "src/services/chat.service.ts"),
      "utf8",
    );
    const gates = [
      ...chat.matchAll(
        /requireLiveSelect:\s*(\w+)\.requireLiveSelect\s*===\s*true/g,
      ),
    ].map((m) => m[1]);
    expect(gates).toEqual(["placesAction", "flightsAction"]);
    expect(chat).not.toMatch(
      /requireLiveSelect:\s*(weather|market|routes|mashov|jewish)/i,
    );
  });
});
