#!/usr/bin/env node
/**
 * Compatibility shim — prefer: npm run add:live-case -w backend -- …
 * Forwards to add-live-case.ts (intent compiler).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "add-live-case.ts");
const tsxBin = resolve(here, "../node_modules/tsx/dist/cli.mjs");
const r = spawnSync(process.execPath, [tsxBin, script, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: resolve(here, ".."),
});
process.exit(r.status ?? 1);
