/**
 * B2a: Google Geocoding viewport helper — fail-closed, no live calls.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolvePlaceViewport,
} from "../src/services/geocode-viewport.js";
import { isValidViewport } from "../src/services/resolved-location.js";

const SHARON_VIEWPORT = {
  southwest: { lat: 32.05, lng: 34.75 },
  northeast: { lat: 32.35, lng: 35.05 },
};

function geocodeFetch(
  payload: Record<string, unknown>,
  opts?: { ok?: boolean; status?: number },
) {
  return vi.fn(async () => {
    return {
      ok: opts?.ok ?? true,
      status: opts?.status ?? 200,
      json: async () => payload,
    } as Response;
  });
}

describe("isValidViewport", () => {
  it("accepts a positive SW–NE span and rejects inverted / empty / out-of-range", () => {
    expect(
      isValidViewport({
        low: { lat: 32.05, lng: 34.75 },
        high: { lat: 32.35, lng: 35.05 },
      }),
    ).toBe(true);
    expect(
      isValidViewport({
        low: { lat: 32.35, lng: 34.75 },
        high: { lat: 32.05, lng: 35.05 },
      }),
    ).toBe(false);
    expect(
      isValidViewport({
        low: { lat: 32.1, lng: 34.8 },
        high: { lat: 32.1, lng: 34.8 },
      }),
    ).toBe(false);
    expect(
      isValidViewport({
        low: { lat: 91, lng: 34 },
        high: { lat: 92, lng: 35 },
      }),
    ).toBe(false);
    expect(
      isValidViewport({
        low: { lat: 10, lng: -170 },
        high: { lat: 20, lng: 170 },
      }),
    ).toBe(false);
  });
});

describe("resolvePlaceViewport (offline)", () => {
  it("single clear hit → viewport", async () => {
    const fetchImpl = geocodeFetch({
      status: "OK",
      results: [
        {
          formatted_address: "השרון, ישראל",
          partial_match: false,
          types: ["administrative_area_level_2", "political"],
          geometry: { viewport: SHARON_VIEWPORT },
        },
      ],
    });
    const out = await resolvePlaceViewport({
      place: "השרון",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.viewport.low).toEqual({ lat: 32.05, lng: 34.75 });
    expect(out.viewport.high).toEqual({ lat: 32.35, lng: 35.05 });
    expect(out.viewport.source).toBe("geocode_viewport");
    expect(out.viewport.geometry?.type).toBe("Polygon");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("maps.googleapis.com/maps/api/geocode/json");
    expect(url).toContain("language=he");
    expect(url).toContain("region=il");
  });

  it("ZERO_RESULTS → fail closed (none)", async () => {
    const out = await resolvePlaceViewport({
      place: "אזור שלא קיים",
      apiKey: "test-key",
      fetchImpl: geocodeFetch({ status: "ZERO_RESULTS", results: [] }) as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("none");
    expect(out.messageHe.length).toBeGreaterThan(0);
  });

  it("multiple results → ambiguous fail closed", async () => {
    const out = await resolvePlaceViewport({
      place: "שרון",
      apiKey: "test-key",
      fetchImpl: geocodeFetch({
        status: "OK",
        results: [
          {
            formatted_address: "השרון, ישראל",
            geometry: { viewport: SHARON_VIEWPORT },
          },
          {
            formatted_address: "Sharon, PA, USA",
            geometry: {
              viewport: {
                southwest: { lat: 41.2, lng: -80.4 },
                northeast: { lat: 41.3, lng: -80.3 },
              },
            },
          },
        ],
      }) as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("ambiguous");
  });

  it("partial_match → ambiguous fail closed", async () => {
    const out = await resolvePlaceViewport({
      place: "השרו",
      apiKey: "test-key",
      fetchImpl: geocodeFetch({
        status: "OK",
        results: [
          {
            formatted_address: "השרון",
            partial_match: true,
            geometry: { viewport: SHARON_VIEWPORT },
          },
        ],
      }) as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("ambiguous");
  });

  it("invalid inverted viewport → fail closed", async () => {
    const out = await resolvePlaceViewport({
      place: "השרון",
      apiKey: "test-key",
      fetchImpl: geocodeFetch({
        status: "OK",
        results: [
          {
            formatted_address: "השרון",
            geometry: {
              viewport: {
                southwest: { lat: 32.35, lng: 34.75 },
                northeast: { lat: 32.05, lng: 35.05 },
              },
            },
          },
        ],
      }) as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("invalid");
  });

  it("missing API key → missing_key (no fetch) when Nominatim disabled", async () => {
    const fetchImpl = geocodeFetch({ status: "OK", results: [] });
    const out = await resolvePlaceViewport({
      place: "השרון",
      apiKey: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("missing_key");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("HTTP !ok → error fail closed", async () => {
    const out = await resolvePlaceViewport({
      place: "השרון",
      apiKey: "test-key",
      fetchImpl: geocodeFetch({}, { ok: false, status: 500 }) as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("error");
  });

  it("network throw → error fail closed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await resolvePlaceViewport({
      place: "השרון",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowNominatimFallback: false,
      allowIndexLookup: false,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("error");
  });
});
