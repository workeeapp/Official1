import { validateLoginInput, hasFieldErrors } from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { createUser } from "../services/user.service.js";
import { AppError } from "../utils/errors.js";

function readArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const username = readArg("username") ?? process.env.SEED_USERNAME;
  const password = readArg("password") ?? process.env.SEED_PASSWORD;

  const errors = validateLoginInput({ username, password });
  if (hasFieldErrors(errors) || !username || !password) {
    throw new Error(
      "Usage: npm run user:create -- --username <name> --password <password>",
    );
  }

  const user = await createUser(username.trim(), password);
  console.log(`Created user ${user.username} (${user.id})`);
}

main()
  .catch((error) => {
    const message =
      error instanceof AppError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Failed to create user";
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
