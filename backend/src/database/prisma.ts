import { PrismaClient } from "@prisma/client";

const perfCount = process.env.WORKEE_PIE_PERF_COUNT === "1";

export const prisma = new PrismaClient({
  log: perfCount
    ? [{ emit: "event", level: "query" }, "error"]
    : process.env.NODE_ENV === "development"
      ? ["error", "warn"]
      : ["error"],
});

/** Per-turn Prisma query counter — only active when WORKEE_PIE_PERF_COUNT=1. */
let piePerfQueryCount = 0;

export function resetPrismaQueryCountForPerf(): void {
  piePerfQueryCount = 0;
}

export function getPrismaQueryCountForPerf(): number {
  return piePerfQueryCount;
}

if (perfCount) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any).$on("query", () => {
    piePerfQueryCount += 1;
  });
}
