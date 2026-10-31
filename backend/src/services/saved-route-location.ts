/**
 * Resolve routes origin/destination against saved items that already carry
 * valid lat,lng in EMPLOYEE_SAVED_DATA (filings + every list) and SPEAKER_CONTACTS
 * (phone-book description may hold coords). No parallel store.
 * Matching uses the ACTION string only — never the raw user utterance.
 *
 * Live weather/places also reuse this matcher via resolveActionLocation.
 * Labels without valid coords are detected separately so they are never
 * geocoded as city names.
 */
import type { EmployeeRecordSnapshot } from "./employee-records.service.js";
import {
  filingNameLooksLikeAddress,
  parseLatLngCoordinates,
  resolveCustomTitleField,
} from "./show-button-dump.js";

/** Minimal phone-book row for location resolve (SPEAKER_CONTACTS). */
export type SavedLocationContactRef = {
  id: string;
  name: string;
  description?: string | null;
};

export type SavedRoutePointHit = {
  kind: "hit";
  lat: number;
  lng: number;
  label: string;
  id: string;
  source: "filing" | "list" | "contact";
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
  source: "filing" | "list" | "contact";
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

/** Fields that may hold a place string (coords or street) on list items. */
const PLACE_FIELD_KEYS = [
  "כתובת",
  "address",
  "מקום",
  "location",
  "מיקום",
  "place",
];

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

function contactCoords(
  row: SavedLocationContactRef,
): { lat: number; lng: number } | null {
  const text = String(row.description ?? "").trim();
  if (!text) {
    return null;
  }
  return parseLatLngCoordinates(text);
}

/**
 * All saved rows that already store a valid lat,lng string.
 * Filings + every list type (shopping / tasks / custom) + phone-book contacts
 * whose description holds coordinates.
 */
export function collectSavedRouteLocationCandidates(
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
  contacts?: SavedLocationContactRef[] | null,
): SavedRouteLocationCandidate[] {
  const out: SavedRouteLocationCandidate[] = [];
  const seenIds = new Set<string>();

  for (const row of snapshot?.filing ?? []) {
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

  for (const list of snapshot?.lists ?? []) {
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

  for (const row of contacts ?? []) {
    const id = String(row.id ?? "").trim();
    const label = String(row.name ?? "").trim();
    const coords = contactCoords(row);
    if (!id || !label || !coords || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    out.push({
      id,
      label,
      lat: coords.lat,
      lng: coords.lng,
      source: "contact",
      listType: "contacts",
    });
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
  contacts?: SavedLocationContactRef[] | null,
): SavedRoutePointResult {
  const q = String(query ?? "").trim();
  if (!q || q.toLowerCase() === "speaker") {
    return { kind: "none" };
  }
  const candidates = collectSavedRouteLocationCandidates(snapshot, contacts);
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
            : opt.listType === "contacts" || opt.listType === "phone_book"
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

/** Saved place label that has no valid lat,lng (ask instead of geocoding). */
export type SavedPlaceLabelOnly = {
  id: string;
  label: string;
  listType: string;
};

function listItemPlaceTextWithoutCoords(
  item: Record<string, unknown>,
): string {
  for (const key of PLACE_FIELD_KEYS) {
    const value = item[key];
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

/**
 * Saved labels without usable coords: address-like filings, list items with a
 * place field (כתובת/מקום/…), phone-book contacts with a non-coord description.
 */
export function collectSavedPlacesWithoutCoords(
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
  contacts?: SavedLocationContactRef[] | null,
): SavedPlaceLabelOnly[] {
  const out: SavedPlaceLabelOnly[] = [];
  const seenIds = new Set<string>();

  for (const row of collectAddressLikeFilingsWithoutCoords(snapshot)) {
    if (seenIds.has(row.id)) {
      continue;
    }
    seenIds.add(row.id);
    out.push(row);
  }

  for (const list of snapshot?.lists ?? []) {
    const listType = String(list.list_type ?? "").trim() || "custom";
    for (const item of list.items ?? []) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const id = readTrimmed(rec, ["item_id", "itemId", "id"]);
      if (!id || seenIds.has(id)) {
        continue;
      }
      if (firstCoordsInItem(rec)) {
        continue;
      }
      if (!listItemPlaceTextWithoutCoords(rec)) {
        continue;
      }
      const label =
        listItemLabel(listType, rec, list.title_field, list.columns) || id;
      if (!label.trim()) {
        continue;
      }
      seenIds.add(id);
      out.push({ id, label: label.trim(), listType });
    }
  }

  for (const row of contacts ?? []) {
    const id = String(row.id ?? "").trim();
    const label = String(row.name ?? "").trim();
    const desc = String(row.description ?? "").trim();
    if (!id || !label || !desc || seenIds.has(id)) {
      continue;
    }
    if (contactCoords(row)) {
      continue;
    }
    seenIds.add(id);
    out.push({ id, label, listType: "contacts" });
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

function matchSavedPlaceLabelRows(
  query: string,
  rows: SavedPlaceLabelOnly[],
): SavedPlaceLabelMatch {
  const q = String(query ?? "").trim();
  if (!q || q.toLowerCase() === "speaker") {
    return { kind: "none" };
  }
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

/**
 * Match ACTION place against saved labels that lack coordinates (filings,
 * list items with place fields, phone-book contacts with description).
 * Same id / exact label / unique soft rules as resolveSavedRoutePoint.
 */
export function matchSavedPlaceWithoutCoords(
  query: string,
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
  contacts?: SavedLocationContactRef[] | null,
): SavedPlaceLabelMatch {
  return matchSavedPlaceLabelRows(
    query,
    collectSavedPlacesWithoutCoords(snapshot, contacts),
  );
}

/**
 * @deprecated Prefer matchSavedPlaceWithoutCoords — filings-only subset kept
 * for callers/tests that only seed filings.
 */
export function matchAddressLikeFilingWithoutCoords(
  query: string,
  snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> | null | undefined,
  contacts?: SavedLocationContactRef[] | null,
): SavedPlaceLabelMatch {
  return matchSavedPlaceWithoutCoords(query, snapshot, contacts);
}

/** Ask when a saved place label matched but has no usable coordinates. */
export function formatSavedLabelMissingCoordsAsk(label: string): string {
  const trimmed = label.trim() || "המיקום השמור";
  return `ל«${trimmed}» אין קואורדינטות שמורות. שלח מיקום בוואטסאפ או ציין עיר לבדיקה.`;
}
