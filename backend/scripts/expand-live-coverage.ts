/**
 * LIVE-only coverage expansion (all plan waves).
 * Idempotent: skips case ids that already exist.
 *
 *   npx tsx backend/scripts/expand-live-coverage.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_AUTHOR_CORPUS_RELATIVE,
  compileLiveAuthorDraft,
  type LiveAuthorDraft,
  type LiveAuthorTrack,
} from "../src/eval/live-author-compile.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CORPUS: Record<LiveAuthorTrack, string> = {
  model: resolve(repoRoot, LIVE_AUTHOR_CORPUS_RELATIVE.model),
  mt: resolve(repoRoot, LIVE_AUTHOR_CORPUS_RELATIVE.mt),
  full: resolve(repoRoot, LIVE_AUTHOR_CORPUS_RELATIVE.full),
};

type CorpusFile = {
  cases: Array<{ id: string; tags?: string[]; [k: string]: unknown }>;
  criticalCaseIds?: string[];
  [k: string]: unknown;
};

function loadCorpus(track: LiveAuthorTrack): CorpusFile {
  return JSON.parse(readFileSync(CORPUS[track], "utf8")) as CorpusFile;
}

function saveCorpus(track: LiveAuthorTrack, data: CorpusFile): void {
  writeFileSync(CORPUS[track], `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function appendCompiled(draft: LiveAuthorDraft, stats: { added: number; skipped: number }) {
  const compiled = compileLiveAuthorDraft(draft);
  const corpus = loadCorpus(compiled.track);
  if (corpus.cases.some((c) => c.id === compiled.case.id)) {
    stats.skipped += 1;
    return;
  }
  corpus.cases.push(compiled.case as { id: string });
  saveCorpus(compiled.track, corpus);
  stats.added += 1;
}

function mergeCriticals(track: LiveAuthorTrack, ids: string[]) {
  const corpus = loadCorpus(track);
  const known = new Set(corpus.cases.map((c) => c.id));
  const next = new Set(corpus.criticalCaseIds ?? []);
  for (const id of ids) {
    if (known.has(id)) next.add(id);
  }
  corpus.criticalCaseIds = [...next];
  saveCorpus(track, corpus);
}

function tagExistingMtFamilies() {
  const corpus = loadCorpus("mt");
  const map: Record<string, string> = {
    "mt-clarify-then-delete": "mt-clarify",
    "mt-clarify-then-remove-eggs": "mt-clarify",
    "mt-ambiguous-list-resolve": "mt-clarify",
    "mt-directory-clear-confirm": "mt-clarify",
    "mt-filing-confirm-delete": "mt-clarify",
    "mt-reminder-ask-then-time": "mt-clarify",
    "mt-cancel-reminder-resolve": "mt-clarify",
    "mt-task-ask-then-title": "mt-clarify",
    "mt-ask-then-add": "mt-multi-act",
    "mt-show-then-bought": "mt-multi-act",
    "mt-stop-nudge-keep-item": "mt-multi-act",
  };
  for (const row of corpus.cases) {
    const fam = map[row.id];
    if (!fam) continue;
    const tags = new Set(row.tags ?? []);
    tags.add(fam);
    tags.add("multi-turn");
    row.tags = [...tags];
  }
  saveCorpus("mt", corpus);
}

/** Wave A1 — shopping / tasks / reminders gaps + FULL twins */
function waveA1(): LiveAuthorDraft[] {
  return [
    {
      id: "shopping-empty-ask",
      track: "model",
      tags: ["shopping", "single-turn"],
      description: "Add shopping without item → ask",
      setup: {},
      turns: [{ utterance: "תוסיפי לקניות", intent: { type: "ask" } }],
    },
    {
      id: "full-list-clear-personal-shopping",
      track: "full",
      tags: ["shopping", "full-live", "single-turn"],
      description: "Clear personal shopping persists",
      setup: {
        shoppingItems: [
          { id: "eval-item-shop-milk", label: "חלב" },
          { id: "eval-item-shop-bread", label: "לחם" },
          { id: "eval-item-shop-eggs", label: "ביצים" },
        ],
      },
      turns: [
        {
          utterance: "נקה את רשימת הקניות האישית שלי",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_remove_item_ids",
                listType: "shopping",
                itemIds: [
                  "eval-item-shop-milk",
                  "eval-item-shop-bread",
                  "eval-item-shop-eggs",
                ],
              },
              { type: "list_ops_empty" },
            ],
          },
          outcome: {
            itemIdsAbsent: [
              "eval-item-shop-milk",
              "eval-item-shop-bread",
              "eval-item-shop-eggs",
            ],
          },
        },
      ],
    },
    {
      id: "full-task-meet-create",
      track: "full",
      tags: ["tasks", "full-live", "single-turn"],
      description: "Add meeting task persists in facts",
      setup: {},
      turns: [
        {
          utterance: "תוסיפי מטלה לפגישה עם עמית",
          intent: { type: "add_task", itemText: "עמית" },
          outcome: { factsInclude: ["עמית"] },
        },
      ],
    },
    {
      id: "full-reminder-cancel-named",
      track: "full",
      tags: ["reminders", "full-live", "single-turn"],
      description: "Cancel named reminder → clock gone from facts",
      setup: {
        reminders: [
          {
            reminder_id: "eval-rem-water",
            item: "לשתות מים",
            owner: "טל",
            status: "active",
            due_at: "2099-01-01T10:00:00.000Z",
          },
        ],
      } as LiveAuthorDraft["setup"],
      turns: [
        {
          utterance: "תבטלי את התזכורת לשתות מים",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "reminders_remove_ids",
                reminderIds: ["eval-rem-water"],
              },
            ],
          },
          outcome: { factsExclude: ["לשתות מים"] },
        },
      ],
    },
    {
      id: "full-reminder-create-explicit",
      track: "full",
      tags: ["reminders", "shopping", "full-live", "single-turn"],
      description: "Explicit tomorrow reminder + shopping task persists",
      setup: {},
      turns: [
        {
          utterance: "תזכירי לי מחר ב־09:00 לקנות חלב",
          intent: {
            type: "custom",
            constraints: [
              { type: "reminders_has_action", action: "add" },
              {
                type: "lists_has_action",
                action: "add",
                listType: "shopping",
              },
            ],
          },
          outcome: { factsInclude: ["חלב"] },
        },
      ],
    },
    {
      id: "full-shopping-empty-ask",
      track: "full",
      tags: ["shopping", "full-live", "single-turn"],
      description: "Incomplete shopping add → ask; no DB change",
      setup: { shoppingItems: [] },
      turns: [
        {
          utterance: "תוסיפי לקניות",
          intent: { type: "ask" },
        },
      ],
    },
  ];
}

/** Wave A2 — filing / directory / lists-safety / show */
function waveA2(): LiveAuthorDraft[] {
  return [
    {
      id: "full-filing-add-simple",
      track: "full",
      tags: ["filing", "full-live", "single-turn"],
      description: "File address persists",
      setup: {},
      turns: [
        {
          utterance: "תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב",
          intent: { type: "filing_add", infoIncludes: "הרצל" },
          outcome: { factsInclude: ["הרצל"] },
        },
      ],
    },
    {
      id: "full-filing-remove-email-code",
      track: "full",
      tags: ["filing", "full-live", "single-turn"],
      description: "Remove filing by spoken name",
      setup: {
        filing: [
          {
            filing_id: "eval-filing-email-code",
            item_name: "קוד לכניסה לחשבון אימייל",
            item_description: "קוד כניסה לחשבון אימייל",
            item_info: "8844",
            owner: "טל",
            scope: "personal",
          },
        ],
      },
      turns: [
        {
          utterance: "מחק קוד כניסה לחשבון אימייל",
          intent: {
            type: "filing_remove",
            filingId: "eval-filing-email-code",
          },
          outcome: { factsExclude: ["8844"] },
        },
      ],
    },
    {
      id: "full-directory-add-michal",
      track: "full",
      tags: ["directory", "full-live", "single-turn"],
      description: "Add Michal to contacts persists",
      setup: {},
      turns: [
        {
          utterance: "תוסיפי את מיכל 0501234567 לאנשי קשר",
          intent: { type: "directory_add", nameIncludes: "מיכל" },
          outcome: { factsInclude: ["מיכל"] },
        },
      ],
    },
    {
      id: "full-directory-remove-michal",
      track: "full",
      tags: ["directory", "full-live", "single-turn"],
      description: "Remove Michal contact",
      setup: {
        contacts: [{ name: "מיכל", phone: "0501234567" }],
      },
      turns: [
        {
          utterance: "מחקי את מיכל מאנשי הקשר",
          intent: {
            type: "custom",
            constraints: [
              { type: "directory_has_action", action: "remove" },
            ],
          },
          outcome: { factsExclude: ["מיכל"] },
        },
      ],
    },
    {
      id: "full-list-named-item-delete",
      track: "full",
      tags: ["lists-safety", "full-live", "single-turn"],
      description: "Delete named custom-list item by id",
      setup: {
        lists: [
          {
            list_id: "eval-list-problems",
            list_type: "custom",
            name: "בעיות",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-problems-check",
                "שם פריט": "לבדוק שרת",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "מחקתי לבדוק שרת מרשימת בעיות",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_remove_item_ids",
                listType: "custom",
                itemIds: ["eval-item-problems-check"],
              },
              { type: "list_ops_empty" },
            ],
          },
          outcome: { itemIdsAbsent: ["eval-item-problems-check"] },
        },
      ],
    },
    {
      id: "full-dump-what-saved",
      track: "full",
      tags: ["show", "full-live", "single-turn"],
      description: "Show dump; milk still in facts",
      setup: {
        shoppingItems: [{ id: "eval-item-milk", label: "חלב" }],
      },
      turns: [
        {
          utterance: "מה שמור לי",
          intent: { type: "show_dump", value: "full" },
          outcome: { factsInclude: ["חלב"] },
        },
      ],
    },
    {
      id: "filing-empty-ask",
      track: "model",
      tags: ["filing", "single-turn"],
      description: "File without detail → ask",
      setup: {},
      turns: [{ utterance: "תייקי משהו", intent: { type: "ask" } }],
    },
  ];
}

/** Wave B — share levels */
function waveB(): LiveAuthorDraft[] {
  const shopTaskSetup = {
    lists: [
      {
        list_id: "eval-list-shopping-personal",
        list_type: "shopping",
        owner: "טל",
        scope: "personal",
        items: [{ item_id: "eval-item-milk", "שם פריט": "חלב" }],
      },
      {
        list_id: "eval-list-tasks-personal",
        list_type: "tasks",
        owner: "טל",
        scope: "personal",
        items: [
          { item_id: "eval-item-doctor", "שם מטלה": "להתקשר לרופא" },
        ],
      },
    ],
  };

  return [
    {
      id: "share-shop-with-amit",
      track: "model",
      tags: ["share", "shopping", "single-turn"],
      description: "Share shopping list with Amit",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשתפי את הקניות עם עמית",
          intent: { type: "share_update", listType: "shopping" },
        },
      ],
    },
    {
      id: "share-assign-task-amit",
      track: "model",
      tags: ["share", "tasks", "single-turn"],
      description: "Assign doctor task onto Amit",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשימי על עמית להתקשר לרופא",
          intent: { type: "add_task", itemText: "רופא" },
        },
      ],
    },
    {
      id: "share-ask-missing-partner",
      track: "model",
      tags: ["share", "shopping", "single-turn"],
      description: "Share without partner → ask",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשתפי את הקניות",
          intent: { type: "ask" },
        },
      ],
    },
    {
      id: "full-share-shop-with-amit",
      track: "full",
      tags: ["share", "shopping", "full-live", "single-turn"],
      description: "Share shopping applies; milk still present",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשתפי את הקניות עם עמית",
          intent: { type: "share_update", listType: "shopping" },
          outcome: { factsInclude: ["חלב"] },
        },
      ],
    },
    {
      id: "mt-share-then-add-bread",
      track: "mt",
      tags: ["share", "shopping", "mt-multi-act", "multi-turn"],
      description: "Share shopping then add bread in same thread",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשתפי את הקניות עם עמית",
          intent: { type: "share_update", listType: "shopping" },
        },
        {
          utterance: "תוסיפי גם לחם",
          intent: { type: "add_shopping", itemText: "לחם" },
        },
      ],
    },
    {
      id: "mt-share-ask-then-partner",
      track: "mt",
      tags: ["share", "shopping", "mt-clarify", "multi-turn"],
      description: "Share without who → ask → Amit",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשתפי את הקניות",
          intent: { type: "ask" },
        },
        {
          utterance: "עם עמית",
          intent: { type: "share_update", listType: "shopping" },
        },
      ],
    },
    {
      id: "full-mt-share-ask-then-partner",
      track: "full",
      tags: ["share", "shopping", "mt-clarify", "full-live", "multi-turn"],
      description: "Share clarify then partner; milk kept",
      setup: shopTaskSetup,
      turns: [
        {
          utterance: "תשתפי את הקניות",
          intent: { type: "ask" },
          outcome: { factsInclude: ["חלב"] },
        },
        {
          utterance: "עם עמית",
          intent: { type: "share_update", listType: "shopping" },
          outcome: { factsInclude: ["חלב"] },
        },
      ],
    },
  ];
}

/** Wave C — events */
function waveC(): LiveAuthorDraft[] {
  return [
    {
      id: "event-host-create-poker",
      track: "model",
      tags: ["events", "tasks", "single-turn"],
      description: "Event host is poker night task name",
      setup: {},
      turns: [
        {
          utterance: "צריך לארגן ערב פוקר",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "add",
                listType: "tasks",
                minCount: 1,
                maxCount: 1,
                itemTextIncludes: "ערב פוקר",
              },
              { type: "no_lists_add", listType: "custom" },
              { type: "no_lists_add", listType: "shopping" },
              { type: "list_ops_empty" },
              { type: "no_invented_reminder_add" },
              {
                type: "response_forbids_any",
                needles: ["לארגן ערב פוקר"],
              },
              {
                type: "response_mentions_any",
                needles: ["ערב פוקר"],
              },
            ],
          },
        },
      ],
    },
    {
      id: "mt-event-clarify-then-link",
      track: "mt",
      tags: ["events", "mt-clarify", "mt-complex", "multi-turn"],
      description: "Ask כיבוד contents → custom list + link host",
      setup: {
        lists: [
          {
            list_id: "eval-list-tasks-personal",
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-host-bday",
                "שם מטלה": "ערב יום הולדת",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי רשימת כיבוד?",
          intent: { type: "ask" },
        },
        {
          utterance: "עוגה ושתיה",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "add",
                listType: "custom",
                minCount: 1,
                itemTextIncludes: "עוגה",
              },
              {
                type: "lists_has_action",
                action: "update",
                listType: "tasks",
                minCount: 1,
                maxCount: 1,
                itemTextIncludes: "כיבוד",
              },
              { type: "no_lists_add", listType: "tasks" },
              { type: "list_ops_empty" },
            ],
          },
        },
      ],
    },
    {
      id: "full-mt-event-clarify-then-link",
      track: "full",
      tags: ["events", "mt-clarify", "mt-complex", "full-live", "multi-turn"],
      description: "Event clarify→link persists host + כיבוד",
      setup: {
        lists: [
          {
            list_id: "eval-list-tasks-personal",
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-host-bday",
                "שם מטלה": "ערב יום הולדת",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי רשימת כיבוד?",
          intent: { type: "ask" },
          outcome: {
            itemIdsPresent: ["eval-item-host-bday"],
            factsInclude: ["ערב יום הולדת"],
            factsExclude: ["כיבוד"],
          },
        },
        {
          utterance: "עוגה ושתיה",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "add",
                listType: "custom",
                minCount: 1,
                itemTextIncludes: "עוגה",
              },
              {
                type: "lists_has_action",
                action: "update",
                listType: "tasks",
                minCount: 1,
                maxCount: 1,
                itemTextIncludes: "כיבוד",
              },
              { type: "no_lists_add", listType: "tasks" },
              { type: "list_ops_empty" },
            ],
          },
          outcome: {
            itemIdsPresent: ["eval-item-host-bday"],
            factsInclude: ["כיבוד", "עוגה", "ערב יום הולדת"],
          },
        },
      ],
    },
    {
      id: "full-event-rename-host",
      track: "full",
      tags: ["events", "tasks", "full-live", "single-turn"],
      description: "Rename event host; no second tasks host",
      setup: {
        lists: [
          {
            list_id: "eval-list-tasks-personal",
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-host-party",
                "שם מטלה": "ערב פוקר",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "תשני את השם לערב משחקים",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "update",
                listType: "tasks",
                minCount: 1,
                maxCount: 1,
                itemTextIncludes: "ערב משחקים",
              },
              { type: "no_lists_add", listType: "tasks" },
              { type: "list_ops_empty" },
            ],
          },
          outcome: {
            itemIdsPresent: ["eval-item-host-party"],
            factsInclude: ["ערב משחקים"],
            factsExclude: ["ערב פוקר"],
          },
        },
      ],
    },
    {
      id: "full-event-host-create-poker",
      track: "full",
      tags: ["events", "tasks", "full-live", "single-turn"],
      description: "Create poker host task persists",
      setup: {},
      turns: [
        {
          utterance: "צריך לארגן ערב פוקר",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "add",
                listType: "tasks",
                itemTextIncludes: "ערב פוקר",
              },
              { type: "no_lists_add", listType: "custom" },
            ],
          },
          outcome: { factsInclude: ["ערב פוקר"] },
        },
      ],
    },
  ];
}

/** Wave D — MT family matrix (clarify / multi-act / complex) × domains */
function waveD(): LiveAuthorDraft[] {
  const drafts: LiveAuthorDraft[] = [];

  // --- mt-clarify matrix ---
  drafts.push(
    {
      id: "mt-clarify-task-which",
      track: "mt",
      tags: ["tasks", "mt-clarify", "multi-turn"],
      description: "Ambiguous task delete → pick doctor",
      setup: {
        lists: [
          {
            list_id: "eval-list-tasks-personal",
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-doctor",
                "שם מטלה": "להתקשר לרופא",
              },
              {
                item_id: "eval-item-meet",
                "שם מטלה": "פגישה עם עמית",
              },
            ],
          },
        ],
      },
      turns: [
        { utterance: "סיימתי את זה", intent: { type: "ask" } },
        {
          utterance: "את הרופא",
          intent: {
            type: "remove_item",
            listType: "tasks",
            itemId: "eval-item-doctor",
          },
        },
      ],
    },
    {
      id: "mt-clarify-filing-which",
      track: "mt",
      tags: ["filing", "mt-clarify", "multi-turn"],
      description: "Ambiguous filing delete → email code",
      setup: {
        filing: [
          {
            filing_id: "eval-filing-email-code",
            item_name: "קוד לכניסה לחשבון אימייל",
            item_description: "קוד כניסה",
            item_info: "8844",
            owner: "טל",
            scope: "personal",
          },
          {
            filing_id: "eval-filing-gate",
            item_name: "קוד שער",
            item_description: "שער",
            item_info: "1122",
            owner: "טל",
            scope: "personal",
          },
        ],
      },
      turns: [
        { utterance: "תמחקי את הקוד", intent: { type: "ask" } },
        {
          utterance: "של האימייל",
          intent: {
            type: "filing_remove",
            filingId: "eval-filing-email-code",
          },
        },
      ],
    },
    {
      id: "mt-clarify-reminder-which",
      track: "mt",
      tags: ["reminders", "mt-clarify", "multi-turn"],
      description: "Ambiguous cancel → water reminder",
      setup: {
        reminders: [
          {
            reminder_id: "eval-rem-water",
            item: "לשתות מים",
            owner: "טל",
            status: "active",
            due_at: "2099-01-01T10:00:00.000Z",
          },
          {
            reminder_id: "eval-rem-dog",
            item: "להוציא כלב",
            owner: "טל",
            status: "active",
            due_at: "2099-01-02T10:00:00.000Z",
          },
        ],
      } as LiveAuthorDraft["setup"],
      turns: [
        { utterance: "תבטלי את התזכורת", intent: { type: "ask" } },
        {
          utterance: "של המים",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "reminders_remove_ids",
                reminderIds: ["eval-rem-water"],
              },
            ],
          },
        },
      ],
    },
    {
      id: "mt-clarify-dir-which",
      track: "mt",
      tags: ["directory", "mt-clarify", "multi-turn"],
      description: "Ambiguous contact remove → Michal",
      setup: {
        contacts: [
          { name: "מיכל", phone: "0501111111" },
          { name: "דנה", phone: "0502222222" },
        ],
      },
      turns: [
        { utterance: "מחקי איש קשר", intent: { type: "ask" } },
        {
          utterance: "את מיכל",
          intent: {
            type: "custom",
            constraints: [
              { type: "directory_has_action", action: "remove" },
            ],
          },
        },
      ],
    },
  );

  // --- mt-multi-act matrix ---
  drafts.push(
    {
      id: "mt-multi-add-then-buy",
      track: "mt",
      tags: ["shopping", "mt-multi-act", "multi-turn"],
      description: "Add yogurt then immediately bought it",
      setup: {
        lists: [
          {
            list_id: "eval-list-shopping-personal",
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי יוגורט לקניות",
          intent: { type: "add_shopping", itemText: "יוגורט" },
        },
        {
          utterance: "קניתי יוגורט",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "remove",
                listType: "shopping",
                itemTextIncludes: "יוגורט",
              },
            ],
          },
        },
      ],
    },
    {
      id: "mt-multi-task-add-then-done",
      track: "mt",
      tags: ["tasks", "mt-multi-act", "multi-turn"],
      description: "Add bill task then mark done",
      setup: {
        lists: [
          {
            list_id: "eval-list-tasks-personal",
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי מטלה לשלם חשבון חשמל",
          intent: { type: "add_task", itemText: "חשמל" },
        },
        {
          utterance: "סיימתי לשלם חשבון חשמל",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "remove",
                listType: "tasks",
                itemTextIncludes: "חשמל",
              },
            ],
          },
        },
      ],
    },
    {
      id: "mt-multi-file-then-update",
      track: "mt",
      tags: ["filing", "mt-multi-act", "multi-turn"],
      description: "File gate code then update to 9999",
      setup: {},
      turns: [
        {
          utterance: "תייקי שקוד השער הוא 4455",
          intent: { type: "filing_add", infoIncludes: "4455" },
        },
        {
          utterance: "עדכני את קוד השער ל־9999",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "filing_has_action",
                action: "update_filing",
                infoIncludes: "9999",
              },
            ],
          },
        },
      ],
    },
    {
      id: "mt-multi-dir-add-then-remove",
      track: "mt",
      tags: ["directory", "mt-multi-act", "multi-turn"],
      description: "Add Noa then remove Noa",
      setup: {},
      turns: [
        {
          utterance: "תוסיפי את נועה 0503334444 לאנשי קשר",
          intent: { type: "directory_add", nameIncludes: "נועה" },
        },
        {
          utterance: "מחקי את נועה",
          intent: {
            type: "custom",
            constraints: [
              { type: "directory_has_action", action: "remove" },
            ],
          },
        },
      ],
    },
    {
      id: "mt-multi-nudge-then-show",
      track: "mt",
      tags: ["reminders", "show", "mt-multi-act", "multi-turn"],
      description: "Create water nudge then show dump",
      setup: {},
      turns: [
        {
          utterance: "תזכירי לי בעוד שעה לשתות מים",
          intent: { type: "reminder_add" },
        },
        {
          utterance: "מה שמור לי",
          intent: { type: "show_dump", value: "full" },
        },
      ],
    },
  );

  // --- mt-complex matrix ---
  drafts.push(
    {
      id: "mt-complex-personal-vs-shared-shop",
      track: "mt",
      tags: ["shopping", "share", "mt-complex", "multi-turn"],
      description: "Two shopping lists; clear personal only after clarify",
      setup: {
        lists: [
          {
            list_id: "eval-list-shopping-personal",
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "eval-item-shop-milk", "שם פריט": "חלב" },
            ],
          },
          {
            list_id: "eval-list-shopping-shared",
            list_type: "shopping",
            owner: "טל",
            scope: "shared",
            shared_with: ["עמית"],
            items: [
              {
                item_id: "eval-item-shop-shared-bread",
                "שם פריט": "לחם",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "נקה את הקניות",
          intent: { type: "ask" },
        },
        {
          utterance: "רק את האישית שלי",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_remove_item_ids",
                listType: "shopping",
                itemIds: ["eval-item-shop-milk"],
              },
              { type: "list_ops_empty" },
            ],
          },
        },
      ],
    },
    {
      id: "mt-complex-two-custom-lists",
      track: "mt",
      tags: ["lists-safety", "mt-complex", "multi-turn"],
      description: "Two custom lists same vibe → delete bugs shared twin",
      setup: {
        lists: [
          {
            list_id: "eval-list-custom-bugs-personal",
            list_type: "custom",
            name: "באגים",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-bug-p",
                "שם פריט": "באג אישי",
              },
            ],
          },
          {
            list_id: "eval-list-custom-bugs-shared",
            list_type: "custom",
            name: "באגים",
            owner: "טל",
            scope: "shared",
            shared_with: ["עמית"],
            items: [
              {
                item_id: "eval-item-bug-s",
                "שם פריט": "באג משותף",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "תמחק את רשימת באגים",
          intent: { type: "ask" },
        },
        {
          utterance: "את המשותפת עם עמית",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "list_ops_delete_list_ids",
                listIds: ["eval-list-custom-bugs-shared"],
              },
            ],
          },
        },
      ],
    },
    {
      id: "mt-complex-event-then-share-shop",
      track: "mt",
      tags: ["events", "share", "shopping", "mt-complex", "multi-turn"],
      description: "Create event host then share shopping with Amit",
      setup: {
        shoppingItems: [{ id: "eval-item-milk", label: "חלב" }],
      },
      turns: [
        {
          utterance: "צריך לארגן ערב פוקר",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "add",
                listType: "tasks",
                itemTextIncludes: "ערב פוקר",
              },
            ],
          },
        },
        {
          utterance: "תשתפי את הקניות עם עמית",
          intent: { type: "share_update", listType: "shopping" },
        },
      ],
    },
    {
      id: "full-mt-clarify-task-which",
      track: "full",
      tags: ["tasks", "mt-clarify", "full-live", "multi-turn"],
      description: "Clarify task done; meet remains",
      setup: {
        lists: [
          {
            list_id: "eval-list-tasks-personal",
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "eval-item-doctor",
                "שם מטלה": "להתקשר לרופא",
              },
              {
                item_id: "eval-item-meet",
                "שם מטלה": "פגישה עם עמית",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "סיימתי את זה",
          intent: { type: "ask" },
          outcome: {
            factsInclude: ["רופא", "עמית"],
          },
        },
        {
          utterance: "את הרופא",
          intent: {
            type: "remove_item",
            listType: "tasks",
            itemId: "eval-item-doctor",
          },
          outcome: {
            itemIdsAbsent: ["eval-item-doctor"],
            factsInclude: ["עמית"],
          },
        },
      ],
    },
    {
      id: "full-mt-multi-add-then-buy",
      track: "full",
      tags: ["shopping", "mt-multi-act", "full-live", "multi-turn"],
      description: "Add then buy yogurt; yogurt absent",
      setup: {
        lists: [
          {
            list_id: "eval-list-shopping-personal",
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [],
          },
        ],
      },
      turns: [
        {
          utterance: "תוסיפי יוגורט לקניות",
          intent: { type: "add_shopping", itemText: "יוגורט" },
          outcome: { factsInclude: ["יוגורט"] },
        },
        {
          utterance: "קניתי יוגורט",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_has_action",
                action: "remove",
                listType: "shopping",
                itemTextIncludes: "יוגורט",
              },
            ],
          },
          outcome: { factsExclude: ["יוגורט"] },
        },
      ],
    },
    {
      id: "full-mt-complex-personal-vs-shared",
      track: "full",
      tags: ["shopping", "share", "mt-complex", "full-live", "multi-turn"],
      description: "Clear personal only; shared bread kept",
      setup: {
        lists: [
          {
            list_id: "eval-list-shopping-personal",
            list_type: "shopping",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "eval-item-shop-milk", "שם פריט": "חלב" },
            ],
          },
          {
            list_id: "eval-list-shopping-shared",
            list_type: "shopping",
            owner: "טל",
            scope: "shared",
            shared_with: ["עמית"],
            items: [
              {
                item_id: "eval-item-shop-shared-bread",
                "שם פריט": "לחם",
              },
            ],
          },
        ],
      },
      turns: [
        {
          utterance: "נקה את הקניות",
          intent: { type: "ask" },
          outcome: {
            factsInclude: ["חלב", "לחם"],
          },
        },
        {
          utterance: "רק את האישית שלי",
          intent: {
            type: "custom",
            constraints: [
              {
                type: "lists_remove_item_ids",
                listType: "shopping",
                itemIds: ["eval-item-shop-milk"],
              },
              { type: "list_ops_empty" },
            ],
          },
          outcome: {
            itemIdsAbsent: ["eval-item-shop-milk"],
            factsInclude: ["לחם"],
          },
        },
      ],
    },
  );

  return drafts;
}

function main() {
  const stats = { added: 0, skipped: 0 };
  tagExistingMtFamilies();

  const all = [
    ...waveA1(),
    ...waveA2(),
    ...waveB(),
    ...waveC(),
    ...waveD(),
  ];

  const outDir = resolve(repoRoot, "docs/qa/studio/live-expand");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "all-waves-drafts.json"),
    `${JSON.stringify(all, null, 2)}\n`,
    "utf8",
  );

  for (const draft of all) {
    try {
      appendCompiled(draft, stats);
    } catch (err) {
      console.error(`FAIL ${draft.id}:`, (err as Error).message);
      throw err;
    }
  }

  mergeCriticals("model", [
    "shopping-add-milk",
    "task-empty-ask",
    "list-buy-milk",
    "shopping-empty-ask",
    "share-shop-with-amit",
    "share-ask-missing-partner",
    "event-host-create-poker",
    "filing-add-simple",
    "directory-add-michal",
    "reminder-create-relative",
    "task-done-doctor",
  ]);
  mergeCriticals("mt", [
    "mt-clarify-then-delete",
    "mt-ask-then-add",
    "mt-ambiguous-list-resolve",
    "mt-share-ask-then-partner",
    "mt-event-clarify-then-link",
    "mt-clarify-task-which",
    "mt-multi-add-then-buy",
    "mt-complex-personal-vs-shared-shop",
  ]);
  mergeCriticals("full", [
    "full-list-buy-milk",
    "full-shopping-add-milk",
    "full-mt-clarify-then-delete",
    "full-task-done-doctor",
    "full-list-clear-personal-shopping",
    "full-reminder-cancel-named",
    "full-filing-add-simple",
    "full-directory-add-michal",
    "full-share-shop-with-amit",
    "full-event-host-create-poker",
    "full-mt-event-clarify-then-link",
    "full-mt-clarify-task-which",
    "full-mt-multi-add-then-buy",
    "full-mt-complex-personal-vs-shared",
    "full-mt-share-ask-then-partner",
  ]);

  console.error(
    `expand-live-coverage: added=${stats.added} skipped=${stats.skipped} drafts=${all.length}`,
  );
  console.error(
    `MODEL=${loadCorpus("model").cases.length} MT=${loadCorpus("mt").cases.length} FULL=${loadCorpus("full").cases.length}`,
  );
}

main();
