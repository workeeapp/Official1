/**
 * Unified-share integration C1–C4 on approved workee_test only.
 *
 * Production apply path (planTargetedActions → applyEmployeeRecords) +
 * spoken reply correction + bubble↔show-button attach.
 * Speaker LIST/collab nav uses appliedNav + collabByListKey from mutations
 * (same shape as chat.service) — never ACTION targets alone.
 * Stub model ACTION only — no OpenAI / LIVE / WhatsApp / reminder fire.
 *
 * Run: npm run test:eval-db -- tests/share-unified-c1c4.eval-db.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyShowButtonsToBubbles,
  emptyLlmMetadata,
  parseLlmReply,
  type LlmMetadata,
  type LlmReplyButton,
  type LlmSpokenBubble,
} from "@workee/shared";
import {
  applyEmployeeRecords,
  correctShareClaimReply,
  getEmployeeRecordSnapshot,
  loadListItemOwners,
  readItemId,
  type ListItemMutation,
  type ShareApplyMiss,
} from "../src/services/employee-records.service.js";
import {
  buildCollabByListKey,
  employeeDisplayName,
  ensureSpeakerShowButtons,
  listNavKeyFromMutation,
  planTargetedActions,
} from "../src/services/employee-targets.service.js";
import { setEngineResponse } from "../src/services/whatsapp-send.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import {
  createHarnessAccount,
  destroyHarnessAccount,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { prisma } from "../src/database/prisma.js";

const SPEAKER = "טל";
const PARTNER_A = "עמית";
const PARTNER_B = "מיכל";

beforeAll(() => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const u = new URL(process.env.DATABASE_URL!);
  expect(u.pathname.replace(/^\//, "").split("/")[0]).toBe("workee_test");
  expect(process.env.WORKEE_EVAL_ENV_LOCKED).toBe("1");
});

async function applyLikeChat(
  account: HarnessAccount,
  metadata: LlmMetadata,
): Promise<{
  mutations: ListItemMutation[];
  shareMisses: ShareApplyMiss[];
  plan: ReturnType<typeof planTargetedActions>;
}> {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const itemIds = (metadata.lists ?? []).flatMap((list) =>
    list.items
      .map((raw) => readItemId(raw as Record<string, unknown>))
      .filter(Boolean),
  );
  const itemOwners = await loadListItemOwners(account.userId, itemIds);
  const plan = planTargetedActions({
    actor: account.actor,
    employees: account.employees,
    metadata,
    itemOwners,
  });
  const mutations: ListItemMutation[] = [];
  const shareMisses: ShareApplyMiss[] = [];
  for (const application of plan.applications) {
    const applied = await applyEmployeeRecords(
      application.employeeId,
      application.metadata,
      application.visibility,
      account.actor.id,
    );
    mutations.push(...applied.mutations);
    shareMisses.push(...applied.shareMisses);
  }
  return { mutations, shareMisses, plan };
}

function spokenReply(text: string, metadata: LlmMetadata): string {
  return JSON.stringify({
    responses: [text],
    metadata,
  });
}

/** Same appliedNav + collabByListKey shape as chat.service production wiring. */
function speakerNavFromApply(
  account: HarnessAccount,
  mutations: ListItemMutation[],
): {
  listKeys: Set<string>;
  collabByListKey: ReturnType<typeof buildCollabByListKey>;
} {
  const nameById = new Map(
    account.employees.map((row) => [row.id, employeeDisplayName(row)]),
  );
  return {
    listKeys: new Set(mutations.map((row) => listNavKeyFromMutation(row))),
    collabByListKey: buildCollabByListKey(mutations, nameById),
  };
}

function finalizeUserFacing(input: {
  claim: string;
  metadata: LlmMetadata;
  mutations: ListItemMutation[];
  shareMisses: ShareApplyMiss[];
  speakerNames: string[];
  account: HarnessAccount;
  /** Model-emitted taps (LIST/collab/כן…) — engine validates, does not invent collab. */
  modelButtons?: LlmReplyButton[];
}): {
  spoken: string;
  bubbles: LlmSpokenBubble[];
  buttons: ReturnType<typeof ensureSpeakerShowButtons>;
  collabByListKey: ReturnType<typeof buildCollabByListKey>;
  listKeys: Set<string>;
} {
  let reply = spokenReply(input.claim, input.metadata);
  reply = correctShareClaimReply({
    reply,
    spoken: parseLlmReply(reply).response,
    mutations: input.mutations,
    misses: input.shareMisses,
    setResponse: setEngineResponse,
  });
  const spoken = parseLlmReply(reply).response.trim();
  const { listKeys, collabByListKey } = speakerNavFromApply(
    input.account,
    input.mutations,
  );
  const buttons = ensureSpeakerShowButtons(
    input.metadata,
    input.modelButtons ?? [],
    {
      speakerNames: input.speakerNames,
      appliedNav: {
        listKeys,
        filing: false,
        collabByListKey,
      },
    },
  );
  const bubbles = applyShowButtonsToBubbles([{ text: spoken }], buttons);
  return { spoken, bubbles, buttons, collabByListKey, listKeys };
}

async function seedPersonalShopping(
  account: HarnessAccount,
  labels: string[],
): Promise<string[]> {
  const meta: LlmMetadata = {
    ...emptyLlmMetadata(),
    lists: [
      {
        action: "add",
        listType: "shopping",
        listName: "",
        items: labels.map((label) => ({ "שם פריט": label })),
        targets: [],
      },
    ],
  };
  const { mutations } = await applyLikeChat(account, meta);
  const ids = mutations
    .filter((row) => row.action === "add" && row.listType === "shopping")
    .map((row) => row.itemId);
  expect(ids.length).toBe(labels.length);
  return ids;
}

async function liveItem(itemId: string) {
  return prisma.employeeListItem.findFirst({
    where: { id: itemId, deletedAt: null },
    include: { list: { select: { employeeId: true, listType: true } } },
  });
}

describe("unified share C1–C4 (eval-db integration)", () => {
  let account: HarnessAccount | null = null;

  afterEach(async () => {
    if (account) {
      await destroyHarnessAccount(account);
      account = null;
    }
  });

  it("C1: bulk co-share — DB visible_to + reply + show buttons on bubble", async () => {
    account = await createHarnessAccount(SPEAKER, {
      partners: [PARTNER_A, PARTNER_B],
    });
    const amit = account.partners.find((p) => p.name === PARTNER_A)!;
    const ids = await seedPersonalShopping(account, [
      "חלב-C1",
      "לחם-C1",
    ]);

    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update",
          listType: "shopping",
          listName: "",
          items: ids.map((id) => ({ item_id: id })),
          targets: [SPEAKER, PARTNER_A],
        },
      ],
    };
    const { mutations, shareMisses, plan } = await applyLikeChat(
      account,
      metadata,
    );

    expect(plan.applications).toHaveLength(1);
    expect(plan.applications[0]?.employeeId).toBe(account.employeeId);
    expect(shareMisses).toEqual([]);
    expect(
      mutations.filter((m) => m.shareOutcome?.newlySharedCount === 1),
    ).toHaveLength(2);

    for (const id of ids) {
      const row = await liveItem(id);
      expect(row?.list.employeeId).toBe(account.employeeId);
      expect(row?.scope).toBe("shared");
      expect(row?.visibleTo as string[]).toEqual(
        expect.arrayContaining([account.employeeId, amit.id]),
      );
    }

    const facing = finalizeUserFacing({
      claim: "שיתפתי את שני הפריטים עם עמית.",
      metadata,
      mutations,
      shareMisses,
      speakerNames: [SPEAKER, "Tal"],
      account,
    });
    // Full new-share success keeps the model claim.
    expect(facing.spoken).toBe("שיתפתי את שני הפריטים עם עמית.");
    expect(facing.buttons.some((b) => /קניות|shared-with|משותף/i.test(b.command) || /משותף|קניות/.test(b.label))).toBe(
      true,
    );
    expect(facing.bubbles[0]?.buttons?.length ?? 0).toBeGreaterThan(0);
    expect(facing.bubbles[0]?.text).toBe(facing.spoken);
  });

  it("C2: bulk assign fan-out — rows on assignee book + assigned_by + buttons", async () => {
    account = await createHarnessAccount(SPEAKER, {
      partners: [PARTNER_A, PARTNER_B],
    });
    const amit = account.partners.find((p) => p.name === PARTNER_A)!;

    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "יוגורט-C2" }, { "שם פריט": "גבינה-C2" }],
          targets: [PARTNER_A],
        },
      ],
    };
    const { mutations, shareMisses, plan } = await applyLikeChat(
      account,
      metadata,
    );

    expect(plan.applications.every((a) => a.employeeId === amit.id)).toBe(true);
    expect(shareMisses).toEqual([]);
    expect(mutations.filter((m) => m.action === "add")).toHaveLength(2);

    const snap = await getEmployeeRecordSnapshot(amit.id);
    const shopping = snap.lists.find((l) => l.list_type === "shopping");
    const labels = (shopping?.items ?? []).map((item) =>
      JSON.stringify(item),
    );
    expect(labels.some((s) => s.includes("יוגורט-C2"))).toBe(true);
    expect(labels.some((s) => s.includes("גבינה-C2"))).toBe(true);
    expect(
      (shopping?.items ?? []).some(
        (item) =>
          (item as { assigned_by?: string }).assigned_by === SPEAKER ||
          JSON.stringify(item).includes("באחריות"),
      ),
    ).toBe(true);

    const facing = finalizeUserFacing({
      claim: "הטלתי על עמית שני פריטים לקניות.",
      metadata,
      mutations,
      shareMisses,
      speakerNames: [SPEAKER, "Tal"],
      account,
    });
    // Assign claim is not a «שיתפתי» past-tense share claim — left as-is.
    expect(facing.spoken).toContain("עמית");
    expect(
      facing.buttons.some(
        (b) =>
          b.command.includes("באחריות") ||
          b.label.includes("באחריות") ||
          b.command.includes(PARTNER_A) ||
          b.label.includes(PARTNER_A),
      ),
    ).toBe(true);
    expect(facing.bubbles[0]?.buttons?.some((b) => b.command === facing.buttons[0]?.command || facing.buttons.some((x) => x.command === b.command))).toBe(
      true,
    );
  });

  it("C3: co-share + assign mixture — distinct DB homes + collab buttons", async () => {
    account = await createHarnessAccount(SPEAKER, {
      partners: [PARTNER_A, PARTNER_B],
    });
    const amit = account.partners.find((p) => p.name === PARTNER_A)!;
    const michal = account.partners.find((p) => p.name === PARTNER_B)!;

    const coShareMeta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "חלב-C3-share" }],
          targets: [SPEAKER, PARTNER_A],
        },
      ],
    };
    const assignMeta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "לחם-C3-assign" }],
          targets: [PARTNER_B],
        },
      ],
    };

    const co = await applyLikeChat(account, coShareMeta);
    const asg = await applyLikeChat(account, assignMeta);

    expect(co.plan.applications.map((a) => a.employeeId)).toEqual([
      account.employeeId,
    ]);
    expect(asg.plan.applications.map((a) => a.employeeId)).toEqual([
      michal.id,
    ]);

    const speakerSnap = await getEmployeeRecordSnapshot(account.employeeId);
    const speakerShop = speakerSnap.lists.find((l) => l.list_type === "shopping");
    const speakerBlob = JSON.stringify(speakerShop?.items ?? []);
    expect(speakerBlob).toContain("חלב-C3-share");
    expect(speakerBlob).not.toContain("לחם-C3-assign");

    // Resolve by apply mutation ids (itemKey label is derived — do not string-match).
    const coItemId = co.mutations.find((m) => m.action === "add")?.itemId;
    expect(coItemId).toBeTruthy();
    const coRow = await liveItem(coItemId!);
    expect(coRow?.list.employeeId).toBe(account.employeeId);
    expect(coRow?.scope).toBe("shared");
    expect(coRow?.visibleTo as string[]).toEqual(
      expect.arrayContaining([account.employeeId, amit.id]),
    );

    const assignItemId = asg.mutations.find((m) => m.action === "add")?.itemId;
    expect(assignItemId).toBeTruthy();
    const assignRow = await liveItem(assignItemId!);
    expect(assignRow?.list.employeeId).toBe(michal.id);
    expect(assignRow?.addedById).toBe(account.employeeId);

    const combinedMeta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [...coShareMeta.lists, ...assignMeta.lists],
    };
    const buttons = ensureSpeakerShowButtons(combinedMeta, [], {
      speakerNames: [SPEAKER, "Tal"],
    });
    const commands = buttons.map((b) => b.command);
    expect(commands.some((c) => c.includes("משותף") || /shared-with|עם/.test(c) || buttons.some((b) => b.label.includes("משותף")))).toBe(
      true,
    );
    expect(
      buttons.some(
        (b) =>
          b.label.includes("באחריות") ||
          b.command.includes("באחריות") ||
          b.label.includes(PARTNER_B),
      ),
    ).toBe(true);

    const claim = "שיתפתי חלב עם עמית והטלתי לחם על מיכל.";
    const facing = finalizeUserFacing({
      claim,
      metadata: coShareMeta,
      mutations: co.mutations,
      shareMisses: co.shareMisses,
      speakerNames: [SPEAKER, "Tal"],
      account,
    });
    expect(facing.bubbles[0]?.text).toBe(facing.spoken);
    expect(facing.bubbles[0]?.buttons?.length ?? 0).toBeGreaterThan(0);
  });

  it("C4: already-shared second turn — noop DB + corrected spoken reply", async () => {
    account = await createHarnessAccount(SPEAKER, {
      partners: [PARTNER_A],
    });
    const amit = account.partners.find((p) => p.name === PARTNER_A)!;
    const ids = await seedPersonalShopping(account, ["חלב-C4", "לחם-C4"]);

    const shareMeta: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update",
          listType: "shopping",
          listName: "",
          items: ids.map((id) => ({ item_id: id })),
          targets: [SPEAKER, PARTNER_A],
        },
      ],
    };

    const first = await applyLikeChat(account, shareMeta);
    expect(
      first.mutations.every((m) => m.shareOutcome?.newlySharedCount === 1),
    ).toBe(true);

    const before = await Promise.all(ids.map((id) => liveItem(id)));
    const second = await applyLikeChat(account, shareMeta);
    const after = await Promise.all(ids.map((id) => liveItem(id)));

    expect(second.shareMisses).toEqual([]);
    expect(
      second.mutations.every(
        (m) =>
          m.shareOutcome?.newlySharedCount === 0 &&
          m.shareOutcome?.alreadySharedCount === 1,
      ),
    ).toBe(true);
    for (let i = 0; i < ids.length; i++) {
      expect(after[i]?.updatedAt?.getTime()).toBe(before[i]?.updatedAt?.getTime());
      expect(after[i]?.visibleTo).toEqual(before[i]?.visibleTo);
      expect(after[i]?.visibleTo as string[]).toEqual(
        expect.arrayContaining([account!.employeeId, amit.id]),
      );
    }

    const facing = finalizeUserFacing({
      claim: "שיתפתי את שני הפריטים עם עמית.",
      metadata: shareMeta,
      mutations: second.mutations,
      shareMisses: second.shareMisses,
      speakerNames: [SPEAKER, "Tal"],
      account,
    });
    expect(facing.spoken).toBe(
      "הפריטים כבר משותפים — לא נוסף שיתוף חדש.",
    );
    expect(facing.bubbles[0]?.text).toBe(facing.spoken);
    expect(facing.bubbles[0]?.buttons?.length ?? 0).toBeGreaterThan(0);
  });

  it("collab nav evidence: successful share → model collab kept when collabApply proves it", async () => {
    account = await createHarnessAccount(SPEAKER, {
      partners: [PARTNER_A],
    });
    const amit = account.partners.find((p) => p.name === PARTNER_A)!;
    const ids = await seedPersonalShopping(account, ["חלב-nav-ok"]);

    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "update",
          listType: "shopping",
          listName: "",
          items: ids.map((id) => ({ item_id: id })),
          targets: [SPEAKER, PARTNER_A],
        },
      ],
    };
    const { mutations, shareMisses } = await applyLikeChat(account, metadata);
    expect(shareMisses).toEqual([]);
    expect(mutations.length).toBeGreaterThan(0);
    expect(
      mutations.every(
        (m) =>
          m.collabApply?.mode === "co_share" &&
          m.collabApply.partnerIds.includes(amit.id),
      ),
    ).toBe(true);
    expect(
      mutations.every((m) => m.shareOutcome?.newlySharedCount === 1),
    ).toBe(true);

    const modelCollab: LlmReplyButton[] = [
      {
        label: "משותף עם עמית",
        command: "הצג קניות משותפות עם עמית",
      },
    ];
    const facing = finalizeUserFacing({
      claim: "שיתפתי חלב עם עמית.",
      metadata,
      mutations,
      shareMisses,
      speakerNames: [SPEAKER, "Tal"],
      account,
      modelButtons: modelCollab,
    });
    expect(facing.listKeys.has("shopping")).toBe(true);
    expect(facing.collabByListKey.get("shopping")?.mode).toBe("co_share");
    expect(facing.collabByListKey.get("shopping")?.partnerNames).toContain(
      PARTNER_A,
    );
    expect(facing.buttons.map((b) => b.command)).toEqual([
      "הצג קניות משותפות עם עמית",
    ]);
    expect(facing.buttons[0]?.label).toBe("משותף עם עמית");
    // Safety net alone → plain LIST (never invents collab).
    const safetyOnly = finalizeUserFacing({
      claim: "שיתפתי חלב עם עמית.",
      metadata,
      mutations,
      shareMisses,
      speakerNames: [SPEAKER, "Tal"],
      account,
    });
    expect(safetyOnly.buttons.map((b) => b.command)).toEqual([
      "הצג רשימת קניות",
    ]);
  });

  it("collab nav evidence: failed share + personal add → plain LIST BUTTON via appliedNav", async () => {
    account = await createHarnessAccount(SPEAKER, {
      partners: [PARTNER_A],
    });
    // Missing id → apply shareMiss; personal add still lands on shopping.
    const missingId = "00000000-0000-4000-8000-00000000c011";
    const metadata: LlmMetadata = {
      ...emptyLlmMetadata(),
      lists: [
        {
          action: "add",
          listType: "shopping",
          listName: "",
          items: [{ "שם פריט": "לחם-nav-personal" }],
          targets: [],
        },
        {
          action: "update",
          listType: "shopping",
          listName: "",
          items: [{ item_id: missingId }],
          targets: [SPEAKER, PARTNER_A],
        },
      ],
    };
    // Prove ACTION still carries share targets (would falsely claim collab without appliedNav).
    expect(metadata.lists[1]?.targets).toEqual([SPEAKER, PARTNER_A]);

    const { mutations, shareMisses } = await applyLikeChat(account, metadata);
    expect(shareMisses.some((m) => m.reason === "missing")).toBe(true);
    const personalAdds = mutations.filter(
      (m) => m.action === "add" && m.listType === "shopping",
    );
    expect(personalAdds.length).toBe(1);
    expect(personalAdds.every((m) => !m.collabApply)).toBe(true);
    expect(mutations.every((m) => !m.collabApply)).toBe(true);

    const speakerNames = [SPEAKER, "Tal"];
    // Without appliedNav / model collab: safety net is plain LIST only (no invent).
    const legacyButtons = ensureSpeakerShowButtons(metadata, [], {
      speakerNames,
    });
    expect(
      legacyButtons.every(
        (b) =>
          !b.command.includes("משותפות") &&
          !b.label.includes("משותף עם") &&
          !b.command.includes("באחריות") &&
          !b.label.includes("באחריות"),
      ),
    ).toBe(true);
    expect(legacyButtons.map((b) => b.command)).toEqual(["הצג רשימת קניות"]);

    const facing = finalizeUserFacing({
      claim: "הוספתי לחם.",
      metadata,
      mutations,
      shareMisses,
      speakerNames,
      account,
    });
    // New path: appliedNav present, listKeys from personal save, collab map empty.
    expect(facing.listKeys.has("shopping")).toBe(true);
    expect(facing.listKeys.size).toBeGreaterThan(0);
    expect(facing.collabByListKey.size).toBe(0);
    expect(facing.buttons.map((b) => b.command)).toEqual([
      "הצג רשימת קניות",
    ]);
    expect(
      facing.buttons.every(
        (b) =>
          !b.command.includes("משותפ") &&
          !b.label.includes("משותף") &&
          !b.command.includes("באחריות") &&
          !b.label.includes("באחריות"),
      ),
    ).toBe(true);
  });
});
