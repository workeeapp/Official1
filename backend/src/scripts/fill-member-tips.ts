/**
 * One-shot: upsert member+Lucy tip catalog for every account; disable guest tips.
 * Run: npx tsx backend/src/scripts/fill-member-tips.ts
 */
import { prisma } from "../database/prisma.js";

const LUCY_NAME = "לוסי";

const CATALOG: Array<{
  key: string;
  audience: "member";
  triggerKind: "action" | "general";
  triggerArea: string | null;
  triggerOp: string | null;
  maxShows: number;
  order: number;
  text: string;
}> = [
  {
    key: "reminders_intro",
    audience: "member",
    triggerKind: "action",
    triggerArea: "reminders",
    triggerOp: "add",
    maxShows: 1,
    order: 100,
    text: "אגב, התזכורות נשמרות אצלי — בכל רגע אפשר לבקש ממני להציג אותן.",
  },
  {
    key: "filing_media",
    audience: "member",
    triggerKind: "action",
    triggerArea: "filing",
    triggerOp: "add",
    maxShows: 1,
    order: 110,
    text: "אגב, אפשר גם לתייק תמונה, וידאו או קובץ — פשוט שלחו ואשאל לאן לשמור.",
  },
  {
    key: "lists_intro",
    audience: "member",
    triggerKind: "action",
    triggerArea: "lists",
    triggerOp: "add",
    maxShows: 1,
    order: 120,
    text: "אגב, אפשר תמיד לבקש להציג קניות, מטלות או רשימה בשם — למשל «הציגי את רשימת הקניות».",
  },
  {
    key: "directory_intro",
    audience: "member",
    triggerKind: "action",
    triggerArea: "directory",
    triggerOp: "add",
    maxShows: 1,
    order: 130,
    text: "אגב, אנשי הקשר בספר הטלפונים — אפשר לבקש ממני להציג או לשלוח הודעה לפי שם.",
  },
  {
    key: "general_lists",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 10,
    text: "אגב, אפשר לבקש ממני להציג קניות, מטלות או תיוקים בכל רגע.",
  },
  {
    key: "general_reminders",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 20,
    text: "אגב, אפשר לקבוע תזכורת לשעה מדויקת או בעוד כמה דקות — למשל «תזכירי לי מחר ב־9».",
  },
  {
    key: "general_shared",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 30,
    text: "אגב, אפשר גם רשימה משותפת עם מישהו מהצוות — פשוט תגידו עם מי.",
  },
  {
    key: "general_filing",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 40,
    text: "אגב, אם חשוב לזכור משהו עליכם לאורך זמן — אפשר לתייק אצלי.",
  },
  {
    key: "general_message",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 50,
    text: "אגב, אפשר לבקש ממני להעביר הודעה למישהו בצוות או בוואטסאפ.",
  },
  {
    key: "general_handoff",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 60,
    text: "אגב, אם תרצו לדבר עם עובד דיגיטלי אחר — אפשר לעבור אליו מכאן.",
  },
  {
    key: "general_full_dump",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 70,
    text: "אגב, אפשר לשאול «מה יש לי» ואציג סיכום של מה ששמור.",
  },
  {
    key: "general_attachments",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 80,
    text: "אגב, אפשר לצרף תמונה או קובץ לרשימה, לתיוק או לתזכורת.",
  },
  {
    key: "general_recurring",
    audience: "member",
    triggerKind: "general",
    triggerArea: null,
    triggerOp: null,
    maxShows: 3,
    order: 90,
    text: "אגב, אפשר גם תזכורת שחוזרת — כל יום, כל שבוע, וכו׳.",
  },
];

async function resolveLucyId(userId: string): Promise<string | null> {
  const protectedLucy = await prisma.employee.findFirst({
    where: { userId, kind: "digital", isProtected: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (protectedLucy) {
    return protectedLucy.id;
  }
  const named = await prisma.employee.findFirst({
    where: {
      userId,
      kind: "digital",
      OR: [{ name: LUCY_NAME }, { nickname: LUCY_NAME }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return named?.id ?? null;
}

async function main(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, username: true } });
  let upserted = 0;
  let skippedUsers = 0;
  let disabledGuest = 0;

  for (const user of users) {
    const lucyId = await resolveLucyId(user.id);
    if (!lucyId) {
      console.warn(`skip ${user.username}: no Lucy`);
      skippedUsers += 1;
      continue;
    }

    for (const tip of CATALOG) {
      await prisma.tip.upsert({
        where: { userId_key: { userId: user.id, key: tip.key } },
        create: {
          userId: user.id,
          key: tip.key,
          audience: tip.audience,
          digitalEmployeeId: lucyId,
          triggerKind: tip.triggerKind,
          triggerArea: tip.triggerArea,
          triggerOp: tip.triggerOp,
          maxShows: tip.maxShows,
          order: tip.order,
          text: tip.text,
          enabled: true,
        },
        update: {
          audience: tip.audience,
          digitalEmployeeId: lucyId,
          triggerKind: tip.triggerKind,
          triggerArea: tip.triggerArea,
          triggerOp: tip.triggerOp,
          maxShows: tip.maxShows,
          order: tip.order,
          text: tip.text,
          enabled: true,
        },
      });
      upserted += 1;
    }

    const guestDisabled = await prisma.tip.updateMany({
      where: {
        userId: user.id,
        OR: [{ key: "guest_terms" }, { audience: "guest" }],
      },
      data: { enabled: false },
    });
    disabledGuest += guestDisabled.count;

    console.log(`${user.username}: ${CATALOG.length} tips upserted`);
  }

  console.log(
    `done: users=${users.length} upserts=${upserted} skipped=${skippedUsers} guest_disabled=${disabledGuest}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
