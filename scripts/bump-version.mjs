#!/usr/bin/env node
/**
 * Bump VERSION (and frontend/src/version.ts) by +0.01 on the minor segment.
 * 1.02 → 1.03 → … → 1.99 → 1.100
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = path.join(root, "VERSION");
const tsPath = path.join(root, "frontend/src/version.ts");

const current = fs.readFileSync(versionPath, "utf8").trim();
const match = /^(\d+)\.(\d+)$/.exec(current);
if (!match) {
  console.error(`Invalid VERSION "${current}" (expected e.g. 1.02)`);
  process.exit(1);
}

const major = Number(match[1]);
const minor = Number(match[2]) + 1;
const next = `${major}.${String(minor).padStart(2, "0")}`;

fs.writeFileSync(versionPath, `${next}\n`, "utf8");
fs.writeFileSync(
  tsPath,
  `/** App display version — bumped on every git push. */\nexport const APP_VERSION = "${next}";\n`,
  "utf8",
);

process.stdout.write(`${next}\n`);
