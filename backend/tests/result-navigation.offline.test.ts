/**
 * N1 — post-action result navigation. A row saved this turn (ApplyResult)
 * gets a direct, id-addressed item tap in every domain; the tap resolves
 * deterministically to an ITEM DUMP of exactly that row; the day tap of a
 * saved dated task outranks the generic list nav.
 */
import { emptyLlmMetadata, type LlmMetadata } from "@workee/shared";
import { describe, expect, it } from "vitest";
import { buildApplyResult } from "../src/services/apply-result.js";
import {
  formatItemNavRef,
  itemOpenAllTapCommand,
  itemOpenTapCommand,
  parseItemNavRef,
  stripItemNavRef,
} from "../src/services/builtin-lists.js";
import {
  ensureSpeakerShowButtons,
  savedItemNavsFromApplyResult,
} from "../src/services/employee-targets.service.js";
import {
  isKnownShowButtonCommand,
  mapShowButtonCommandToDumpTarget,
} from "../src/services/show-button-dump.js";
import { itemOpenButtonLabel } from "../src/services/whatsapp-send.js";
import { jerusalemYmd } from "../src/utils/relative-date.js";

const ID1 = "0b6f3c8e-1d2a-4f5b-9c7d-112233445566";
const ID2 = "7a1e2b3c-4d5e-4f60-8a9b-aabbccddeeff";
const ID3 = "c0ffee00-1234-4abc-8def-0123456789ab";

const emptyRequested = { lists: [], filing: [], reminders: [], directory: [], listOps: [] };

describe("item reference (opaque, in the tap command)", () => {
  it("round-trips UUIDs compactly and keeps the readable part", () => {
    const command = itemOpenTapCommand({ kind: "t", id: ID1 }, "תור לרופא");
    expect(command.startsWith("הציגי את המשימה תור לרופא ·#t:")).toBe(true);
    expect(parseItemNavRef(command)).toEqual([{ kind: "t", id: ID1 }]);
    expect(stripItemNavRef(command)).toBe("הציגי את המשימה תור לרופא");
    expect(formatItemNavRef([{ kind: "f", id: ID2 }]).length).toBeLessThan(30);
  });

  it("long titles are shortened so the command stays ≤256 and the ref survives", () => {
    const command = itemOpenTapCommand({ kind: "c", id: ID1 }, "א".repeat(400));
    expect(command.length).toBeLessThanOrEqual(256);
    expect(parseItemNavRef(command)).toEqual([{ kind: "c", id: ID1 }]);
  });

  it("plain text or a malformed reference is not a reference", () => {
    expect(parseItemNavRef("הציגי את המשימה תור לרופא")).toBeNull();
    expect(parseItemNavRef("הציגי את המשימה ·#x:abc")).toBeNull();
    expect(parseItemNavRef("·#t:")).toBeNull();
  });

  it("open-all tap holds several refs, and refuses when they do not fit", () => {
    const refs = [ID1, ID2, ID3].map((id) => ({ kind: "s" as const, id }));
    const command = itemOpenAllTapCommand(refs)!;
    expect(parseItemNavRef(command)).toEqual(refs);
    const many = Array.from({ length: 20 }, () => ({ kind: "t" as const, id: ID1 }));
    expect(itemOpenAllTapCommand(many)).toBeNull();
  });
});

describe("tap → ITEM DUMP target (deterministic)", () => {
  const snapshot = {
    lists: [
      {
        list_type: "custom",
        list_name: "מה מביאים · ערב פוקר",
        items: [{ item_id: ID1, שם: "קרח" }],
      },
    ],
  } as never;

  it("maps each kind to its dump with exactly those ids", () => {
    const at = (kind: "t" | "s" | "f" | "r" | "p") =>
      mapShowButtonCommandToDumpTarget(itemOpenTapCommand({ kind, id: ID2 }, "x"));
    expect(at("t")).toEqual({ kind: "tasks", ids: [ID2] });
    expect(at("s")).toEqual({ kind: "shopping", ids: [ID2] });
    expect(at("f")).toEqual({ kind: "filings", ids: [ID2] });
    expect(at("r")).toEqual({ kind: "reminders", ids: [ID2] });
    expect(at("p")).toEqual({ kind: "phone_book", ids: [ID2] });
  });

  it("custom row resolves its list from the snapshot; unknown → cross-kind full (still ids only)", () => {
    const cmd = itemOpenTapCommand({ kind: "c", id: ID1 }, "קרח");
    expect(mapShowButtonCommandToDumpTarget(cmd, snapshot)).toEqual({
      kind: "מה מביאים · ערב פוקר",
      ids: [ID1],
    });
    expect(mapShowButtonCommandToDumpTarget(cmd)).toEqual({ kind: "full", ids: [ID1] });
  });

  it("mixed kinds → full dump of only those ids; known to the inbound reply-context gate", () => {
    const cmd = itemOpenAllTapCommand([
      { kind: "t", id: ID1 },
      { kind: "r", id: ID2 },
    ])!;
    expect(mapShowButtonCommandToDumpTarget(cmd)).toEqual({ kind: "full", ids: [ID1, ID2] });
    expect(isKnownShowButtonCommand(cmd)).toBe(true);
  });

  it("title-only item-open (legacy) is not an engine dump — stays with the model", () => {
    expect(mapShowButtonCommandToDumpTarget("הציגי את המשימה תור לרופא")).toBeNull();
  });
});

describe("item tap labels", () => {
  it("title when it fits, kind fallback otherwise; ref never shown", () => {
    expect(
      itemOpenButtonLabel({ label: "x", command: itemOpenTapCommand({ kind: "s", id: ID1 }, "חלב") }),
    ).toBe("חלב");
    expect(
      itemOpenButtonLabel({
        label: "x",
        command: itemOpenTapCommand({ kind: "r", id: ID1 }, "להתקשר לאמא ולשאול על השבת"),
      }),
    ).toBe("להצגת התזכורת");
    expect(
      itemOpenButtonLabel({
        label: "x",
        command: itemOpenTapCommand({ kind: "p", id: ID1 }, "דני אינסטלטור מהבניין הסמוך"),
      }),
    ).toBe("להצגת איש הקשר");
    expect(
      itemOpenButtonLabel({ label: "הצג את 3 הפריטים", command: itemOpenAllTapCommand([{ kind: "t", id: ID1 }])! }),
    ).toBeNull();
  });
});

describe("saved rows come from ApplyResult only", () => {
  const result = buildApplyResult({
    requested: {
      ...emptyRequested,
      lists: [
        { action: "add", listType: "tasks", listName: "", items: [{ "שם משימה": "תור לרופא" }], targets: [] },
        { action: "update", listType: "shopping", listName: "", items: [{ item_id: ID2, "שם פריט": "חלב" }], targets: [] },
        { action: "remove", listType: "tasks", listName: "", items: [{ item_id: ID3 }], targets: [] },
      ] as never,
      filing: [{ action: "add_filing", itemName: "קוד שער", itemInfo: "1234", itemDescription: "", targets: [], filingId: "" }] as never,
      reminders: [{ action: "add", reminderId: "" }, { action: "add", reminderId: "" }] as never,
      directory: [{ action: "add", contactId: "" }] as never,
    },
    listMutations: [
      { action: "add", itemId: ID1, employeeId: "e", listType: "tasks", itemKey: "תור לרופא", itemLabel: "תור לרופא", calendarYmd: "2026-11-12" },
      { action: "update", itemId: ID2, employeeId: "e", listType: "shopping", itemKey: "חלב", itemLabel: "חלב" },
      { action: "remove", itemId: ID3, employeeId: "e", listType: "tasks", itemKey: "x", itemLabel: "x" },
      { action: "add", itemId: "", employeeId: "e", listType: "custom", listName: "ריקה", itemKey: "", itemLabel: "", listShell: true },
    ],
    filingMutations: [{ action: "add", itemName: "קוד שער", itemInfo: "1234", itemDescription: "", filingId: "f-111111" }],
    reminderResult: {
      saved: [{ id: "r-111111", itemLabel: "תור לרופא" }],
      missed: ["תזכורת שנכשלה"],
      skipped: [{ reason: "no_phone", item: "היי" }],
    },
    directoryResult: { saved: [{ id: "p-111111", name: "דני" }], removed: [] },
  });

  it("add + update in every domain; never removes, list shells, misses or skips", () => {
    expect(savedItemNavsFromApplyResult(result, undefined, new Set([ID2]))).toEqual([
      { ref: { kind: "t", id: ID1 }, title: "תור לרופא" },
      { ref: { kind: "s", id: ID2 }, title: "חלב" },
      { ref: { kind: "f", id: "f-111111" }, title: "קוד שער" },
      { ref: { kind: "r", id: "r-111111" }, title: "תור לרופא" },
      { ref: { kind: "p", id: "p-111111" }, title: "דני" },
    ]);
  });

  it("keeps only ids the speaker can open (worker-book / foreign rows drop)", () => {
    expect(
      savedItemNavsFromApplyResult(result, new Set([ID2, "p-111111"]), "all").map((row) => row.ref.id),
    ).toEqual([ID2, "p-111111"]);
  });

  it("a plain shopping row (no description, no file) gets no tap; one with detail does", () => {
    const ids = (detail: ReadonlySet<string> | "all" | undefined) =>
      savedItemNavsFromApplyResult(result, undefined, detail).map((row) => row.ref.id);
    expect(ids(undefined)).not.toContain(ID2);
    expect(ids(new Set(["other"]))).not.toContain(ID2);
    expect(ids(new Set([ID2]))).toContain(ID2);
    expect(ids("all")).toContain(ID2);
    // other domains are unaffected by the shopping rule
    expect(ids(undefined)).toEqual([ID1, "f-111111", "r-111111", "p-111111"]);
  });

  it("nothing applied → nothing to open", () => {
    const failed = buildApplyResult({
      requested: { ...emptyRequested, reminders: [{ action: "add", reminderId: "" }] as never },
      reminderResult: { saved: [], missed: ["x"] },
    });
    expect(savedItemNavsFromApplyResult(failed)).toEqual([]);
  });
});

describe("confirm taps with saved rows", () => {
  const now = new Date("2026-11-02T10:00:00.000Z");
  const today = jerusalemYmd(now);
  const day = (offset: number) => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + offset));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };
  const taskDay = day(11);
  const addTask = (): LlmMetadata => ({
    ...emptyLlmMetadata(),
    lists: [{ action: "add", listType: "tasks", listName: "", items: [{ "שם משימה": "ללמוד למבחן" }], targets: [] }],
  });
  const dayCommand = `מה יש לי ב־${taskDay} ברשימת משימות`;
  const appliedTask = {
    lists: [{ action: "add" as const, itemId: ID1, itemLabel: "ללמוד למבחן", listType: "tasks", calendarYmd: taskDay }],
    filings: [],
  };

  it("single saved task: direct tap + its day + list nav", () => {
    const out = ensureSpeakerShowButtons(addTask(), [], {
      appliedNav: { listKeys: new Set(["tasks"]), filing: false },
      appliedItems: appliedTask,
      savedItems: [{ ref: { kind: "t", id: ID1 }, title: "ללמוד למבחן" }],
      now,
    });
    expect(out.map((b) => b.command)).toEqual([
      itemOpenTapCommand({ kind: "t", id: ID1 }, "ללמוד למבחן"),
      dayCommand,
      "הצג רשימת משימות",
    ]);
  });

  it("a-exam shape: reminder net + item + day + list → day kept, a generic nav yields", () => {
    const meta = { ...addTask(), reminders: [{ action: "add" }] } as unknown as LlmMetadata;
    const out = ensureSpeakerShowButtons(meta, [], {
      appliedNav: { listKeys: new Set(["tasks"]), filing: false },
      appliedItems: appliedTask,
      appliedReminders: { saved: 1, removed: 0 },
      savedItems: [{ ref: { kind: "t", id: ID1 }, title: "ללמוד למבחן" }],
      now,
    });
    expect(out).toHaveLength(3);
    expect(out.some((b) => b.command === dayCommand)).toBe(true);
    expect(out.some((b) => parseItemNavRef(b.command)?.[0]?.id === ID1)).toBe(true);
  });

  it("model item-open for the saved row keeps its label and gains the id reference", () => {
    const out = ensureSpeakerShowButtons(
      addTask(),
      [{ label: "ללמוד למבחן", command: "הציגי את המשימה ללמוד למבחן" }],
      {
        appliedNav: { listKeys: new Set(["tasks"]), filing: false },
        appliedItems: appliedTask,
        savedItems: [{ ref: { kind: "t", id: ID1 }, title: "ללמוד למבחן" }],
        now,
      },
    );
    const items = out.filter((b) => parseItemNavRef(b.command));
    expect(items).toEqual([
      { label: "ללמוד למבחן", command: itemOpenTapCommand({ kind: "t", id: ID1 }, "ללמוד למבחן") },
    ]);
  });

  it("two saved shopping rows → a direct tap each, then the list nav", () => {
    const meta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [{ action: "add", listType: "shopping", listName: "", items: [{ "שם פריט": "חלב" }, { "שם פריט": "לחם" }], targets: [] }],
    };
    const out = ensureSpeakerShowButtons(meta, [], {
      appliedNav: { listKeys: new Set(["shopping"]), filing: false },
      appliedItems: { lists: [], filings: [] },
      savedItems: [
        { ref: { kind: "s", id: ID1 }, title: "חלב" },
        { ref: { kind: "s", id: ID2 }, title: "לחם" },
      ],
      now,
    });
    expect(out.map((b) => parseItemNavRef(b.command)?.[0]?.id ?? b.command)).toEqual([
      ID1,
      ID2,
      "הצג רשימת קניות",
    ]);
  });

  it("several saved rows that do not fit → one exact-ids tap, day kept", () => {
    const meta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        { action: "add", listType: "shopping", listName: "", items: [{ "שם פריט": "חלב" }, { "שם פריט": "לחם" }], targets: [] },
        { action: "add", listType: "tasks", listName: "", items: [{ "שם משימה": "ברביקיו" }], targets: [] },
      ],
    };
    const out = ensureSpeakerShowButtons(meta, [], {
      appliedNav: { listKeys: new Set(["tasks", "shopping"]), filing: false },
      appliedItems: {
        lists: [{ action: "add", itemId: ID3, itemLabel: "ברביקיו", listType: "tasks", calendarYmd: taskDay }],
        filings: [],
      },
      savedItems: [
        { ref: { kind: "s", id: ID1 }, title: "חלב" },
        { ref: { kind: "s", id: ID2 }, title: "לחם" },
        { ref: { kind: "t", id: ID3 }, title: "ברביקיו" },
      ],
      now,
    });
    expect(out).toHaveLength(3);
    expect(out.some((b) => b.command === dayCommand)).toBe(true);
    const all = out.find((b) => (parseItemNavRef(b.command)?.length ?? 0) > 1);
    expect(all?.label).toBe("הצג את 3 הפריטים");
    expect(parseItemNavRef(all!.command)!.map((r) => r.id)).toEqual([ID1, ID2, ID3]);
  });

  const gatheringMeta = (): LlmMetadata => ({
    ...emptyLlmMetadata(),
    lists: [
      { action: "add", listType: "tasks", listName: "", items: [{ "שם משימה": "ברביקיו" }], targets: [] },
      { action: "add", listType: "custom", listName: "מה מביאים · ברביקיו", items: [{ x: "בשר" }, { x: "סלטים" }], targets: [] },
    ],
  });
  const gatheringOptions = () => ({
    appliedNav: { listKeys: new Set(["tasks", "custom:מה מביאים · ברביקיו"]), filing: false },
    appliedItems: {
      lists: [{ action: "add" as const, itemId: ID3, itemLabel: "ברביקיו", listType: "tasks", calendarYmd: taskDay }],
      filings: [],
    },
    // The two rows of the new list are not saved-item taps (new list → list nav).
    savedItems: [{ ref: { kind: "t" as const, id: ID3 }, title: "ברביקיו" }],
    newListKeys: new Set(["custom:מה מביאים · ברביקיו"]),
    now,
  });

  it("so-gathering: host task tap + the new list's nav + the day; follow-up taps yield", () => {
    const out = ensureSpeakerShowButtons(
      gatheringMeta(),
      [
        { label: "מה מביאים", command: "הצג רשימת מה מביאים · ברביקיו" },
        { label: "שעה", command: "נקבע שעה לברביקיו" },
      ],
      gatheringOptions(),
    );
    expect(out.map((b) => b.command)).toEqual([
      "הצג רשימת מה מביאים · ברביקיו",
      itemOpenTapCommand({ kind: "t", id: ID3 }, "ברביקיו"),
      dayCommand,
    ]);
  });

  it("so-gathering (LIVE n1 shape, model gave only follow-up taps): list nav comes from the safety-net", () => {
    const out = ensureSpeakerShowButtons(
      gatheringMeta(),
      [
        { label: "איפה עושים", command: "איפה עושים את הברביקיו" },
        { label: "שתייה", command: "מה להביא לשתייה לברביקיו" },
      ],
      gatheringOptions(),
    );
    expect(out).toHaveLength(3);
    expect(out.some((b) => b.command === dayCommand)).toBe(true);
    expect(out.some((b) => b.command === "הצג רשימת מה מביאים · ברביקיו")).toBe(true);
    expect(out.some((b) => parseItemNavRef(b.command)?.[0]?.id === ID3)).toBe(true);
  });

  it("new list with several rows → one «הצג רשימה», no per-row taps", () => {
    const created = buildApplyResult({
      requested: {
        ...emptyRequested,
        lists: [{ action: "add", listType: "custom", listName: "מערכת שעות", items: [{}, {}, {}], targets: [] }] as never,
      },
      listMutations: ["מתמטיקה", "ביולוגיה", "אנגלית"].map((label, i) => ({
        action: "add" as const,
        itemId: [ID1, ID2, ID3][i]!,
        employeeId: "e",
        listType: "custom",
        listName: "מערכת שעות",
        itemKey: label,
        itemLabel: label,
        inNewList: true,
      })),
    });
    const saved = savedItemNavsFromApplyResult(created);
    expect(saved).toEqual([]);
    const out = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [{ action: "add", listType: "custom", listName: "מערכת שעות", items: [{}, {}, {}], targets: [] }],
      },
      [],
      {
        appliedNav: { listKeys: new Set(["custom:מערכת שעות"]), filing: false },
        appliedItems: { lists: [], filings: [] },
        savedItems: saved,
        newListKeys: new Set(["custom:מערכת שעות"]),
        now,
      },
    );
    expect(out.map((b) => b.command)).toEqual(["הצג רשימת מערכת שעות"]);
  });

  it("row added to an existing custom list → direct tap to that row (+ the list nav)", () => {
    const added = buildApplyResult({
      requested: {
        ...emptyRequested,
        lists: [{ action: "add", listType: "custom", listName: "מה מביאים", items: [{}], targets: [] }] as never,
      },
      listMutations: [
        { action: "add", itemId: ID1, employeeId: "e", listType: "custom", listName: "מה מביאים", itemKey: "קרח", itemLabel: "קרח" },
      ],
    });
    const saved = savedItemNavsFromApplyResult(added);
    expect(saved).toEqual([{ ref: { kind: "c", id: ID1 }, title: "קרח" }]);
    const out = ensureSpeakerShowButtons(
      {
        ...emptyLlmMetadata(),
        lists: [{ action: "add", listType: "custom", listName: "מה מביאים", items: [{}], targets: [] }],
      },
      [],
      {
        appliedNav: { listKeys: new Set(["custom:מה מביאים"]), filing: false },
        appliedItems: { lists: [], filings: [] },
        savedItems: saved,
        now,
      },
    );
    expect(out.map((b) => parseItemNavRef(b.command)?.[0]?.id ?? b.command)).toEqual([
      ID1,
      "הצג רשימת מה מביאים",
    ]);
  });

  it("no saved rows (failed apply) → no item tap, existing nav unchanged", () => {
    const out = ensureSpeakerShowButtons(addTask(), [], {
      appliedNav: { listKeys: new Set(["tasks"]), filing: false },
      appliedItems: { lists: [], filings: [] },
      savedItems: [],
      now,
    });
    expect(out.some((b) => parseItemNavRef(b.command))).toBe(false);
  });
});
