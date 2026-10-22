/**
 * In-memory EMPLOYEE_SAVED_DATA evolution for LIVE_MODEL_MT.
 * Applies proposed ACTION onto the eval snapshot only — no Prisma / WA / clocks.
 */
import type { LlmMetadata } from "@workee/shared";
import type { EmployeeRecordSnapshot } from "../services/employee-records.service.js";

let liveItemSeq = 0;

function itemLabel(item: Record<string, unknown>): string {
  for (const key of ["שם פריט", "שם מטלה", "שם", "name", "item", "title"]) {
    const val = item[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function readItemId(item: Record<string, unknown>): string {
  for (const key of ["item_id", "itemId", "id"]) {
    const val = item[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function ensureList(
  snapshot: EmployeeRecordSnapshot,
  listType: string,
  listName: string,
  speaker: string,
): EmployeeRecordSnapshot["lists"][number] {
  const existing = snapshot.lists.find((row) => {
    if (row.list_type !== listType) return false;
    if (listType === "custom") {
      return (row.list_name ?? "") === listName;
    }
    return true;
  });
  if (existing) return existing;
  const created: EmployeeRecordSnapshot["lists"][number] = {
    list_id: `eval-live-${listType}-${liveItemSeq++}`,
    list_type: listType,
    ...(listType === "custom" ? { list_name: listName || "רשימה" } : {}),
    owner: speaker,
    scope: "personal",
    items: [],
  };
  snapshot.lists.push(created);
  return created;
}

/**
 * Mutate `snapshot` in place from one turn's metadata (lists + reminders only).
 */
export function applyLiveModelMetadataToSnapshot(
  snapshot: EmployeeRecordSnapshot,
  meta: LlmMetadata,
  speaker: string,
): void {
  for (const action of meta.lists ?? []) {
    const listType = String(action.listType ?? "shopping");
    const listName = String(action.listName ?? "");
    if (action.action === "add") {
      const list = ensureList(snapshot, listType, listName, speaker);
      for (const raw of action.items ?? []) {
        const item = { ...(raw as Record<string, unknown>) };
        if (!readItemId(item)) {
          item.item_id = `eval-live-item-${++liveItemSeq}`;
        }
        list.items.push(item);
      }
      continue;
    }
    if (action.action === "remove") {
      const list = snapshot.lists.find((row) => {
        if (row.list_type !== listType) return false;
        if (listType === "custom" && listName) {
          return (row.list_name ?? "") === listName;
        }
        return true;
      });
      if (!list) continue;
      const removeIds = new Set(
        (action.items ?? [])
          .map((raw) => readItemId(raw as Record<string, unknown>))
          .filter(Boolean),
      );
      const removeLabels = new Set(
        (action.items ?? [])
          .map((raw) => itemLabel(raw as Record<string, unknown>).toLowerCase())
          .filter(Boolean),
      );
      list.items = list.items.filter((row) => {
        const id = readItemId(row);
        const label = itemLabel(row).toLowerCase();
        if (id && removeIds.has(id)) return false;
        if (label && removeLabels.has(label)) return false;
        if (
          removeLabels.size > 0 &&
          label &&
          [...removeLabels].some((needle) => label.includes(needle))
        ) {
          return false;
        }
        return true;
      });
      continue;
    }
    if (action.action === "update") {
      const list = snapshot.lists.find((row) => row.list_type === listType);
      if (!list) continue;
      for (const raw of action.items ?? []) {
        const patch = { ...(raw as Record<string, unknown>) };
        const id = readItemId(patch);
        const label = itemLabel(patch).toLowerCase();
        const target = list.items.find((row) => {
          if (id && readItemId(row) === id) return true;
          const rowLabel = itemLabel(row).toLowerCase();
          return Boolean(label && rowLabel && rowLabel.includes(label));
        });
        if (target) {
          Object.assign(target, patch);
        }
      }
    }
  }

  if (!snapshot.reminders) snapshot.reminders = [];
  for (const rem of meta.reminders ?? []) {
    if (rem.action === "add") {
      snapshot.reminders.push({
        reminder_id: `eval-live-rem-${++liveItemSeq}`,
        item: String(rem.item ?? rem.text ?? "תזכורת"),
        list_type: String(rem.listType ?? "tasks"),
        fire_at: "2099-01-01T08:00:00.000Z",
        repeat: String(rem.repeat ?? "once"),
        ping: Array.isArray(rem.ping) ? rem.ping.map(String) : [speaker],
        ping_ids: [],
        owner: speaker,
        text: String(rem.text ?? rem.item ?? "תזכורת"),
        last_composed_text: "",
        sent_text: String(rem.text ?? rem.item ?? "תזכורת"),
        compose_at_fire: false,
        compose_source: "",
        compose_lookback_hours: 0,
        status: "active",
        send_status: "pending",
        sent: false,
        sent_at: null,
      });
    } else if (rem.action === "remove") {
      const id = String(rem.reminderId ?? "").trim();
      if (!id) continue;
      snapshot.reminders = snapshot.reminders.filter(
        (row) => row.reminder_id !== id,
      );
    }
  }
}
