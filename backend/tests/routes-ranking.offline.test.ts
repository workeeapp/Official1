/**
 * Transit ranking (Ramon school, 2026-11-05). Real Google board, depart 09:00:
 *   A 23א→25, 1 transfer, 6 min walk, arrive 09:30
 *   B 23א 2-minute ride, 0 transfers, 20 min walk, arrive 09:23
 *   C 51 6-minute ride, 0 transfers, 16 min walk, arrive 09:23
 * Old ranking (leaves earliest) recommended A, then B for «ללא החלפה».
 * Product: transfers are the worse trade in a city; a 2-minute ride then a
 * 20-minute walk is not a real option → C, then A, then B.
 */
import { describe, expect, it } from "vitest";
import {
  itineraryMostlyWalking,
  itineraryTransferCount,
  rankTripItineraries,
  type RouteItineraryOption,
} from "../src/services/routes.js";

type Step = RouteItineraryOption["steps"][number];

function walk(seconds: number): Step {
  return {
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
    durationSeconds: seconds,
    headwaySeconds: null,
  };
}

function ride(line: string, seconds: number, dep: string, arr: string): Step {
  return {
    travelMode: "TRANSIT",
    instruction: "",
    line,
    headsign: "",
    fromStop: "a",
    toStop: "b",
    departureTime: dep,
    departureIso: "",
    arrivalTime: arr,
    durationText: "",
    durationSeconds: seconds,
    headwaySeconds: null,
  };
}

function option(
  steps: Step[],
  leave: string,
  arrive: string,
  minutes: number,
): RouteItineraryOption {
  return {
    durationText: `${minutes} דקות`,
    durationSeconds: minutes * 60,
    distanceMeters: 0,
    fareText: "",
    leaveByText: leave,
    arriveByText: arrive,
    steps,
  };
}

const A = option(
  [walk(112), ride("23א", 402, "09:04", "09:11"), ride("25", 445, "09:20", "09:28"), walk(250)],
  "09:02",
  "09:30",
  30,
);
const B = option([walk(112), ride("23א", 147, "09:04", "09:06"), walk(1088)], "09:02", "09:23", 23);
const C = option([walk(700), ride("51", 360, "09:12", "09:18"), walk(260)], "09:00", "09:23", 23);

const lines = (opts: RouteItineraryOption[]) =>
  opts.map((opt) => opt.steps.filter((s) => s.travelMode === "TRANSIT").map((s) => s.line).join("+"));

describe("rankTripItineraries (product order)", () => {
  it("Ramon school: real no-transfer ride first; 2-min ride + 20-min walk last", () => {
    expect(lines(rankTripItineraries([A, B, C]))).toEqual(["51", "23א+25", "23א"]);
  });

  it("«ללא החלפה» subset (B, C) → C leads", () => {
    expect(lines(rankTripItineraries([B, C]))).toEqual(["51", "23א"]);
  });

  it("flags mostly-walking and counts transfers", () => {
    expect(itineraryMostlyWalking(B.steps)).toBe(true);
    expect(itineraryMostlyWalking(C.steps)).toBe(false);
    expect(itineraryTransferCount(A.steps)).toBe(1);
    expect(itineraryTransferCount(C.steps)).toBe(0);
  });

  it("same transfers → earlier arrival wins (depart-at ask)", () => {
    const late = option([walk(120), ride("1", 900, "09:05", "09:20"), walk(120)], "09:03", "09:24", 21);
    const early = option([walk(120), ride("2", 900, "09:10", "09:15"), walk(120)], "09:08", "09:19", 11);
    expect(lines(rankTripItineraries([late, early]))).toEqual(["2", "1"]);
  });

  it("arrive-by ask → latest leave wins among equals", () => {
    const leaveEarly = option([walk(120), ride("1", 600, "08:10", "08:20"), walk(60)], "08:08", "08:22", 14);
    const leaveLate = option([walk(120), ride("2", 600, "08:30", "08:40"), walk(60)], "08:28", "08:42", 14);
    expect(lines(rankTripItineraries([leaveEarly, leaveLate], "arrive"))).toEqual(["2", "1"]);
  });
});
