/**
 * One-shot: EmployeeListItems.data «שם מטלה» → «שם משימה».
 * Usage (from repo with DATABASE_URL): node backend/scripts/_migrate-task-title-key.mjs
 */
import { PrismaClient } from "@prisma/client";

const LEGACY = "שם מטלה";
const CANON = "שם משימה";
const prisma = new PrismaClient();

const rows = await prisma.employeeListItem.findMany({
  where: { deletedAt: null },
  select: { id: true, data: true, list: { select: { listType: true } } },
});

let updated = 0;
for (const row of rows) {
  if (row.list?.listType !== "tasks") continue;
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? { ...(row.data) }
      : null;
  if (!data || !(LEGACY in data)) continue;
  const legacy = data[LEGACY];
  if (typeof legacy === "string" && legacy.trim()) {
    if (!(typeof data[CANON] === "string" && data[CANON].trim())) {
      data[CANON] = legacy.trim();
    }
  }
  delete data[LEGACY];
  await prisma.employeeListItem.update({
    where: { id: row.id },
    data: { data },
  });
  updated += 1;
}

console.log(`migrated ${updated} task rows`);
await prisma.$disconnect();
