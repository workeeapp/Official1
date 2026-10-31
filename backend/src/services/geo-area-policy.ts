/**
 * Acceptance policy for geographic-area candidates (Google / index).
 * Multi-signal: types, name affinity, admin hierarchy, span suspicion, kind fit.
 * Viewport span 0.15° is a suspicion flag — never sole accept/reject.
 */

export type AreaCandidateKind =
  | "vernacular_region"
  | "admin_broad"
  | "admin_narrow"
  | "point_like"
  | "unknown";

export type NameAffinity =
  | "exact"
  | "strong"
  | "weak"
  | "contains_query_extra"
  | "none";

/** Degrees — suspicion only when combined with weak types/affinity. */
export const VIEWPORT_SPAN_SUSPICION_DEG = 0.15;

const POINT_LIKE_TYPES = new Set([
  "establishment",
  "premise",
  "subpremise",
  "street_address",
  "route",
  "intersection",
  "parking",
  "point_of_interest",
  "store",
  "food",
  "cafe",
  "restaurant",
]);

const ADMIN_BROAD_TYPES = new Set([
  "country",
  "administrative_area_level_1",
  "colloquial_area",
  "natural_feature", // only with adequate span + affinity (e.g. large desert)
]);

const ADMIN_NARROW_TYPES = new Set([
  "administrative_area_level_2",
  "administrative_area_level_3",
  "administrative_area_level_4",
  "administrative_area_level_5",
  "locality",
  "sublocality",
  "sublocality_level_1",
  "postal_town",
  "neighborhood",
]);

export function normalizePlaceQuery(value: string): string {
  return String(value ?? "")
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Name affinity between query and candidate label(s).
 * Rejects «רמת השרון» for query «השרון» (candidate longer, contains query + extra).
 */
export function scoreNameAffinity(
  query: string,
  candidateNames: string[],
): NameAffinity {
  const q = normalizePlaceQuery(query);
  if (!q) return "none";
  let best: NameAffinity = "none";
  const rank: Record<NameAffinity, number> = {
    exact: 4,
    strong: 3,
    weak: 2,
    contains_query_extra: 1,
    none: 0,
  };
  for (const raw of candidateNames) {
    const full = normalizePlaceQuery(raw);
    if (!full) continue;
    // Address-style "Name, Country" → compare primary label.
    const primary = full.split(",")[0]?.trim() || full;
    for (const c of [full, primary]) {
      let hit: NameAffinity = "none";
      if (c === q) {
        hit = "exact";
      } else if (c.startsWith(`${q} `) || q.startsWith(`${c} `)) {
        const longer = c.length >= q.length ? c : q;
        const shorter = c.length >= q.length ? q : c;
        const rest = longer.slice(shorter.length).trim();
        if (
          !rest ||
          /^(desert|plain|region|area|district|מחוז|מדבר)\b/i.test(rest)
        ) {
          hit = "strong";
        } else {
          hit = "weak";
        }
      } else if (c.endsWith(` ${q}`) || c.endsWith(`-${q}`)) {
        // e.g. "Negev Desert" already handled; "Ramat HaSharon" style:
        hit = "contains_query_extra";
      } else if (c.includes(q) && c.length > q.length + 1) {
        // Candidate contains query with extra material (רמת השרון ⊃ השרון).
        hit = "contains_query_extra";
      } else if (q.includes(c) && q.length > c.length + 1) {
        hit = "weak";
      }
      if (rank[hit] > rank[best]) best = hit;
    }
  }
  return best;
}

export function classifyGoogleTypes(types: string[] | undefined): AreaCandidateKind {
  const t = (types ?? []).map((x) => String(x).toLowerCase());
  if (t.some((x) => POINT_LIKE_TYPES.has(x))) {
    return "point_like";
  }
  if (t.includes("country") || t.includes("administrative_area_level_1")) {
    return "admin_broad";
  }
  if (t.includes("colloquial_area")) {
    return "vernacular_region";
  }
  if (t.includes("natural_feature")) {
    // Size/affinity decide later — classify as vernacular physical by default.
    return "vernacular_region";
  }
  if (t.some((x) => ADMIN_NARROW_TYPES.has(x))) {
    return "admin_narrow";
  }
  if (t.some((x) => ADMIN_BROAD_TYPES.has(x))) {
    return "admin_broad";
  }
  return "unknown";
}

export function viewportSpanDegrees(box: {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
}): { spanLat: number; spanLng: number; maxSpan: number } {
  const spanLat = Math.abs(box.high.lat - box.low.lat);
  const spanLng = Math.abs(box.high.lng - box.low.lng);
  return { spanLat, spanLng, maxSpan: Math.max(spanLat, spanLng) };
}

export type GoogleAcceptInput = {
  query: string;
  formattedAddress?: string;
  types?: string[];
  partialMatch?: boolean;
  viewport: {
    low: { lat: number; lng: number };
    high: { lat: number; lng: number };
  };
};

export type GoogleAcceptDecision =
  | { ok: true; kind: AreaCandidateKind; affinity: NameAffinity; suspicion: string[] }
  | {
      ok: false;
      reason: "partial" | "point_like" | "narrow_admin" | "weak_affinity" | "unreliable";
      kind: AreaCandidateKind;
      affinity: NameAffinity;
      suspicion: string[];
      messageHe: string;
    };

/**
 * Multi-signal Google viewport accept for area_restrict.
 * Small span alone does not reject; large span alone does not accept.
 */
export function decideGoogleAreaCandidate(
  input: GoogleAcceptInput,
): GoogleAcceptDecision {
  const suspicion: string[] = [];
  const addr = String(input.formattedAddress ?? "");
  const bestAffinity = scoreNameAffinity(input.query, [
    addr,
    addr.split(",")[0] ?? "",
  ]);

  if (input.partialMatch) {
    return {
      ok: false,
      reason: "partial",
      kind: "unknown",
      affinity: bestAffinity,
      suspicion,
      messageHe: `לא בטוח שזיהיתי נכון את «${input.query}». אפשר לציין אזור או עיר מדויקים יותר?`,
    };
  }

  const kind = classifyGoogleTypes(input.types);
  const { maxSpan } = viewportSpanDegrees(input.viewport);
  if (maxSpan < VIEWPORT_SPAN_SUSPICION_DEG) {
    suspicion.push(`small_viewport_span:${maxSpan.toFixed(4)}`);
  }

  if (kind === "point_like") {
    return {
      ok: false,
      reason: "point_like",
      kind,
      affinity: bestAffinity,
      suspicion,
      messageHe: `«${input.query}» זוהה כמקום נקודתי, לא כאזור. נסח אזור רחב יותר או שם מדויק.`,
    };
  }

  if (bestAffinity === "contains_query_extra" || bestAffinity === "none") {
    return {
      ok: false,
      reason: "weak_affinity",
      kind,
      affinity: bestAffinity,
      suspicion,
      messageHe: `לא בטוח שההתאמה ל«${input.query}» נכונה. לאיזה אזור התכוונת?`,
    };
  }

  if (kind === "admin_narrow") {
    // Narrow admin only if exact/strong name match (user named that unit).
    if (bestAffinity !== "exact" && bestAffinity !== "strong") {
      return {
        ok: false,
        reason: "narrow_admin",
        kind,
        affinity: bestAffinity,
        suspicion,
        messageHe: `מצאתי יחידה מינהלית צרה ל«${input.query}». אם זה האזור שרצית — ציין את שמו המלא; אחרת נסח מחדש.`,
      };
    }
  }

  const types = (input.types ?? []).map((x) => String(x).toLowerCase());
  const hasTypedAdminHierarchy =
    types.includes("country") ||
    types.includes("administrative_area_level_1") ||
    types.includes("administrative_area_level_2") ||
    types.includes("administrative_area_level_3") ||
    types.includes("administrative_area_level_4") ||
    types.includes("administrative_area_level_5") ||
    types.includes("locality") ||
    types.includes("postal_town") ||
    types.includes("colloquial_area");

  /**
   * Tiny viewport is an independent reliability signal — not gated on
   * natural_feature/establishment. Empty/missing types cannot slip through
   * just because the label matches (live Negev / types=[] failure class).
   *
   * Small but legitimate admin/locality units with typed hierarchy + strong
   * name affinity may still pass (threshold is not a blanket reject).
   */
  if (maxSpan < VIEWPORT_SPAN_SUSPICION_DEG) {
    const tinyJustified =
      (kind === "admin_narrow" ||
        kind === "admin_broad" ||
        kind === "vernacular_region") &&
      hasTypedAdminHierarchy &&
      (bestAffinity === "exact" || bestAffinity === "strong") &&
      // Physical postage-stamp features are never "small admin".
      !types.includes("natural_feature") &&
      !types.includes("establishment");

    if (!tinyJustified) {
      suspicion.push("tiny_viewport_unjustified");
      return {
        ok: false,
        reason: "unreliable",
        kind,
        affinity: bestAffinity,
        suspicion,
        messageHe: `הגבול שחזר עבור «${input.query}» קטן מדי או לא אמין לאזור חיפוש. נסה שם אזור אחר או ניסוח מדויק יותר.`,
      };
    }
  }

  if (kind === "unknown" && bestAffinity === "weak") {
    return {
      ok: false,
      reason: "unreliable",
      kind,
      affinity: bestAffinity,
      suspicion,
      messageHe: `לא זיהיתי בוודאות את האזור «${input.query}». אפשר לנסח מחדש?`,
    };
  }

  return {
    ok: true,
    kind: kind === "unknown" ? "admin_broad" : kind,
    affinity: bestAffinity,
    suspicion,
  };
}

export type IndexMatchDecision =
  | { status: "resolved"; featureIds: string[] }
  | { status: "ambiguous"; featureIds: string[] }
  | { status: "unresolved" };

/**
 * Index hit policy: exact/strong name only; multiple strong hits → ambiguous.
 */
export function decideIndexMatches(
  query: string,
  features: Array<{ id: string; names: string[] }>,
): IndexMatchDecision {
  const strong: string[] = [];
  for (const f of features) {
    const aff = scoreNameAffinity(query, f.names);
    if (aff === "exact" || aff === "strong") {
      strong.push(f.id);
    }
  }
  if (strong.length === 1) {
    return { status: "resolved", featureIds: strong };
  }
  if (strong.length > 1) {
    return { status: "ambiguous", featureIds: strong };
  }
  return { status: "unresolved" };
}
