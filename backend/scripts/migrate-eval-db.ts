/**
 * prisma migrate deploy against isolated eval DB only.
 * Loads .env.live-full-eval; refuses product workee / wrong host-port.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLiveFullEvalEnv,
  summarizeLiveFullEvalEnv,
} from "../src/eval/load-live-full-eval-env.js";
import {
  assertApprovedEvalDatabaseUrl,
  evalDatabaseNameFromUrl,
  LIVE_FULL_REQUIRED_DATABASE_NAME,
} from "../src/eval/studio-db-guard.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);

const loaded = loadLiveFullEvalEnv({ apply: true, cwd: root });
console.log(summarizeLiveFullEvalEnv(loaded));
assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
const u = new URL(process.env.DATABASE_URL!);
const db = evalDatabaseNameFromUrl(process.env.DATABASE_URL!);
if (db !== LIVE_FULL_REQUIRED_DATABASE_NAME) {
  throw new Error(`Refusing: db=${db}`);
}
if (u.port !== "5436" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) {
  throw new Error(`Refusing: ${u.hostname}:${u.port}`);
}
console.log(`migrate deploy → ${u.hostname}:${u.port}/${db}`);

const r = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
  { cwd: root, env: process.env, encoding: "utf8" },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
