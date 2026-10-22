/**
 * LIVE_FULL P0 harness/setup fixtures — offline only.
 * No Prisma, OpenAI, WhatsApp, reminder fire, or LIVE runners.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultLiveFullCorpusPath,
  loadLiveFullCorpus,
} from "../src/eval/corpus.js";
import {
  assertSetupListKeysIsolated,
  rewriteAliases,
  setupListSeedKey,
} from "../src/eval/run-multi-turn.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("LIVE_FULL P0 setup fixtures (offline, no I/O beyond corpus JSON)", () => {
  it("full-directory-remove-michal seeds contact-0 for UUID rewrite", () => {
    const corpus = loadLiveFullCorpus(defaultLiveFullCorpusPath());
    const row = corpus.cases.find((c) => c.id === "full-directory-remove-michal");
    expect(row).toBeTruthy();
    const contact = row!.setup?.contacts?.[0];
    expect(contact?.contact_id).toBe("contact-0");
    expect(contact?.name).toContain("מיכל");
    expect(String(contact?.phone ?? "").length).toBeGreaterThan(6);
  });

  it("rewriteAliases maps contact-0 → real UUID before apply", () => {
    const realId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(UUID_RE.test(realId)).toBe(true);
    const idMap = new Map([["contact-0", realId]]);
    const rewritten = rewriteAliases(
      {
        directory: [
          {
            action: "remove",
            name: "מיכל",
            phone: "",
            contact_id: "contact-0",
            contactId: "contact-0",
          },
        ],
      },
      idMap,
    ) as {
      directory: Array<{ contact_id: string; contactId: string }>;
    };
    expect(rewritten.directory[0]!.contact_id).toBe(realId);
    expect(rewritten.directory[0]!.contactId).toBe(realId);
  });

  it("full-mt-complex-personal-vs-shared keeps two isolated shopping lists", () => {
    const corpus = loadLiveFullCorpus(defaultLiveFullCorpusPath());
    const row = corpus.cases.find(
      (c) => c.id === "full-mt-complex-personal-vs-shared",
    );
    expect(row).toBeTruthy();
    const lists = row!.setup?.lists ?? [];
    expect(lists.length).toBe(2);
    expect(lists.map((l) => l.list_id).sort()).toEqual([
      "eval-list-shopping-personal",
      "eval-list-shopping-shared",
    ]);
    const personal = lists.find((l) => l.list_id === "eval-list-shopping-personal");
    const shared = lists.find((l) => l.list_id === "eval-list-shopping-shared");
    expect(personal?.list_type).toBe("shopping");
    expect(personal?.scope).toBe("personal");
    expect(shared?.list_type).toBe("shopping");
    expect(shared?.scope).toBe("shared");
    expect(shared?.shared_with).toContain("עמית");
    // Distinct (list_type, name) — required by EmployeeLists unique index.
    expect(setupListSeedKey(personal!)).not.toBe(setupListSeedKey(shared!));
    expect(() => assertSetupListKeysIsolated(lists)).not.toThrow();
    const personalItemIds = (personal?.items ?? []).map(
      (item) => (item as { item_id?: string }).item_id,
    );
    const sharedItemIds = (shared?.items ?? []).map(
      (item) => (item as { item_id?: string }).item_id,
    );
    expect(personalItemIds).toContain("eval-item-shop-milk");
    expect(sharedItemIds).toContain("eval-item-shop-shared-bread");
  });

  it("assertSetupListKeysIsolated rejects duplicate empty-name shopping", () => {
    expect(() =>
      assertSetupListKeysIsolated([
        { list_id: "a", list_type: "shopping", list_name: "" },
        { list_id: "b", list_type: "shopping", list_name: "" },
      ]),
    ).toThrow(/duplicate list identity/);
  });

  it("live-full corpus JSON has no duplicate list seed keys per case", () => {
    const raw = JSON.parse(
      readFileSync(defaultLiveFullCorpusPath(), "utf8"),
    ) as { cases: Array<{ id: string; setup?: { lists?: unknown[] } }> };
    for (const row of raw.cases) {
      const lists = (row.setup?.lists ?? []) as Array<{
        list_type?: string;
        list_name?: string;
        name?: string;
        list_id?: string;
      }>;
      expect(() => assertSetupListKeysIsolated(lists), row.id).not.toThrow();
    }
  });
});
