/**
 * Optional reverse geocode for WhatsApp pins that arrive without name/address.
 * Never invents or overwrites coordinates — only fills empty labels.
 * Failures are silent: callers keep the coords-only pin.
 */

import { parseCoordinatePair } from "./resolved-location.js";

const REVERSE_URL = "https://geocoding-api.open-meteo.com/v1/reverse";

export type ReverseGeocodeLabels = {
  name: string;
  address: string;
};

type ReverseResponse = {
  results?: Array<{
    name?: string;
    admin1?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  }>;
};

/**
 * Look up display labels for lat/lng. Returns null on any failure / empty hit.
 */
export async function reverseGeocodeLatLng(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ReverseGeocodeLabels | null> {
  const pair = parseCoordinatePair(lat, lng);
  if (!pair) {
    return null;
  }
  const url = new URL(REVERSE_URL);
  url.searchParams.set("latitude", String(pair.lat));
  url.searchParams.set("longitude", String(pair.lng));
  url.searchParams.set("language", "he");
  url.searchParams.set("count", "1");
  try {
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as ReverseResponse;
    const row = body.results?.[0];
    if (!row) {
      return null;
    }
    const name = String(row.name ?? "").trim();
    const address = [row.name, row.admin1, row.country]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(", ");
    if (!name && !address) {
      return null;
    }
    return { name: name || address, address: address || name };
  } catch {
    return null;
  }
}

/**
 * Fill empty name/address only. Lat/lng are never replaced.
 */
export async function enrichEmptyLocationLabels<
  T extends { lat: number; lng: number; name: string; address: string },
>(loc: T, fetchImpl: typeof fetch = fetch): Promise<T> {
  if (loc.name.trim() || loc.address.trim()) {
    return loc;
  }
  const labels = await reverseGeocodeLatLng(loc.lat, loc.lng, fetchImpl);
  if (!labels) {
    return loc;
  }
  return {
    ...loc,
    name: labels.name,
    address: labels.address,
  };
}
