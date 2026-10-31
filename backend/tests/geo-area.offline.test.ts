/**
 * Generic geographic area geometry helpers — offline only.
 */
import { describe, expect, it } from "vitest";
import {
  bboxFromGeometry,
  geographicAreaFromViewportBox,
  isValidGeoAreaGeometry,
  POINT_IN_POLYGON_BOUNDARY,
  pointInAreaGeometry,
  polygonFromViewport,
  type GeoMultiPolygon,
  type GeoPolygon,
} from "../src/services/geo-area.js";
import {
  filterPlacesByAreaGeometry,
  type PlaceResult,
} from "../src/services/places.js";

/** Simple unit square polygon (lng/lat): [0,0]–[1,1]. */
const UNIT_SQUARE: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

/** Square with a hole; hole is [0.25,0.25]–[0.75,0.75]. */
const SQUARE_WITH_HOLE: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
    [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
      [0.25, 0.25],
    ],
  ],
};

const TWO_ISLANDS: GeoMultiPolygon = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    [
      [
        [10, 10],
        [11, 10],
        [11, 11],
        [10, 11],
        [10, 10],
      ],
    ],
  ],
};

describe("isValidGeoAreaGeometry / bbox", () => {
  it("accepts Polygon and MultiPolygon; rejects Point / open ring", () => {
    expect(isValidGeoAreaGeometry(UNIT_SQUARE)).toBe(true);
    expect(isValidGeoAreaGeometry(TWO_ISLANDS)).toBe(true);
    expect(
      isValidGeoAreaGeometry({ type: "Point", coordinates: [1, 2] }),
    ).toBe(false);
    expect(
      isValidGeoAreaGeometry({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      }),
    ).toBe(false);
  });

  it("bboxFromGeometry is tight (no padding)", () => {
    expect(bboxFromGeometry(UNIT_SQUARE)).toEqual({
      low: { lat: 0, lng: 0 },
      high: { lat: 1, lng: 1 },
    });
    expect(bboxFromGeometry(TWO_ISLANDS)).toEqual({
      low: { lat: 0, lng: 0 },
      high: { lat: 11, lng: 11 },
    });
  });

  it("polygonFromViewport builds a closed rectangle ring", () => {
    const poly = polygonFromViewport({
      low: { lat: 32.05, lng: 34.75 },
      high: { lat: 32.35, lng: 35.05 },
    });
    expect(poly?.type).toBe("Polygon");
    expect(poly?.coordinates[0]?.length).toBe(5);
    const area = geographicAreaFromViewportBox({
      label: "השרון",
      low: { lat: 32.05, lng: 34.75 },
      high: { lat: 32.35, lng: 35.05 },
      source: "geocode_viewport",
    });
    expect(area?.bbox.low).toEqual({ lat: 32.05, lng: 34.75 });
    expect(area?.source).toBe("geocode_viewport");
  });
});

describe("pointInAreaGeometry", () => {
  it("keeps interior; drops exterior; boundary is inside (closed)", () => {
    expect(pointInAreaGeometry(0.5, 0.5, UNIT_SQUARE)).toBe(true);
    expect(pointInAreaGeometry(2, 2, UNIT_SQUARE)).toBe(false);
    expect(pointInAreaGeometry(0, 0, UNIT_SQUARE)).toBe(true);
    expect(pointInAreaGeometry(1, 0.5, UNIT_SQUARE)).toBe(true);
  });

  it("excludes hole interior; MultiPolygon accepts either island", () => {
    expect(pointInAreaGeometry(0.5, 0.5, SQUARE_WITH_HOLE)).toBe(false);
    expect(pointInAreaGeometry(0.1, 0.1, SQUARE_WITH_HOLE)).toBe(true);
    expect(pointInAreaGeometry(0.5, 0.5, TWO_ISLANDS)).toBe(true);
    expect(pointInAreaGeometry(10.5, 10.5, TWO_ISLANDS)).toBe(true);
    expect(pointInAreaGeometry(5, 5, TWO_ISLANDS)).toBe(false);
  });
});

describe("filterPlacesByAreaGeometry (Places adapter)", () => {
  function row(
    id: string,
    lat: number | null,
    lng: number | null,
  ): PlaceResult {
    return {
      id,
      name: id,
      phone: "",
      address: "",
      postalCode: "",
      rating: null,
      openNow: null,
      weekdayHours: [],
      mapsUrl: "",
      lat,
      lng,
      parking: null,
      accessibility: null,
      outdoorSeating: null,
      goodForChildren: null,
      payment: null,
    };
  }

  it("keeps inside, drops outside / missing coords; invalid geom → all dropped", () => {
    const rows = [
      row("in", 0.5, 0.5),
      row("out", 2, 2),
      row("missing", null, null),
      row("edge", 0, 0),
    ];
    const { kept, dropped } = filterPlacesByAreaGeometry(rows, UNIT_SQUARE);
    expect(kept.map((r) => r.id).sort()).toEqual(["edge", "in"]);
    expect(dropped).toBe(2);

    const bad = filterPlacesByAreaGeometry(rows, {
      type: "Polygon",
      coordinates: [[[0, 0]]],
    } as unknown as GeoPolygon);
    expect(bad.kept).toEqual([]);
    expect(bad.dropped).toBe(4);
  });
});

/**
 * Focused PIP regression: controlled fixtures only (no live API).
 * Proves outside points are rejected and inside points are kept for both
 * Polygon and MultiPolygon — the Places area_restrict post-filter contract.
 */
describe("PIP regression: outside rejected, inside kept", () => {
  function row(
    id: string,
    lat: number | null,
    lng: number | null,
  ): PlaceResult {
    return {
      id,
      name: id,
      phone: "",
      address: "",
      postalCode: "",
      rating: null,
      openNow: null,
      weekdayHours: [],
      mapsUrl: "",
      lat,
      lng,
      parking: null,
      accessibility: null,
      outdoorSeating: null,
      goodForChildren: null,
      payment: null,
    };
  }

  it("Polygon: keeps interior, rejects exterior", () => {
    const { kept, dropped } = filterPlacesByAreaGeometry(
      [row("inside", 0.4, 0.4), row("outside", 9, 9)],
      UNIT_SQUARE,
    );
    expect(kept.map((r) => r.id)).toEqual(["inside"]);
    expect(dropped).toBe(1);
    expect(pointInAreaGeometry(0.4, 0.4, UNIT_SQUARE)).toBe(true);
    expect(pointInAreaGeometry(9, 9, UNIT_SQUARE)).toBe(false);
  });

  it("MultiPolygon: keeps point on either island, rejects between islands", () => {
    const { kept, dropped } = filterPlacesByAreaGeometry(
      [
        row("island-a", 0.5, 0.5),
        row("island-b", 10.5, 10.5),
        row("between", 5, 5),
      ],
      TWO_ISLANDS,
    );
    expect(kept.map((r) => r.id).sort()).toEqual(["island-a", "island-b"]);
    expect(dropped).toBe(1);
    expect(pointInAreaGeometry(5, 5, TWO_ISLANDS)).toBe(false);
  });

  it("boundary points count as inside (POINT_IN_POLYGON_BOUNDARY)", () => {
    expect(POINT_IN_POLYGON_BOUNDARY).toBe("inside");
    // Corner and mid-edge of UNIT_SQUARE [0,0]–[1,1].
    expect(pointInAreaGeometry(0, 0, UNIT_SQUARE)).toBe(true);
    expect(pointInAreaGeometry(0.5, 0, UNIT_SQUARE)).toBe(true);
    expect(pointInAreaGeometry(1, 1, UNIT_SQUARE)).toBe(true);
    const { kept, dropped } = filterPlacesByAreaGeometry(
      [row("corner", 0, 0), row("edge", 0.5, 0), row("out", 2, 2)],
      UNIT_SQUARE,
    );
    expect(kept.map((r) => r.id).sort()).toEqual(["corner", "edge"]);
    expect(dropped).toBe(1);
  });
});
