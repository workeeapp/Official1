/**
 * Resolve routes origin/destination against saved items that already carry
 * valid lat,lng in EMPLOYEE_SAVED_DATA (filings + every list). No parallel store.
 * Matching uses the ACTION string only — never the raw user utterance.
 *
 * Live weather/places also reuse this matcher via resolveActionLocation.
 * Address-like filings without valid coords are detected separately so those
 * labels are never geocoded as city names.
 */
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import {
  filingNameLooksLikeAddress,
  parseLatLngCoordinates,
  resolveCustomTitleField,
} from "./show-button-dump.js";

export type SavedRoutePointHit = {
  kind: "hit";
  lat: number;
  lng: number;
  label: string;
  id: string;
  source: "filing" | "list";
  listType?: string;
};

export type SavedRoutePointAmbiguous = {
  kind: "ambiguous";
  options: Array<{ id: string; label: string; listType?: string }>;
};

export type SavedRoutePointNone = { kind: "none" };

export type SavedRoutePointResult =
  | SavedRoutePointHit
  | SavedRoutePointAmbiguous
  | SavedRoutePointNone;

export type SavedRouteLocationCandidate = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  source: "filing" | "list";
  listType?: string;
};

const LIST_TITLE_KEYS: Record<string, string[]> = {
  shopping: ["שם פריט", "name", "item_name"],
  tasks: ["שם מטלה", "name", "task", "item_name"],
  contacts: ["שם פרטי", "first_name", "name"],
};

/** Skip metadata / non-place structural keys when scanning for coordinate strings. */
const COORD_SCAN_SKIP_KEYS = new Set([
  "item_id",
  "itemId",
  "filing_id",
  "filingId",
  "scope",
  "owner",
  "urgency",
  "shared_with",
  "assigned_by",
  "attachments",
  "linked_lists",
  "linked_from_items",
  "reminder",
  "חוזר",
  "recurrence_text",
  "תאריך לביצוע",
  "שעה לביצוע",
  "תאריך סיום",
  "שעת סיום",
  "next_occurrences",
  "done_dates",
  "exceptions",
  "יום בשבוע",
  "יום בשבוע סיום",
  "כמות",
  "quantity",
  "qty",
  "יחידת מידה",
  "unit",
  "יחידה",
]);

function readTrimmed(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[הה]\s+/u, "")
    .replace(/^ה/u, "");
}

function firstCoordsInItem(item: Record<string, unknown>): {
  lat: number;
  lng: number;
} | null {
  for (const [key, value] of Object.entries(item)) {
    if (COORD_SCAN_SKIP_KEYS.has(key)) {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const parsed = parseLatLngCoordinates(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function listItemLabel(
  listType: string,
  item: Record<string, unknown>,
  titleField?: string,
  columns?: string[],
): string {
  if (listType === "contacts") {
    const first = readTrimmed(item, LIST_TITLE_KEYS.contacts);
    const last = readTrimmed(item, ["שם משפחה", "last_name", "surname"]);
    return [first, last].filter(Boolean).join(" ");
  }
  if (listType === "custom") {
    const field = resolveCustomTitleField(item, titleField, columns);
    if (field) {
      const named = readTrimmed(item, [field]);
      if (named && !parseLatLngCoordinates(named)) {
        return named;
      }
    }
    for (const [key, value] of Object.entries(item)) {
      if (COORD_SCAN_SKIP_KEYS.has(key)) {
        continue;
      }
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      if (parseLatLngCoordinates(value)) {
        continue;
      }
      return value.trim();
    }
    return "";
  }
  const keys = LIST_TITLE_KEYS[listType] ?? [];
  return keys.length > 0 ? readTrimmed(item, keys) : "";
}

function filingCoords(
  row: EmployeeRecordSnapshot["filing"][number],
): { lat: number; lng: number } | null {
  for (const raw of [row.item_info, row.item_description, row.item_name]) {
    const text = String(raw ?? "").trim();
    if (!text) {
      continue;
    }
    const parsed = parseLatLngCoordinates(text);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/**
 * All saved rows that already store a valid lat,lng string.
 * Filings + every list type (shopping / tasks / contacts / custom).
 */
export function collectSavedRouteLocationCandidates(
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
): SavedRouteLocationCandidate[] {
  if (!snapshot) {
    return [];
  }
  const out: SavedRouteLocationCandidate[] = [];
  const seenIds = new Set<string>();

  for (const row of snapshot.filing ?? []) {
    const id = String(row.filing_id ?? "").trim();
    const coords = filingCoords(row);
    if (!id || !coords) {
      continue;
    }
    const label = String(row.item_name ?? "").trim() || id;
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    out.push({
      id,
      label,
      lat: coords.lat,
      lng: coords.lng,
      source: "filing",
      listType: "filings",
    });
  }

  for (const list of snapshot.lists ?? []) {
    const listType = String(list.list_type ?? "").trim() || "custom";
    for (const item of list.items ?? []) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const id = readTrimmed(item as Record<string, unknown>, [
        "item_id",
        "itemId",
        "id",
      ]);
      const coords = firstCoordsInItem(item as Record<string, unknown>);
      if (!id || !coords) {
        continue;
      }
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      const label =
        listItemLabel(
          listType,
          item as Record<string, unknown>,
          list.title_field,
          list.columns,
        ) || id;
      out.push({
        id,
        label,
        lat: coords.lat,
        lng: coords.lng,
        source: "list",
        listType,
      });
    }
  }

  return out;
}

function toHit(c: SavedRouteLocationCandidate): SavedRoutePointHit {
  return {
    kind: "hit",
    lat: c.lat,
    lng: c.lng,
    label: c.label,
    id: c.id,
    source: c.source,
    listType: c.listType,
  };
}

function toAmbiguous(
  rows: SavedRouteLocationCandidate[],
): SavedRoutePointAmbiguous {
  return {
    kind: "ambiguous",
    options: rows.map((row) => ({
      id: row.id,
      label: row.label,
      listType: row.listType,
    })),
  };
}

/**
 * Match an ACTION origin/destination string to a saved coordinate row.
 * Order: exact opaque id → exact normalized full label → unique soft match.
 * Never picks arbitrarily when several candidates match.
 */
export function resolveSavedRoutePoint(
  query: string,
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
): SavedRoutePointResult {
  const q = String(query ?? "").trim();
  if (!q || q.toLowerCase() === "speaker") {
    return { kind: "none" };
  }
  const candidates = collectSavedRouteLocationCandidates(snapshot);
  if (candidates.length === 0) {
    return { kind: "none" };
  }

  const byId = candidates.filter((c) => c.id === q);
  if (byId.length === 1) {
    return toHit(byId[0]!);
  }
  if (byId.length > 1) {
    return toAmbiguous(byId);
  }

  const qNorm = normalizeLabel(q);
  if (!qNorm) {
    return { kind: "none" };
  }

  const byExactLabel = candidates.filter(
    (c) => normalizeLabel(c.label) === qNorm,
  );
  if (byExactLabel.length === 1) {
    return toHit(byExactLabel[0]!);
  }
  if (byExactLabel.length > 1) {
    return toAmbiguous(byExactLabel);
  }

  // Unique identifying match: query is a contiguous part of the label (or
  // vice versa). Never pick when more than one candidate qualifies.
  if (qNorm.length < 2) {
    return { kind: "none" };
  }
  const unique = candidates.filter((c) => {
    const labelNorm = normalizeLabel(c.label);
    if (labelNorm.length < 2) {
      return false;
    }
    return labelNorm.includes(qNorm) || qNorm.includes(labelNorm);
  });
  if (unique.length === 1) {
    return toHit(unique[0]!);
  }
  if (unique.length > 1) {
    return toAmbiguous(unique);
  }
  return { kind: "none" };
}

/** Hebrew ask when several saved places match the ACTION string. */
export function formatSavedRouteAmbiguousAsk(
  query: string,
  options: SavedRoutePointAmbiguous["options"],
): string {
  const q = query.trim() || "המיקום";
  const lines = options.map((opt, i) => {
    const kind =
      opt.listType === "filings"
        ? "תיוק"
        : opt.listType === "tasks"
          ? "מטלות"
          : opt.listType === "shopping"
            ? "קניות"
            : opt.listType === "contacts"
              ? "אנשי קשר"
              : opt.listType === "custom"
                ? "רשימה"
                : "שמור";
    return `${i + 1}. ${opt.label} (${kind})`;
  });
  return `מצאתי כמה מיקומים שמורים ל«${q}». לאיזה התכוונת?\n${lines.join("\n")}`;
}

export function formatSavedRouteNotice(label: string): string {
  const trimmed = label.trim();
  return trimmed
    ? `משתמש במיקום השמור «${trimmed}».`
    : "משתמש במיקום השמור.";
}

/** Address-like filing row that has a label but no valid lat,lng. */
export type SavedPlaceLabelOnly = {
  id: string;
  label: string;
  listType: "filings";
};

/**
 * Filings whose name looks like a place/address but item fields have no
 * valid lat,lng. Used so ACTION place «מיקום הבית» without coords asks
 * instead of geocoding the label as a city.
 */
export function collectAddressLikeFilingsWithoutCoords(
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
): SavedPlaceLabelOnly[] {
  if (!snapshot) {
    return [];
  }
  const out: SavedPlaceLabelOnly[] = [];
  const seenIds = new Set<string>();
  for (const row of snapshot.filing ?? []) {
    const id = String(row.filing_id ?? "").trim();
    const label = String(row.item_name ?? "").trim();
    if (!id || !label || seenIds.has(id)) {
      continue;
    }
    if (!filingNameLooksLikeAddress(label)) {
      continue;
    }
    if (filingCoords(row)) {
      continue;
    }
    seenIds.add(id);
    out.push({ id, label, listType: "filings" });
  }
  return out;
}

export type SavedPlaceLabelMatch =
  | { kind: "unique"; row: SavedPlaceLabelOnly }
  | {
      kind: "ambiguous";
      options: Array<{ id: string; label: string; listType?: string }>;
    }
  | { kind: "none" };

/**
 * Match ACTION place against address-like filings that lack coordinates.
 * Same id / exact label / unique soft rules as resolveSavedRoutePoint.
 */
export function matchAddressLikeFilingWithoutCoords(
  query: string,
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
): SavedPlaceLabelMatch {
  const q = String(query ?? "").trim();
  if (!q || q.toLowerCase() === "speaker") {
    return { kind: "none" };
  }
  const rows = collectAddressLikeFilingsWithoutCoords(snapshot);
  if (rows.length === 0) {
    return { kind: "none" };
  }
  const byId = rows.filter((r) => r.id === q);
  if (byId.length === 1) {
    return { kind: "unique", row: byId[0]! };
  }
  if (byId.length > 1) {
    return {
      kind: "ambiguous",
      options: byId.map((r) => ({
        id: r.id,
        label: r.label,
        listType: r.listType,
      })),
    };
  }
  const qNorm = normalizeLabel(q);
  if (!qNorm) {
    return { kind: "none" };
  }
  const byExact = rows.filter((r) => normalizeLabel(r.label) === qNorm);
  if (byExact.length === 1) {
    return { kind: "unique", row: byExact[0]! };
  }
  if (byExact.length > 1) {
    return {
      kind: "ambiguous",
      options: byExact.map((r) => ({
        id: r.id,
        label: r.label,
        listType: r.listType,
      })),
    };
  }
  if (qNorm.length < 2) {
    return { kind: "none" };
  }
  const soft = rows.filter((r) => {
    const labelNorm = normalizeLabel(r.label);
    if (labelNorm.length < 2) {
      return false;
    }
    return labelNorm.includes(qNorm) || qNorm.includes(labelNorm);
  });
  if (soft.length === 1) {
    return { kind: "unique", row: soft[0]! };
  }
  if (soft.length > 1) {
    return {
      kind: "ambiguous",
      options: soft.map((r) => ({
        id: r.id,
        label: r.label,
        listType: r.listType,
      })),
    };
  }
  return { kind: "none" };
}

/** Ask when a saved place label matched but has no usable coordinates. */
export function formatSavedLabelMissingCoordsAsk(label: string): string {
  const trimmed = label.trim() || "המיקום השמור";
  return `ל«${trimmed}» אין קואורדינטות שמורות. שלח מיקום בוואטסאפ או ציין עיר לבדיקה.`;
}
