/**
 * Focused post-apply evidence for LIVE_FULL artifacts.
 * Built from harness turn snapshot/facts already captured before destroy.
 */
import type { EmployeeRecordSnapshot } from "../services/employee-records.service.js";

const ITEM_TEXT_KEYS = [
  "שם",
  "פריט",
  "שם פריט",
  "שם מטלה",
  "name",
  "title",
  "item_name",
] as const;

export type PostApplyCustomListEvidence = {
  list_name: string;
  /** Item display texts that belong to this list (order preserved). */
  itemTexts: string[];
};

export type PostApplyHostLinkEvidence = {
  item_id: string;
  linked_list_names: string[];
};

export type PostApplyEvidence = {
  facts: string;
  customLists: PostApplyCustomListEvidence[];
  hostLinks: PostApplyHostLinkEvidence[];
};

function readItemId(item: Record<string, unknown>): string {
  for (const key of ["item_id", "itemId", "id"]) {
    const raw = item[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

function itemDisplayText(item: Record<string, unknown>): string {
  for (const key of ITEM_TEXT_KEYS) {
    const raw = item[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

function linkedListNames(item: Record<string, unknown>): string[] {
  const raw = item.linked_lists ?? item.linkedLists;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const name = String(rec.list_name ?? rec.listName ?? "").trim();
    if (name) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Slice snapshot + facts into audit-sized evidence (no full DB dump).
 */
export function buildPostApplyEvidence(input: {
  facts: string;
  snapshot: EmployeeRecordSnapshot;
}): PostApplyEvidence {
  const customLists: PostApplyCustomListEvidence[] = [];
  const hostLinks: PostApplyHostLinkEvidence[] = [];

  for (const list of input.snapshot.lists) {
    if (list.list_type === "custom") {
      const listName = String(list.list_name ?? "").trim();
      customLists.push({
        list_name: listName,
        itemTexts: list.items
          .map((item) => itemDisplayText(item as Record<string, unknown>))
          .filter(Boolean),
      });
    }
    if (list.list_type === "tasks") {
      for (const item of list.items) {
        const rec = item as Record<string, unknown>;
        const names = linkedListNames(rec);
        if (names.length === 0) {
          continue;
        }
        const itemId = readItemId(rec);
        if (!itemId) {
          continue;
        }
        hostLinks.push({ item_id: itemId, linked_list_names: names });
      }
    }
  }

  return {
    facts: input.facts,
    customLists,
    hostLinks,
  };
}
