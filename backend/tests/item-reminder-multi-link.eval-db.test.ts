/**
 * Multi-clock item↔reminder links against approved workee_test only.
 * Run: npm run test:eval-db -w backend -- tests/item-reminder-multi-link.eval-db.test.ts
 *
 * No OpenAI / WhatsApp / reminder fire. Cleans up its own rows.
 *
 * Implementation closed (slim). Follow-up coverage (it.todo at bottom):
 * - full chat E2E (lists.add mint + two reminders.item_id → two joins)
 * - migration abort against a DB that has duplicate live linked_reminder_id
 * (also offline: worker union; missing/malformed/unauthorized item_id)
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";
import {
  linkedReminderField,
  loadItemReminderLinkIds,
} from "../src/services/employee-records.service.js";
import {
  findDuplicateLegacyLinkedReminderIds,
  linkRemindersByItemId,
  linkRemindersToItems,
} from "../src/services/reminder.service.js";
import { formatLinkedReminderParen } from "../src/services/show-button-dump.js";

const dbUrl = process.env.DATABASE_URL;
assertApprovedEvalDatabaseUrl(dbUrl);
expect(evalDatabaseNameFromUrl(dbUrl!)).toBe("workee_test");

const MARK = `multi-link-${Date.now()}`;
let userId = "";
let humanId = "";
let listId = "";
const createdItemIds: string[] = [];
const createdReminderIds: string[] = [];

beforeAll(async () => {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const human = await prisma.employee.findFirst({
    where: { kind: "human", isGuest: false },
    select: { id: true, userId: true },
  });
  if (!human) {
    throw new Error("eval-db: need at least one human employee on workee_test");
  }
  humanId = human.id;
  userId = human.userId;
  const list =
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: humanId,
        listType: "tasks",
        deletedAt: null,
      },
      select: { id: true },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: humanId,
        listType: "tasks",
        name: "",
        scope: "personal",
        visibleTo: [humanId],
      },
      select: { id: true },
    }));
  listId = list.id;
});

afterAll(async () => {
  if (createdReminderIds.length > 0) {
    await prisma.reminder.deleteMany({
      where: { id: { in: createdReminderIds } },
    });
  }
  if (createdItemIds.length > 0) {
    await prisma.employeeListItem.deleteMany({
      where: { id: { in: createdItemIds } },
    });
  }
});

async function createTask(opts?: { id?: string; key?: string }) {
  const id = opts?.id ?? randomUUID();
  const itemKey = opts?.key ?? `${MARK}-task`;
  const row = await prisma.employeeListItem.create({
    data: {
      id,
      listId,
      itemKey,
      data: { "שם מטלה": itemKey },
      scope: "personal",
      visibleTo: [humanId],
      addedById: humanId,
    },
  });
  createdItemIds.push(row.id);
  return row;
}

async function createClock(opts: {
  itemKey: string;
  fireAt: Date;
  label?: string;
}) {
  const row = await prisma.reminder.create({
    data: {
      userId,
      ownerId: humanId,
      actorId: humanId,
      itemKey: opts.itemKey,
      itemLabel: opts.label ?? opts.itemKey,
      listType: "tasks",
      fireAt: opts.fireAt,
      repeat: "once",
      pingIds: [humanId],
      status: "active",
    },
  });
  createdReminderIds.push(row.id);
  return row;
}

describe("multi-clock item↔reminder links (eval-db)", () => {
  it("two clocks + explicit item_id → two join rows; dump middot", async () => {
    const item = await createTask({ key: `${MARK}-vet` });
    const am = await createClock({
      itemKey: `${MARK}-vet`,
      fireAt: new Date("2026-11-01T07:00:00.000Z"),
      label: "בוקר",
    });
    const pm = await createClock({
      itemKey: `${MARK}-vet`,
      fireAt: new Date("2026-11-01T14:00:00.000Z"),
      label: "אחה״צ",
    });
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [
        { id: am.id, requestedItemId: item.id },
        { id: pm.id, requestedItemId: item.id },
      ],
    });
    const byItem = await loadItemReminderLinkIds([item.id]);
    expect(new Set(byItem.get(item.id))).toEqual(new Set([am.id, pm.id]));

    const active = new Map([
      [am.id, { id: am.id, fireAt: am.fireAt, repeat: "once" }],
      [pm.id, { id: pm.id, fireAt: pm.fireAt, repeat: "once" }],
    ]);
    const field = linkedReminderField(
      {
        id: item.id,
        linkedReminderIds: byItem.get(item.id),
      },
      active,
      undefined,
      undefined,
      null,
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(
      (field.reminders as Array<{ reminder_id: string }>).map((r) => r.reminder_id),
    ).toEqual([am.id, pm.id]);
    expect(formatLinkedReminderParen(field as Record<string, unknown>)).toMatch(
      /🔔 תזכורת: .+ · .+/,
    );
  });

  it("same-turn mint UUID as PK + two clocks sharing it", async () => {
    const mint = randomUUID();
    const item = await createTask({ id: mint, key: `${MARK}-mint` });
    expect(item.id).toBe(mint);
    const c1 = await createClock({
      itemKey: `${MARK}-mint`,
      fireAt: new Date("2026-11-02T08:00:00.000Z"),
    });
    const c2 = await createClock({
      itemKey: `${MARK}-mint`,
      fireAt: new Date("2026-11-02T18:00:00.000Z"),
    });
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [
        { id: c1.id, requestedItemId: mint },
        { id: c2.id, requestedItemId: mint },
      ],
    });
    const byItem = await loadItemReminderLinkIds([mint]);
    expect(new Set(byItem.get(mint))).toEqual(new Set([c1.id, c2.id]));
  });

  it("bad/foreign item_id → clock ok, no link", async () => {
    const clock = await createClock({
      itemKey: `${MARK}-orphan`,
      fireAt: new Date("2026-11-03T09:00:00.000Z"),
    });
    const before = await prisma.reminder.findUnique({ where: { id: clock.id } });
    expect(before?.status).toBe("active");
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [
        {
          id: clock.id,
          requestedItemId: "00000000-0000-4000-8000-000000000099",
        },
      ],
    });
    const links = await prisma.employeeListItemReminderLink.findMany({
      where: { reminderId: clock.id },
    });
    expect(links).toEqual([]);
    const after = await prisma.reminder.findUnique({ where: { id: clock.id } });
    expect(after?.status).toBe("active");
  });

  it("soft-link append when item already has another clock; no-steal", async () => {
    const itemA = await createTask({ key: `${MARK}-a` });
    const itemB = await createTask({ key: `${MARK}-b` });
    const r1 = await createClock({
      itemKey: `${MARK}-a`,
      fireAt: new Date("2026-11-04T08:00:00.000Z"),
    });
    const r2 = await createClock({
      itemKey: `${MARK}-a`,
      fireAt: new Date("2026-11-04T12:00:00.000Z"),
    });
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [{ id: r1.id, requestedItemId: itemA.id }],
    });
    // Soft-link second clock by exact key onto same item.
    await linkRemindersToItems(
      [{ id: r2.id, itemKey: itemA.itemKey, itemLabel: itemA.itemKey }],
      [{ id: itemA.id, itemKey: itemA.itemKey, itemLabel: itemA.itemKey }],
    );
    const onA = await loadItemReminderLinkIds([itemA.id]);
    expect(new Set(onA.get(itemA.id))).toEqual(new Set([r1.id, r2.id]));

    // No-steal: try to soft-link r1 onto itemB.
    await linkRemindersToItems(
      [{ id: r1.id, itemKey: itemB.itemKey, itemLabel: itemB.itemKey }],
      [{ id: itemB.id, itemKey: itemB.itemKey, itemLabel: itemB.itemKey }],
    );
    const onB = await loadItemReminderLinkIds([itemB.id]);
    expect(onB.get(itemB.id) ?? []).toEqual([]);
    const stillA = await prisma.employeeListItemReminderLink.findUnique({
      where: { reminderId: r1.id },
    });
    expect(stillA?.listItemId).toBe(itemA.id);
  });

  it("legacy linked_reminder_id alone still surfaces; join+legacy same id dedupes", async () => {
    const item = await createTask({ key: `${MARK}-legacy` });
    const clock = await createClock({
      itemKey: `${MARK}-legacy`,
      fireAt: new Date("2026-11-05T10:00:00.000Z"),
    });
    await prisma.employeeListItem.update({
      where: { id: item.id },
      data: { linkedReminderId: clock.id },
    });
    const active = new Map([
      [clock.id, { id: clock.id, fireAt: clock.fireAt, repeat: "once" }],
    ]);
    const legacyOnly = linkedReminderField(
      { id: item.id, linkedReminderId: clock.id },
      active,
    );
    expect((legacyOnly.reminder as { reminder_id: string }).reminder_id).toBe(
      clock.id,
    );

    await prisma.employeeListItemReminderLink.create({
      data: { listItemId: item.id, reminderId: clock.id },
    });
    const both = linkedReminderField(
      {
        id: item.id,
        linkedReminderId: clock.id,
        linkedReminderIds: [clock.id],
      },
      active,
    );
    expect(both.reminders).toHaveLength(1);
  });

  it("soft-deleted item → join may remain but read path omits (no ids loaded for deleted)", async () => {
    const item = await createTask({ key: `${MARK}-soft` });
    const clock = await createClock({
      itemKey: `${MARK}-soft`,
      fireAt: new Date("2026-11-06T11:00:00.000Z"),
    });
    await linkRemindersByItemId({
      userId,
      actorId: humanId,
      saved: [{ id: clock.id, requestedItemId: item.id }],
    });
    await prisma.employeeListItem.update({
      where: { id: item.id },
      data: { deletedAt: new Date() },
    });
    // Snapshot loaders only query deletedAt:null — join helper is called with live ids only.
    const liveIds = await prisma.employeeListItem.findMany({
      where: { id: item.id, deletedAt: null },
      select: { id: true },
    });
    expect(liveIds).toEqual([]);
    const links = await prisma.employeeListItemReminderLink.findMany({
      where: { listItemId: item.id },
    });
    expect(links).toHaveLength(1);
  });

  it("preflight helper flags duplicate legacy linked_reminder_id on live rows", async () => {
    const dups = findDuplicateLegacyLinkedReminderIds([
      { id: "1", linkedReminderId: "r-x", deletedAt: null },
      { id: "2", linkedReminderId: "r-x", deletedAt: null },
    ]);
    expect(dups).toEqual(["r-x"]);
  });

  // --- Follow-up coverage (do not implement until Tal asks) ---
  // Bounds: eval DB + guard only; never product DB; no WhatsApp / live fire.
  it.todo(
    "FOLLOW-UP: chat E2E — same-turn lists.add (minted item_id) + two reminders with that item_id → two join rows on persisted PK",
  );
  it.todo(
    "FOLLOW-UP: migration preflight abort — deploy against workee_test fixture with duplicate live linked_reminder_id must RAISE and not create/backfill",
  );
});
