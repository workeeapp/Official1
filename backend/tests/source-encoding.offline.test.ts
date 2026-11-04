/**
 * Guard: source files must stay valid UTF-8 with their Hebrew intact.
 * Regression: from 2026-10-25 every save of chat.service.ts (edited from the
 * UI) turned Hebrew into «?» — 212 prompt/engine lines went to the model and
 * to users as question marks, and no test noticed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const ROOTS = ["backend/src", "backend/tests", "backend/scripts", "shared/src", "frontend/src", "prisma"];
const FILES = ["LLM.config.json", "LLM.action.json", "docs/qa/live-full-corpus.json"];
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".prisma", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".tmp")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (EXT.has(extname(name))) out.push(full);
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) walk(join(repo, root), out);
  for (const file of FILES) out.push(join(repo, file));
  return out;
}

const Q = "\\?";
/** A corrupted Hebrew phrase: runs of «?» separated by spaces («?? ????»). */
const CORRUPT_PHRASE = new RegExp(`${Q}{2,} ${Q}{2,}`);
/** Four or more «?» in a row — never valid TS/JSON. */
const CORRUPT_WORD = new RegExp(`${Q}{4,}`);
const SELF = relative(repo, import.meta.filename ?? "");

describe("source encoding", () => {
  const files = sourceFiles();

  it("finds the files it guards", () => {
    expect(files.some((f) => f.endsWith("chat.service.ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });

  it("every file is valid UTF-8 (no replacement characters)", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const bad: string[] = [];
    for (const file of files) {
      try {
        const text = decoder.decode(readFileSync(file));
        if (text.includes(String.fromCharCode(0xfffd))) bad.push(relative(repo, file));
      } catch {
        bad.push(relative(repo, file));
      }
    }
    expect(bad).toEqual([]);
  });

  it("no Hebrew turned into question marks", () => {
    const bad: string[] = [];
    for (const file of files) {
      const rel = relative(repo, file);
      if (rel === SELF || rel.endsWith("source-encoding.offline.test.ts")) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (CORRUPT_PHRASE.test(line) || CORRUPT_WORD.test(line)) {
          bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(bad, bad.slice(0, 20).join("\n")).toEqual([]);
  });

  it("chat.service.ts keeps its core Hebrew (smoke)", () => {
    const chat = readFileSync(join(repo, "backend/src/services/chat.service.ts"), "utf8");
    expect(chat).toContain('name === "לוסי"');
    expect(chat).toMatch(/WHO HEARS WHAT: response is only for the person in front of you/);
    expect(chat).toContain("לא מצאתי את הפריט");
  });
});
