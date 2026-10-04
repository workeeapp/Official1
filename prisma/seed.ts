import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { validateLoginInput, hasFieldErrors } from "@workee/shared";
import { hashPassword } from "../backend/src/auth/password.js";
import { loadLlmConfig } from "../backend/src/config/llm.js";

const prisma = new PrismaClient();

function splitNames(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(/[,;\s]+/)
        .map((row) => row.trim())
        .filter(Boolean),
    ),
  ];
}

async function seedEmployeesForUser(userId: string): Promise<void> {
  const employeeSeeds = [
    {
      name: "עמית",
      surname: "חתן",
      nickname: "עמית",
      email: "amit@example.com",
      phone: "050-0000001",
    },
    {
      name: "טל",
      surname: "דור",
      nickname: "טל",
      email: "tal@example.com",
      phone: "050-0000002",
    },
  ];

  for (const employee of employeeSeeds) {
    const alreadyPresent = await prisma.employee.findFirst({
      where: {
        userId,
        name: employee.name,
        surname: employee.surname,
        nickname: employee.nickname,
      },
    });

    if (alreadyPresent) {
      console.log(
        `Employee "${employee.name} ${employee.surname}" already exists for ${userId.slice(0, 8)}.`,
      );
      continue;
    }

    const created = await prisma.employee.create({
      data: {
        userId,
        ...employee,
      },
    });
    console.log(
      `Seeded employee "${created.name} ${created.surname}" (${created.id})`,
    );
  }

  const lucy = await prisma.employee.findFirst({
    where: { userId, isProtected: true },
  });
  if (lucy) {
    console.log(`Protected employee "${lucy.name}" already exists.`);
  } else {
    const config = loadLlmConfig();
    const createdLucy = await prisma.employee.create({
      data: {
        userId,
        kind: "digital",
        isProtected: true,
        name: "לוסי",
        surname: "",
        nickname: "לוסי",
        model: config.model,
        temperature: config.temperature,
        instructions: config.systemMessage,
      },
    });
    console.log(
      `Seeded protected employee "${createdLucy.name}" (${createdLucy.id})`,
    );
  }
}

async function main(): Promise<void> {
  const password = process.env.SEED_PASSWORD ?? "ChangeMe123!";
  const usernames = splitNames(process.env.SEED_USERNAME);
  if (usernames.length === 0) {
    usernames.push("Amit");
  }

  const adminUsernames = splitNames(process.env.SEED_ADMIN_USERNAMES);

  for (const username of usernames) {
    const errors = validateLoginInput({ username, password });
    if (hasFieldErrors(errors)) {
      throw new Error(
        `SEED_USERNAME entry "${username}" or SEED_PASSWORD is invalid`,
      );
    }

    const existing = await prisma.user.findUnique({
      where: { username },
    });
    const seedIsAdmin = adminUsernames.some(
      (name) => name.toLowerCase() === username.toLowerCase(),
    );

    const user =
      existing ??
      (await prisma.user.create({
        data: {
          username,
          passwordHash: await hashPassword(password),
          isAdmin: seedIsAdmin,
        },
      }));

    if (existing) {
      console.log(`User "${username}" already exists.`);
    } else {
      console.log(`Seeded user "${user.username}" (${user.id})`);
    }

    await seedEmployeesForUser(user.id);
  }

  for (const adminName of adminUsernames) {
    const updated = await prisma.user.updateMany({
      where: { username: adminName },
      data: { isAdmin: true },
    });
    if (updated.count > 0) {
      console.log(`Granted isAdmin to "${adminName}".`);
    } else {
      console.log(`SEED_ADMIN_USERNAMES: no user named "${adminName}" yet.`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
