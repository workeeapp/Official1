import { describe, expect, it, vi } from "vitest";
import {
  enrichEmptyLocationLabels,
  reverseGeocodeLatLng,
} from "../src/services/reverse-geocode.js";
import {
  getPendingLocation,
  resetPendingLocations,
  setPendingLocation,
} from "../src/services/pending-location.js";
import { readInboundLocation } from "../src/services/whatsapp.service.js";

describe("reverse-geocode + pending pin", () => {
  it("fills empty name/address only and never changes lat/lng", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              name: "דיזנגוף",
              admin1: "תל אביב",
              country: "ישראל",
              latitude: 32.08,
              longitude: 34.78,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const enriched = await enrichEmptyLocationLabels(
      { lat: 32.08, lng: 34.78, name: "", address: "" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(enriched).toEqual({
      lat: 32.08,
      lng: 34.78,
      name: "דיזנגוף",
      address: "דיזנגוף, תל אביב, ישראל",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps existing labels and skips the network", async () => {
    const fetchImpl = vi.fn();
    const enriched = await enrichEmptyLocationLabels(
      { lat: 32.08, lng: 34.78, name: "בית", address: "" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(enriched.name).toBe("בית");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps coords-only pin when reverse geocode fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const bare = { lat: 32.08, lng: 34.78, name: "", address: "" };
    await expect(
      enrichEmptyLocationLabels(bare, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual(bare);
    await expect(
      reverseGeocodeLatLng(999, 34, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("setPendingLocation refuses out-of-range coords", () => {
    resetPendingLocations();
    setPendingLocation("emp-1", {
      lat: 91,
      lng: 34.8,
      name: "bad",
      address: "",
    });
    expect(getPendingLocation("emp-1")).toBeNull();
    setPendingLocation("emp-1", {
      lat: 32.08,
      lng: 34.78,
      name: "",
      address: "",
    });
    expect(getPendingLocation("emp-1")).toMatchObject({
      lat: 32.08,
      lng: 34.78,
    });
    resetPendingLocations();
  });

  it("readInboundLocation accepts in-range and rejects live_location / bad coords", () => {
    expect(
      readInboundLocation({
        type: "location",
        location: { latitude: "32.1", longitude: "34.8", name: "x" },
      }),
    ).toEqual({ lat: 32.1, lng: 34.8, name: "x", address: "" });
    expect(
      readInboundLocation({
        type: "location",
        location: { latitude: 32.1, longitude: 200 },
      }),
    ).toBeUndefined();
    expect(
      readInboundLocation({
        type: "live_location",
        location: { latitude: 32.1, longitude: 34.8 },
      }),
    ).toBeUndefined();
  });

  it("webhook extract → setPendingLocation stores the pin for later turns", () => {
    resetPendingLocations();
    const loc = readInboundLocation({
      type: "location",
      location: {
        latitude: 32.087,
        longitude: 34.887,
        name: "בית",
        address: "ז׳בוטינסקי 1",
      },
    });
    expect(loc).toBeTruthy();
    setPendingLocation("speaker-emp", loc!);
    expect(getPendingLocation("speaker-emp")).toMatchObject({
      lat: 32.087,
      lng: 34.887,
      name: "בית",
      address: "ז׳בוטינסקי 1",
    });
    resetPendingLocations();
  });
});
