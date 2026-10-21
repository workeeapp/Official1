/**
 * Offline-only: build a stub ACTION that satisfies semantic constraints.
 * Proves harness/constraint wiring — NOT live model selection.
 * Does not import chat.service or Batch A runners.
 */
import { parseLlmMetadata, type LlmMetadata } from "@workee/shared";
import {
  evaluateConstraints,
  type ModelEvalConstraint,
} from "./constraints.js";

type StubMeta = {
  lists: unknown[];
  list_ops: unknown[];
  filing: unknown[];
  directory: unknown[];
  reminders: unknown[];
  jobs: unknown[];
  messages: unknown[];
  show_dump?: string | null;
  hold?: Record<string, unknown> | null;
  confirm?: boolean;
};

function emptyMeta(): StubMeta {
  return {
    lists: [],
    list_ops: [],
    filing: [],
    directory: [],
    reminders: [],
    jobs: [],
    messages: [],
    show_dump: null,
    hold: null,
    confirm: false,
  };
}

function applyConstraint(meta: StubMeta, c: ModelEvalConstraint): string {
  switch (c.type) {
    case "any": {
      // Prefer the first branch that keeps mutations empty when possible.
      for (const row of c.constraints) {
        if (
          row.type === "mutations_empty_or_read_only" ||
          row.type === "lists_empty" ||
          row.type === "response_looks_like_ask"
        ) {
          applyConstraint(meta, row);
          return row.type === "response_looks_like_ask"
            ? "מה תרצה?"
            : "בסדר";
        }
      }
      applyConstraint(meta, c.constraints[0]!);
      return "בסדר";
    }
    case "mutations_empty_or_read_only":
    case "lists_empty":
    case "filing_empty":
    case "directory_empty":
    case "list_ops_empty":
    case "no_invented_reminder_add":
    case "no_silent_multi_domain_wipe":
    case "no_query_report":
    case "no_list_ops_delete":
    case "no_lists_remove":
    case "no_lists_add":
    case "not_lists_remove_shopping":
      return "";
    case "response_looks_like_ask":
      return "לאיזו תזכורת התכוונת?";
    case "hold_or_confirm_or_ask":
      return "לאיזו תזכורת התכוונת?";
    case "hold_or_confirm":
    case "hold_present":
      meta.hold = { reason: "eval" };
      return "רגע";
    case "response_mentions_any":
      return `אוקיי ${c.needles[0] ?? ""}`;
    case "response_mentions_all":
      return c.needles.join(" ");
    case "response_forbids_any":
      return "בסדר";
    case "show_dump":
      meta.show_dump = c.value;
      return "הנה מה ששמור";
    case "reminders_has_action": {
      if (c.action === "add") {
        meta.lists.push({
          action: "add",
          list_type: "reminders",
          list_name: "",
          targets: [],
          items: [
            {
              item: "לקנות חלב",
              list_type: "shopping",
              time: "09:00",
              in: null,
              ping: ["טל"],
              ...(c.recurring
                ? { every_count: 1, every_unit: "days" }
                : {}),
            },
          ],
        });
      } else if (c.action === "update") {
        meta.lists.push({
          action: "update",
          list_type: "reminders",
          list_name: "",
          targets: [],
          items: [
            {
              reminder_id: "eval-rem-milk",
              item: "לקנות חלב",
              time: "14:00",
            },
          ],
        });
      } else if (c.action === "remove") {
        meta.lists.push({
          action: "remove",
          list_type: "reminders",
          list_name: "",
          targets: [],
          items: [{ reminder_id: "eval-rem-x", item: "" }],
        });
      }
      return "עדכנתי";
    }
    case "reminders_remove_ids":
      for (const id of c.reminderIds) {
        meta.lists.push({
          action: "remove",
          list_type: "reminders",
          list_name: "",
          targets: [],
          items: [{ reminder_id: id, item: "" }],
        });
      }
      return "ביטלתי";
    case "lists_has_action":
      meta.lists.push({
        action: c.action,
        list_type: c.listType ?? "shopping",
        list_name: "",
        items:
          c.action === "add"
            ? [
                {
                  ...(c.listType === "tasks"
                    ? { "שם מטלה": c.itemTextIncludes ?? "מטלה" }
                    : { "שם פריט": c.itemTextIncludes ?? "חלב" }),
                },
              ]
            : c.action === "remove"
              ? [{ item_id: "eval-item-x" }]
              : [
                  {
                    item_id: "eval-item-x",
                    ...(c.listType === "tasks"
                      ? { "שם מטלה": "מעודכן" }
                      : { "שם פריט": "מעודכן" }),
                  },
                ],
        targets: [],
      });
      return "עדכנתי";
    case "lists_remove_item_ids":
      meta.lists.push({
        action: "remove",
        list_type: c.listType ?? "tasks",
        list_name: "",
        items: c.itemIds.map((id) => ({ item_id: id })),
        targets: [],
      });
      return "הסרתי";
    case "list_ops_has_action":
      meta.lists.push({
        action: c.action,
        list_id: "eval-list-x",
        items: [],
        targets: [],
        ...(c.action === "alter_list" ? { new_name: "בעיות" } : {}),
      });
      return "עדכנתי רשימה";
    case "list_ops_delete_list_ids":
      for (const id of c.listIds) {
        meta.lists.push({
          action: "delete_list",
          list_id: id,
          items: [],
          targets: [],
        });
      }
      return "מחקתי רשימה";
    case "filing_has_action": {
      const rowAction =
        c.action === "add_filing"
          ? "add"
          : c.action === "remove_filing"
            ? "remove"
            : "update";
      meta.lists.push({
        action: rowAction,
        list_type: "filing",
        list_name: "",
        targets: [],
        items: [
          {
            ...(rowAction === "add"
              ? {}
              : { filing_id: c.filingId ?? "eval-filing-x" }),
            item_name: "קוד",
            item_info: c.infoIncludes ?? "1234",
            item_description: "",
          },
        ],
      });
      return "שמרתי";
    }
    case "directory_has_action":
      meta.directory.push({
        action: c.action,
        name: c.nameIncludes ?? "מיכל",
        phone: c.phoneIncludes ? `${c.phoneIncludes}1111111` : "0541111111",
        // update/remove require contact_id or parseLlmMetadata drops the row
        ...(c.action === "update" || c.action === "remove"
          ? { contact_id: "eval-contact-michal" }
          : {}),
      });
      return "עדכנתי איש קשר";
    case "directory_remove_contact_ids":
      for (const id of c.contactIds) {
        meta.directory.push({ action: "remove", contact_id: id });
      }
      return "הסרתי";
    case "jobs_has_action":
      meta.jobs.push({
        action: c.action,
        job_id: "eval-job-1",
        answer_text: c.requireAsk ? "שאלה?" : "",
      });
      return "עדכנתי";
    case "messages_has": {
      const target = c.targetIncludes ?? "עמית";
      meta.messages.push({
        text: c.textIncludes ?? `תיאום עם ${target}`,
        targets: [target],
        expects_reply: true,
        ...(c.requireBook
          ? {
              book: {
                title: "פגישה",
                date: "2099-01-01",
                time: "10:00",
              },
            }
          : {}),
      });
      return `שלחתי ל${target}`;
    }
    default:
      return "";
  }
}

/** Returns stub metadata + response for offline constraint checks. */
export function offlineStubForConstraints(constraints: ModelEvalConstraint[]): {
  metadata: unknown;
  response: string;
} {
  const meta = emptyMeta();
  let response = "בסדר";
  for (const c of constraints) {
    const r = applyConstraint(meta, c);
    if (r) response = r;
  }
  if (
    constraints.some(
      (c) =>
        c.type === "response_looks_like_ask" ||
        c.type === "hold_or_confirm_or_ask",
    ) &&
    !/[?？]/.test(response) &&
    !/(?:מתי|מה |איזה|איזו|האם|תרצה)/.test(response)
  ) {
    response = "מה תרצה שאעשה?";
  }
  return { metadata: meta, response };
}

/**
 * Parse a proposed ACTION and check constraints — no LLM, no Batch A, no chat.
 */
export function evaluateOfflineModelProposal(input: {
  constraints: ModelEvalConstraint[];
  metadata: unknown;
  response?: string;
}): {
  ok: boolean;
  failures: string[];
  metadata: LlmMetadata;
  response: string;
} {
  const metadata = parseLlmMetadata(input.metadata);
  const response = input.response ?? "";
  const checked = evaluateConstraints(input.constraints, metadata, response);
  return {
    ok: checked.ok,
    failures: checked.failures,
    metadata,
    response,
  };
}
