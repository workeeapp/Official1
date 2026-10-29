/**
 * Contacts unify on isolated eval DB only (workee_test @ 127.0.0.1:5436).
 *
 * Usage (repo root):
 *   . .\scripts\Load-LiveFullEvalEnv.ps1
 *   npx tsx backend/scripts/contacts-unify-eval.ts dry-run
 *   npx tsx backend/scripts/contacts-unify-eval.ts apply
 *   npx tsx backend/scripts/contacts-unify-eval.ts verify
 *
 * Fail-closed: refuses unless DATABASE_URL === WORKEE_APPROVED_TEST_DATABASE_URL
 * and DB name is workee_test (never product `workee`).
 */
import { loadLiveFullEvalEnv, summarizeLiveFullEvalEnv } from "../src/eval/load-live-full-eval-env.js";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
  LIVE_FULL_REQUIRED_DATABASE_NAME,
} from "../src/eval/studio-db-guard.js";
import { prisma } from "../src/database/prisma.js";
import { createHarnessAccount } from "../src/eval/run-multi-turn.js";
import {
  applyContactsUnifyPlan,
  dryRunLooksSafe,
  loadContactsUnifyInventory,
  planContactsUnify,
} from "../src/services/contacts-unify.js";

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port || "(default)"}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

function assertEvalIdentity(): { host: string; port: string; db: string } {
  assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
  const url = process.env.DATABASE_URL!;
  const db = evalDatabaseNameFromUrl(url);
  if (db !== LIVE_FULL_REQUIRED_DATABASE_NAME) {
    throw new Error(
      `Refusing: database name must be ${LIVE_FULL_REQUIRED_DATABASE_NAME}, got ${db ?? "(none)"}`,
    );
  }
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error(`Refusing: host must be 127.0.0.1/localhost, got ${u.hostname}`);
  }
  if (u.port !== "5436") {
    throw new Error(`Refusing: port must be 5436, got ${u.port || "(default)"}`);
  }
  if (process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND !== "1") {
    throw new Error("Refusing: WORKEE_DISABLE_WHATSAPP_OUTBOUND must be 1");
  }
  if (process.env.WORKEE_DISABLE_REMINDER_FIRE !== "1") {
    throw new Error("Refusing: WORKEE_DISABLE_REMINDER_FIRE must be 1");
  }
  return { host: u.hostname, port: u.port, db };
}

async function countListContacts(): Promise<number> {
  return prisma.employeeListItem.count({
    where: {
      deletedAt: null,
      list: { deletedAt: null, listType: "contacts" },
    },
  });
}

/**
 * Deterministic fixture for preservation/idempotency checks on empty eval DB.
 * Tagged names so verify can find them; never touches product DB.
 */
async function seedEvalContactFixture(): Promise<{
  ownerEmployeeId: string;
  userId: string;
  listItemIds: string[];
  existingContactId: string;
}> {
  let human = await prisma.employee.findFirst({
    where: { kind: "human", isGuest: false },
    select: { id: true, userId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!human) {
    const account = await createHarnessAccount("EvalUnify");
    human = { id: account.employeeId, userId: account.userId };
  }
  const list =
    (await prisma.employeeList.findFirst({
      where: {
        employeeId: human.id,
        listType: "contacts",
        name: "",
        deletedAt: null,
      },
    })) ??
    (await prisma.employeeList.create({
      data: {
        employeeId: human.id,
        listType: "contacts",
        name: "",
        scope: "personal",
        visibleTo: [human.id],
      },
    }));

  const mkItem = async (key: string, data: Record<string, unknown>) => {
    const existing = await prisma.employeeListItem.findFirst({
      where: { listId: list.id, itemKey: key, deletedAt: null },
    });
    if (existing) return existing.id;
    const row = await prisma.employeeListItem.create({
      data: {
        listId: list.id,
        itemKey: key,
        data,
        scope: "personal",
        addedById: human.id,
        visibleTo: [human.id],
      },
    });
    return row.id;
  };

  const idPhoneless = await mkItem("eval-unify-phoneless", {
    "שם פרטי": "EvalPhoneless",
    תיאור: "בלי טלפון",
  });
  const idNew = await mkItem("eval-unify-new", {
    "שם פרטי": "EvalNew",
    טלפון: "0507777001",
    תיאור: "חדש",
  });
  const idMerge = await mkItem("eval-unify-merge", {
    "שם פרטי": "EvalMerge",
    טלפון: "0507777002",
    "טלפון נוסף": "0507777003",
  });

  let existing = await prisma.contact.findFirst({
    where: {
      ownerEmployeeId: human.id,
      phone: "972507777002",
    },
  });
  if (!existing) {
    existing = await prisma.contact.create({
      data: {
        userId: human.userId,
        ownerEmployeeId: human.id,
        name: "EvalMerge",
        phone: "972507777002",
        kind: "personal",
        scope: "personal",
        visibleTo: [human.id],
        addedById: human.id,
      },
    });
  }

  return {
    ownerEmployeeId: human.id,
    userId: human.userId,
    listItemIds: [idPhoneless, idNew, idMerge],
    existingContactId: existing.id,
  };
}

async function verifyPreservation(beforeListCount: number, beforeListPhones: string[]) {
  const afterListCount = await countListContacts();
  const inv = await loadContactsUnifyInventory();
  const missingPhones = beforeListPhones.filter(
    (p) => !inv.contactPhones.includes(p) && !inv.listPhones.includes(p),
  );
  // Source rows must remain; phones from list inventory must still exist on Contacts or source.
  const sourceOk = afterListCount === beforeListCount;
  const phonesOnCanonical = beforeListPhones.filter((p) =>
    inv.contactPhones.includes(p),
  );
  return {
    sourceOk,
    afterListCount,
    beforeListCount,
    beforeListPhoneCount: beforeListPhones.length,
    canonicalPhoneCount: inv.contactPhones.length,
    listPhonesStillPresent: inv.listPhones.length,
    phonesMigratedToCanonical: phonesOnCanonical.length,
    missingPhones,
    schema: inv.schema,
    contactCount: inv.contactCount,
  };
}

async function main() {
  const mode = (process.argv[2] ?? "dry-run").trim().toLowerCase();
  if (!["dry-run", "apply", "verify", "seed-fixture"].includes(mode)) {
    throw new Error(
      `Usage: contacts-unify-eval.ts dry-run|apply|verify|seed-fixture (got ${mode})`,
    );
  }

  const loaded = loadLiveFullEvalEnv({ apply: true });
  console.log(summarizeLiveFullEvalEnv(loaded));
  console.log("DATABASE_URL=", redactUrl(process.env.DATABASE_URL!));
  const id = assertEvalIdentity();
  console.log("IDENTITY_OK", id);

  let inventory = await loadContactsUnifyInventory();

  if (mode === "seed-fixture") {
    if (!inventory.schema.phoneNullable || !inventory.schema.hasMigratedFromItemId) {
      console.error("STOP: run migrate-eval-db.ts first");
      process.exitCode = 2;
      return;
    }
    const seed = await seedEvalContactFixture();
    console.log(JSON.stringify({ seed }, null, 2));
    inventory = await loadContactsUnifyInventory();
  }

  const dry = planContactsUnify({
    listRows: inventory.listRows,
    contacts: inventory.contacts,
  });
  const safety = dryRunLooksSafe(dry);

  console.log(
    JSON.stringify(
      {
        mode,
        inventory: {
          listContactCount: inventory.listContactCount,
          contactCount: inventory.contactCount,
          listPhoneCount: inventory.listPhones.length,
          contactPhoneCount: inventory.contactPhones.length,
          schema: inventory.schema,
        },
        dryRun: {
          creates: dry.creates,
          merges: dry.merges,
          alreadyMigrated: dry.alreadyMigrated,
          phoneless: dry.phoneless,
          phonesPreserved: dry.phonesPreserved,
          planCount: dry.plans.length,
          sample: dry.plans.slice(0, 8).map((p) => {
            if (p.kind === "create") {
              return {
                kind: p.kind,
                name: p.name,
                phone: p.phone,
                itemId: p.migratedFromItemId,
                hasDescription: Boolean(
                  typeof p.extras.description === "string" && p.extras.description,
                ),
              };
            }
            if (p.kind === "merge") {
              return {
                kind: p.kind,
                contactId: p.contactId,
                phone: p.phone,
                phonesPreserved: p.phonesPreserved.length,
                itemId: p.migratedFromItemId,
              };
            }
            return { kind: p.kind, itemId: p.itemId, contactId: p.contactId };
          }),
        },
        safety,
      },
      null,
      2,
    ),
  );

  if (mode === "dry-run") {
    if (!safety.safe) {
      console.error("STOP: dry-run flagged unsafe:", safety.reasons);
      process.exitCode = 2;
    }
    return;
  }

  if (!safety.safe) {
    console.error("STOP: refusing apply — dry-run unsafe:", safety.reasons);
    process.exitCode = 2;
    return;
  }

  if (mode === "apply") {
    if (!inventory.schema.phoneNullable || !inventory.schema.hasMigratedFromItemId) {
      console.error(
        "STOP: schema not migrated yet (need nullable phone + migrated_from_item_id). Run prisma migrate deploy against eval URL first.",
      );
      process.exitCode = 2;
      return;
    }
    const beforeListCount = inventory.listContactCount;
    const beforeListPhones = [...inventory.listPhones];
    const result = await applyContactsUnifyPlan(prisma, dry.plans);
    const preservation = await verifyPreservation(beforeListCount, beforeListPhones);
    // Idempotency: second dry-run should only skip
    const again = planContactsUnify({
      listRows: (await loadContactsUnifyInventory()).listRows,
      contacts: (await loadContactsUnifyInventory()).contacts,
    });
    console.log(
      JSON.stringify(
        {
          apply: result,
          preservation,
          idempotencyDryRun: {
            creates: again.creates,
            merges: again.merges,
            alreadyMigrated: again.alreadyMigrated,
          },
        },
        null,
        2,
      ),
    );
    if (!preservation.sourceOk || preservation.missingPhones.length > 0) {
      console.error("VERIFY_FAIL: source or phones not preserved");
      process.exitCode = 3;
    }
    if (again.creates > 0 || again.merges > 0) {
      console.error("IDEMPOTENCY_WARN: second dry-run still has creates/merges");
      process.exitCode = process.exitCode || 4;
    }
    return;
  }

  // verify
  const preservation = await verifyPreservation(
    inventory.listContactCount,
    inventory.listPhones,
  );
  console.log(JSON.stringify({ verify: preservation, dryRunAfter: {
    creates: dry.creates,
    merges: dry.merges,
    alreadyMigrated: dry.alreadyMigrated,
  } }, null, 2));
  if (!preservation.sourceOk) {
    process.exitCode = 3;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
