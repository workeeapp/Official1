import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { validateLoginInput, hasFieldErrors } from "@workee/shared";
import { hashPassword } from "../backend/src/auth/password.js";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const username = process.env.SEED_USERNAME ?? "Amit";
  const password = process.env.SEED_PASSWORD ?? "ChangeMe123!";
  const errors = validateLoginInput({ username, password });

  if (hasFieldErrors(errors)) {
    throw new Error("SEED_USERNAME or SEED_PASSWORD is invalid");
  }

  const existing = await prisma.user.findUnique({
    where: { username },
  });

  const user =
    existing ??
    (await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
      },
    }));

  if (existing) {
    console.log(`User "${username}" already exists.`);
  } else {
    console.log(`Seeded user "${user.username}" (${user.id})`);
  }

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
        userId: user.id,
        name: employee.name,
        surname: employee.surname,
        nickname: employee.nickname,
      },
    });

    if (alreadyPresent) {
      console.log(`Employee "${employee.name} ${employee.surname}" already exists.`);
      continue;
    }

    const created = await prisma.employee.create({
      data: {
        userId: user.id,
        ...employee,
      },
    });
    console.log(`Seeded employee "${created.name} ${created.surname}" (${created.id})`);
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
