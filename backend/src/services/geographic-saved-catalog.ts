/**
 * SavedLocationCatalog + SavedLocationReferenceProvider (Stage 2A).
 *
 * Matching is delegated entirely to saved-route-location (SRP):
 *   resolveSavedRoutePoint / matchSavedPlaceWithoutCoords.
 * No parallel matcher.
 */

import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import type {
  GeographicAsk,
  GeographicMatch,
  GeographicSavedRef,
} from "./geographic-match.js";
import {
  geographicAmbiguous,
  geographicNeedsClarify,
  geographicResolvedPoint,
} from "./geographic-match.js";
import type { GeographicProviderHit } from "./geographic-provider.js";
import {
  collectSavedPlacesWithoutCoords,
  collectSavedRouteLocationCandidates,
  formatSavedLabelMissingCoordsAsk,
  formatSavedRouteAmbiguousAsk,
  matchSavedPlaceWithoutCoords,
  resolveSavedRoutePoint,
  type SavedLocationContactRef,
  type SavedPlaceLabelOnly,
  type SavedRouteLocationCandidate,
} from "./saved-route-location.js";

export type SavedLocationCatalogRecord = {
  id: string;
  source: "filing" | "list" | "contact";
  listType?: string;
  label: string;
  coords?: { lat: number; lng: number };
  /** Best-effort text for later geocode when coords are missing. */
  addressText?: string;
};

export type SavedLocationCatalog = {
  withCoords: SavedLocationCatalogRecord[];
  withoutCoords: SavedLocationCatalogRecord[];
};

type Snapshot = Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined;

/**
 * Read-only catalog over the same rows SRP uses.
 * withCoords ← collectSavedRouteLocationCandidates
 * withoutCoords ← collectSavedPlacesWithoutCoords
 */
export function buildSavedLocationCatalog(
  snapshot: Snapshot,
  contacts?: SavedLocationContactRef[] | null,
): SavedLocationCatalog {
  const withCoords: SavedLocationCatalogRecord[] =
    collectSavedRouteLocationCandidates(snapshot, contacts).map(
      (c: SavedRouteLocationCandidate) => ({
        id: c.id,
        source: c.source,
        listType: c.listType,
        label: c.label,
        coords: { lat: c.lat, lng: c.lng },
      }),
    );

  const withoutCoords: SavedLocationCatalogRecord[] =
    collectSavedPlacesWithoutCoords(snapshot, contacts).map(
      (r: SavedPlaceLabelOnly) => ({
        id: r.id,
        source:
          r.listType === "filings"
            ? ("filing" as const)
            : r.listType === "contacts"
              ? ("contact" as const)
              : ("list" as const),
        listType: r.listType,
        label: r.label,
        addressText: addressTextForSavedLabelOnly(r, snapshot, contacts),
      }),
    );

  return { withCoords, withoutCoords };
}

/**
 * Geocode input: prefer SRP `addressText` (alias kept on `label`).
 * Fallback lookup only when older rows omitted addressText.
 */
function addressTextForSavedLabelOnly(
  row: SavedPlaceLabelOnly,
  snapshot: Snapshot,
  contacts?: SavedLocationContactRef[] | null,
): string {
  const fromRow = String(row.addressText ?? "").trim();
  if (fromRow) {
    return fromRow;
  }
  if (row.listType === "filings") {
    const filing = snapshot?.filing?.find(
      (f) => String(f.filing_id ?? "").trim() === row.id,
    );
    const info = String(filing?.item_info ?? "").trim();
    if (info) return info;
  }
  if (row.listType === "contacts") {
    const contact = (contacts ?? []).find(
      (c) => String(c.id ?? "").trim() === row.id,
    );
    const desc = String(contact?.description ?? "").trim();
    if (desc) return desc;
  }
  for (const list of snapshot?.lists ?? []) {
    for (const item of list.items ?? []) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = String(rec.item_id ?? rec.itemId ?? rec.id ?? "").trim();
      if (id !== row.id) continue;
      for (const key of ["כתובת", "מקום", "address", "location", "מיקום", "place"]) {
        const value = rec[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return row.label;
}

export type SavedLocationReferenceResult =
  | {
      status: "hit_coords";
      match: GeographicMatch;
      catalogRecord: SavedLocationCatalogRecord;
    }
  | {
      status: "hit_without_coords";
      savedRef: GeographicSavedRef;
      label: string;
      addressText: string;
      /** Pre-built clarify ask (RAL parity) — caller may geocode instead. */
      missingCoordsAskHe: string;
    }
  | { status: "ambiguous"; match: GeographicMatch }
  | { status: "none" };

function toSavedRef(
  id: string,
  source: GeographicSavedRef["source"],
  label: string,
  listType: string | undefined,
  hadCoordsAtResolve: boolean,
): GeographicSavedRef {
  return {
    id,
    source,
    label,
    hadCoordsAtResolve,
    ...(listType ? { listType } : {}),
  };
}

function sourceFromListType(
  listType: string | undefined,
): GeographicSavedRef["source"] {
  if (listType === "filings") return "filing";
  if (listType === "contacts") return "contact";
  return "list";
}

/**
 * Resolve ACTION place against saved places using SRP only.
 */
export function matchSavedLocationReference(input: {
  ask: GeographicAsk;
  snapshot: Snapshot;
  contacts?: SavedLocationContactRef[] | null;
}): SavedLocationReferenceResult {
  const asked = input.ask;
  const q =
    String(asked.savedRefHint?.id ?? "").trim() ||
    String(asked.rawText ?? "").trim();
  if (!q || q.toLowerCase() === "speaker") {
    return { status: "none" };
  }

  const withCoords = resolveSavedRoutePoint(
    q,
    input.snapshot,
    input.contacts,
  );
  if (withCoords.kind === "hit") {
    const savedRef = toSavedRef(
      withCoords.id,
      withCoords.source,
      withCoords.label,
      withCoords.listType,
      true,
    );
    const match = geographicResolvedPoint({
      asked,
      kind: "saved",
      labelHe: withCoords.label,
      provenance: "saved",
      coordinateProvenance: "saved",
      point: { lat: withCoords.lat, lng: withCoords.lng },
      savedRef,
    });
    return {
      status: "hit_coords",
      match,
      catalogRecord: {
        id: withCoords.id,
        source: withCoords.source,
        listType: withCoords.listType,
        label: withCoords.label,
        coords: { lat: withCoords.lat, lng: withCoords.lng },
      },
    };
  }
  if (withCoords.kind === "ambiguous") {
    return {
      status: "ambiguous",
      match: geographicAmbiguous({
        asked,
        kind: "saved",
        candidates: withCoords.options.map((o) => ({
          label: o.label,
          kind: "saved" as const,
          confidence: "medium" as const,
        })),
        userAskHe: formatSavedRouteAmbiguousAsk(q, withCoords.options),
      }),
    };
  }

  const noCoords = matchSavedPlaceWithoutCoords(
    q,
    input.snapshot,
    input.contacts,
  );
  if (noCoords.kind === "unique") {
    const row = noCoords.row;
    const source = sourceFromListType(row.listType);
    return {
      status: "hit_without_coords",
      savedRef: toSavedRef(row.id, source, row.label, row.listType, false),
      label: row.label,
      addressText: addressTextForSavedLabelOnly(
        row,
        input.snapshot,
        input.contacts,
      ),
      missingCoordsAskHe: formatSavedLabelMissingCoordsAsk(row.label),
    };
  }
  if (noCoords.kind === "ambiguous") {
    return {
      status: "ambiguous",
      match: geographicAmbiguous({
        asked,
        kind: "saved",
        candidates: noCoords.options.map((o) => ({
          label: o.label,
          kind: "saved" as const,
          confidence: "medium" as const,
        })),
        userAskHe: formatSavedRouteAmbiguousAsk(q, noCoords.options),
      }),
    };
  }

  return { status: "none" };
}

/** Apply a point-provider hit onto a saved row that lacked coords. */
export function attachGeocodeToSavedRef(input: {
  ask: GeographicAsk;
  savedRef: GeographicSavedRef;
  label: string;
  hit: GeographicProviderHit;
}): GeographicMatch {
  if (!input.hit.point) {
    return geographicNeedsClarify({
      asked: input.ask,
      kind: "saved",
      labelHe: input.label,
      userAskHe: formatSavedLabelMissingCoordsAsk(input.label),
      policyTrace: input.hit.policyTrace,
    });
  }
  return geographicResolvedPoint({
    asked: input.ask,
    kind: "saved",
    labelHe: input.label,
    provenance: "saved",
    coordinateProvenance: input.hit.provenance,
    point: input.hit.point,
    savedRef: {
      ...input.savedRef,
      hadCoordsAtResolve: false,
    },
    policyTrace: input.hit.policyTrace,
  });
}
