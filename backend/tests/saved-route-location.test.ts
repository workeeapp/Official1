import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  collectAddressLikeFilingsWithoutCoords,
  collectSavedRouteLocationCandidates,
  matchAddressLikeFilingWithoutCoords,
  resolveSavedRoutePoint,
} from "../src/services/saved-route-location.js";

const baseFiling = (
  overrides: Partial<EmployeeRecordSnapshot["filing"][number]> & {
    filing_id: string;
    item_name: string;
    item_info: string;
  },
): EmployeeRecordSnapshot["filing"][number] => ({
  item_description: "",
  owner: "טל",
  scope: "personal",
  ...overrides,
});

describe("collectSavedRouteLocationCandidates", () => {
  it("collects filings and list items with valid lat,lng only", () => {
    const snapshot: EmployeeRecordSnapshot = {
      filing: [
        baseFiling({
          filing_id: "f-home",
          item_name: "מיקום הבית",
          item_info: "32.099279, 34.8923104",
          item_description: "מיקום הבית שנשלח בוואטסאפ",
        }),
        baseFiling({
          filing_id: "f-street",
          item_name: "כתובת דואר",
          item_info: "הרצל 1 תל אביב",
        }),
      ],
      lists: [
        {
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t-office",
              "שם מטלה": "העבודה",
              מקום: "32.085, 34.781",
            },
            {
              item_id: "t-chore",
              "שם מטלה": "לקנות חלב",
              מקום: "סופר ליד הבית",
            },
          ],
        },
        {
          list_type: "custom",
          list_name: "מקומות",
          owner: "טל",
          scope: "personal",
          columns: ["שם", "נקודה"],
          title_field: "שם",
          items: [
            {
              item_id: "c-gym",
              שם: "החדר כושר",
              נקודה: "32.07, 34.79",
            },
          ],
        },
      ],
    };
    const rows = collectSavedRouteLocationCandidates(snapshot);
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["c-gym", "f-home", "t-office"].sort(),
    );
    expect(rows.find((r) => r.id === "f-home")?.label).toBe("מיקום הבית");
    expect(rows.find((r) => r.id === "t-office")?.label).toBe("העבודה");
    expect(rows.find((r) => r.id === "c-gym")?.label).toBe("החדר כושר");
    expect(rows.every((r) => Number.isFinite(r.lat) && Math.abs(r.lat) <= 90)).toBe(
      true,
    );
  });

  it("rejects out-of-range coordinates", () => {
    const snapshot: EmployeeRecordSnapshot = {
      filing: [
        baseFiling({
          filing_id: "bad",
          item_name: "שגוי",
          item_info: "99.0, 34.0",
        }),
      ],
      lists: [],
    };
    expect(collectSavedRouteLocationCandidates(snapshot)).toEqual([]);
  });
});

describe("resolveSavedRoutePoint", () => {
  const snapshot: EmployeeRecordSnapshot = {
    filing: [
      baseFiling({
        filing_id: "f-home",
        item_name: "מיקום הבית",
        item_info: "32.099279, 34.8923104",
      }),
      baseFiling({
        filing_id: "f-parents",
        item_name: "בית הורים",
        item_info: "32.05, 34.75",
      }),
    ],
    lists: [
      {
        list_type: "tasks",
        owner: "טל",
        scope: "personal",
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
        scope: "personal",
        columns: ["שם", "נקודה"],
        title_field: "שם",
        items: [{ item_id: "c-mall", שם: "הקניון", נקודה: "32.08, 34.80" }],
      },
    ],
  };

  it("matches exact opaque id", () => {
    const hit = resolveSavedRoutePoint("f-home", snapshot);
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.lat).toBeCloseTo(32.099279);
    expect(hit.label).toBe("מיקום הבית");
  });

  it("matches exact normalized full label", () => {
    const hit = resolveSavedRoutePoint("העבודה", snapshot);
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.id).toBe("t-work");
  });

  it("asks when several labels uniquely soft-match the same query", () => {
    const amb = resolveSavedRoutePoint("בית", snapshot);
    expect(amb.kind).toBe("ambiguous");
    if (amb.kind !== "ambiguous") return;
    expect(amb.options.length).toBeGreaterThanOrEqual(2);
  });

  it("unique soft match for custom label fragment", () => {
    const hit = resolveSavedRoutePoint("קניון", snapshot);
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.id).toBe("c-mall");
  });

  it("never resolves speaker via saved places", () => {
    expect(resolveSavedRoutePoint("speaker", snapshot).kind).toBe("none");
  });

  it("returns none for free-text with no saved coords match", () => {
    expect(resolveSavedRoutePoint("דיזנגוף סנטר", snapshot).kind).toBe("none");
  });
});

describe("address-like filing without coords", () => {
  it("collects address-like filings that lack valid lat,lng", () => {
    const snapshot: EmployeeRecordSnapshot = {
      filing: [
        baseFiling({
          filing_id: "f-home",
          item_name: "מיקום הבית",
          item_info: "הרצל 1",
        }),
        baseFiling({
          filing_id: "f-note",
          item_name: "הערה",
          item_info: "בלי מיקום",
        }),
        baseFiling({
          filing_id: "f-coords",
          item_name: "מיקום העבודה",
          item_info: "32.08, 34.78",
        }),
      ],
      lists: [],
    };
    const rows = collectAddressLikeFilingsWithoutCoords(snapshot);
    expect(rows.map((r) => r.id)).toEqual(["f-home"]);
  });

  it("matches label without inventing coordinates", () => {
    const snapshot: EmployeeRecordSnapshot = {
      filing: [
        baseFiling({
          filing_id: "f-home",
          item_name: "מיקום הבית",
          item_info: "הרצל 1 תל אביב",
        }),
      ],
      lists: [],
    };
    expect(resolveSavedRoutePoint("מיקום הבית", snapshot).kind).toBe("none");
    const match = matchAddressLikeFilingWithoutCoords("מיקום הבית", snapshot);
    expect(match.kind).toBe("unique");
    if (match.kind !== "unique") return;
    expect(match.row.label).toBe("מיקום הבית");
  });
});
