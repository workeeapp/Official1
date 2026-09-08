import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { prisma } from "./database/prisma.js";

async function main(): Promise<void> {
  const env = getEnv();
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start API");
  console.error(error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
