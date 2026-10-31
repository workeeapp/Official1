/**
 * Domain-agnostic geographic resolver core (Stage 2A).
 *
 * Order:
 * 1. PIN deixis + pending coords (session)
 * 2. SavedLocationReference (SRP) — coords / without-coords / ambiguous
 * 3. Provider ladder by geometryNeeds (index → google area → open-meteo point)
 *
 * Does not call LAST_LIVE. Does not contain if weather/places.
 */

import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import {
  geographicAmbiguous,
  geographicNeedsClarify,
  geographicResolvedPoint,
  geographicResolvedRegion,
  type GeographicAsk,
  type GeographicMatch,
} from "./geographic-match.js";
import {
  providerMatchesNeeds,
  type GeographicGeometryNeed,
  type GeographicProvider,
  type GeographicProviderHit,
} from "./geographic-provider.js";
import {
  attachGeocodeToSavedRef,
  matchSavedLocationReference,
} from "./geographic-saved-catalog.js";
import { googleGeocodeAreaProvider } from "./providers/google-geocode-area.provider.js";
import { localGeoAreaIndexProvider } from "./providers/local-geo-area-index.provider.js";
import { openMeteoPointProvider } from "./providers/open-meteo-point.provider.js";
import type { SavedLocationContactRef } from "./saved-route-location.js";
import type { PendingLocation } from "./pending-location.js";
import { fromPendingLocation } from "./resolved-location.js";

export type ResolveGeographicInput = {
  ask: GeographicAsk;
  geometryNeeds: GeographicGeometryNeed;
  /** WhatsApp pin — used only when deixis is pin and rawText empty (or speaker). */
  pending?: PendingLocation | null;
  snapshot?: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null;
  contacts?: SavedLocationContactRef[] | null;
  /**
   * When true (default), saved label without coords may be geocoded via a
   * point provider while preserving savedRef + coordinateProvenance.
   * When false, returns needs_clarify (RAL parity).
   */
  geocodeSavedWithoutCoords?: boolean;
  /**
   * When true, after pin/saved miss do not run the named-place provider ladder
   * (caller handles cities via a domain-specific path, e.g. Jewish geonameid).
   * Saved-without-coords geocode still uses point providers when enabled.
   */
  skipProviderLadder?: boolean;
  providers?: GeographicProvider[];
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
};

export function defaultGeographicProviders(): GeographicProvider[] {
  return [
    localGeoAreaIndexProvider,
    googleGeocodeAreaProvider,
    openMeteoPointProvider,
  ];
}

function hitToMatch(
  ask: GeographicAsk,
  hit: GeographicProviderHit,
): GeographicMatch {
  if (hit.candidates && hit.candidates.length > 1 && !hit.viewport && !hit.point) {
    return geographicAmbiguous({
      asked: ask,
      kind: hit.kind,
      candidates: hit.candidates,
      policyTrace: hit.policyTrace,
      userAskHe:
        hit.policyTrace && !/יחידה מינהלית|narrow_admin/i.test(hit.policyTrace)
          ? hit.policyTrace
          : `מצאתי כמה אפשרויות ל«${ask.rawText}». לאיזה התכוונת?`,
    });
  }
  if (hit.kind === "region" || hit.viewport || hit.polygon) {
    return geographicResolvedRegion({
      asked: ask,
      labelHe: hit.labelHe,
      confidence: hit.confidence,
      provenance: hit.provenance,
      coordinateProvenance: hit.provenance,
      viewport: hit.viewport,
      polygon: hit.polygon,
      point: hit.point,
      policyTrace: hit.policyTrace,
    });
  }
  if (hit.point) {
    return geographicResolvedPoint({
      asked: ask,
      kind: hit.kind === "city" || hit.kind === "poi" ? hit.kind : "point",
      labelHe: hit.labelHe,
      confidence: hit.confidence,
      provenance: hit.provenance,
      coordinateProvenance: hit.provenance,
      point: hit.point,
      policyTrace: hit.policyTrace,
    });
  }
  return geographicNeedsClarify({
    asked: ask,
    kind: hit.kind,
    labelHe: hit.labelHe,
    policyTrace: hit.policyTrace,
    userAskHe: `לא זיהיתי בוודאות את «${ask.rawText || hit.labelHe}». באיזו עיר או אזור מדויק יותר?`,
  });
}

async function runProviderLadder(
  ask: GeographicAsk,
  needs: GeographicGeometryNeed,
  providers: GeographicProvider[],
  fetchImpl?: typeof fetch,
  apiKey?: string | null,
): Promise<GeographicMatch | null> {
  const selected = providers.filter((p) => providerMatchesNeeds(p, needs));
  for (const provider of selected) {
    const hit = await provider.resolve(ask, {
      geometryNeeds: needs,
      fetchImpl,
      apiKey,
    });
    if (!hit) {
      continue;
    }
    return hitToMatch(ask, hit);
  }
  return null;
}

/**
 * Resolve a GeographicAsk to a GeographicMatch.
 * Additive API — domains are not wired in Stage 2A.
 */
export async function resolveGeographic(
  input: ResolveGeographicInput,
): Promise<GeographicMatch> {
  const ask = input.ask;
  const raw = String(ask.rawText ?? "").trim();
  const deixis = ask.deixis ?? "none";
  const geocodeSaved = input.geocodeSavedWithoutCoords !== false;
  const providers = input.providers ?? defaultGeographicProviders();
  const needs = input.geometryNeeds;

  // 1. PIN — only with pin deixis and empty / speaker place (explicit place wins).
  const pinDeixis =
    deixis === "pin" ||
    (raw === "" && ask.role === "near") ||
    raw.toLowerCase() === "speaker";
  if (pinDeixis && (!raw || raw.toLowerCase() === "speaker")) {
    const pin = fromPendingLocation(input.pending);
    if (pin) {
      return geographicResolvedPoint({
        asked: ask,
        kind: "pin",
        labelHe: pin.label,
        provenance: "whatsapp_pin",
        coordinateProvenance: "whatsapp_pin",
        point: { lat: pin.lat, lng: pin.lng },
      });
    }
    return geographicNeedsClarify({
      asked: ask,
      kind: "pin",
      userAskHe: "שלח מיקום בוואטסאפ (סיכת מיקום) ואז אבדוק שם.",
    });
  }

  // 2. Saved reference (SRP) when there is a place string.
  if (raw && raw.toLowerCase() !== "speaker") {
    const saved = matchSavedLocationReference({
      ask,
      snapshot: input.snapshot,
      contacts: input.contacts,
    });
    if (saved.status === "hit_coords") {
      return saved.match;
    }
    if (saved.status === "ambiguous") {
      return saved.match;
    }
    if (saved.status === "hit_without_coords") {
      if (geocodeSaved && needs.point) {
        const pointProviders = providers.filter((p) =>
          providerMatchesNeeds(p, { point: true }),
        );
        const geocodeAsk: GeographicAsk = {
          ...ask,
          rawText: saved.addressText || saved.label,
        };
        for (const provider of pointProviders) {
          const hit = await provider.resolve(geocodeAsk, {
            geometryNeeds: { point: true },
            fetchImpl: input.fetchImpl,
            apiKey: input.apiKey,
          });
          if (hit?.point) {
            return attachGeocodeToSavedRef({
              ask,
              savedRef: saved.savedRef,
              label: saved.label,
              hit,
            });
          }
        }
      }
      return geographicNeedsClarify({
        asked: ask,
        kind: "saved",
        labelHe: saved.label,
        userAskHe: saved.missingCoordsAskHe,
      });
    }
    // status none → fall through to named place / region providers
  }

  // 3. LAST_LIVE is never auto-applied (model must re-emit label).
  // 4. Provider ladder for named city / region (optional skip for domain fallthrough).
  if (raw) {
    if (input.skipProviderLadder) {
      return geographicNeedsClarify({
        asked: ask,
        kind: needs.area ? "region" : "point",
        labelHe: raw,
        policyTrace: "skip_provider_ladder",
        userAskHe: "",
      });
    }
    const fromProviders = await runProviderLadder(
      ask,
      needs,
      providers,
      input.fetchImpl,
      input.apiKey,
    );
    if (fromProviders) {
      return fromProviders;
    }
    return geographicNeedsClarify({
      asked: ask,
      kind: needs.area ? "region" : "point",
      labelHe: raw,
      userAskHe: `לא זיהיתי בוודאות את «${raw}». באיזו עיר או אזור מדויק יותר?`,
    });
  }

  return geographicNeedsClarify({
    asked: ask,
    userAskHe: "לאיזה מקום התכוונת?",
  });
}
