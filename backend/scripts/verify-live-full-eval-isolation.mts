/**
 * One-shot isolation check for the dedicated eval Postgres instance.
 * Does not run LIVE_FULL. Uses process DATABASE_URL / APPROVED / kill switches.
 */
import {
  assertLiveFullCliAllowed,
  probeLiveFullCliSafety,
} from "../src/eval/studio-safety.js";
import { assertLiveFullDbRoleIsolation } from "../src/eval/studio-db-role-isolation.js";
import {
  assertApprovedEvalDatabaseUrl,
  assertLiveFullDatabaseName,
  evalDatabaseNameFromUrl,
} from "../src/eval/studio-db-guard.js";

const report = probeLiveFullCliSafety();
console.log(
  JSON.stringify({
    cliAllowed: report.allowed,
    checks: report.checks.map((c) => ({ id: c.id, ok: c.ok })),
    dbName: evalDatabaseNameFromUrl(process.env.DATABASE_URL ?? ""),
  }),
);
if (!report.allowed) {
  console.error(report.blockers.join("; "));
  process.exit(1);
}
assertLiveFullCliAllowed();
assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
assertLiveFullDatabaseName(process.env.DATABASE_URL);
await assertLiveFullDbRoleIsolation();
console.log("isolation_ok");
