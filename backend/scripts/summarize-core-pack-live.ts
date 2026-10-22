#!/usr/bin/env npx tsx
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function briefMeta(metadata: Record<string, unknown> | undefined) {
  const lists = (metadata?.lists as Array<Record<string, unknown>> | undefined) ?? [];
  const reminders =
    (metadata?.reminders as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    lists: lists.map((x) => ({
      action: x.action,
      listType: x.listType ?? x.list_type,
      itemHints: ((x.items as unknown[]) ?? []).slice(0, 2).map((it) =>
        JSON.stringify(it).slice(0, 120),
      ),
    })),
    reminders: reminders.map((x) => ({ action: x.action })),
    messages: Array.isArray(metadata?.messages)
      ? (metadata!.messages as unknown[]).length
      : 0,
    showDump: metadata?.showDump ?? metadata?.show_dump ?? null,
    listOps: Array.isArray(metadata?.listOps)
      ? (metadata!.listOps as unknown[]).length
      : Array.isArray(metadata?.list_ops)
        ? (metadata!.list_ops as unknown[]).length
        : 0,
  };
}

function summarize(path: string, track: string) {
  const j = JSON.parse(readFileSync(path, "utf8")) as {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    softOk: boolean;
    criticalOk: boolean;
    criticalFailed: string[];
    ok: boolean;
    results: Array<{
      id: string;
      ok: boolean;
      failures: string[];
      response?: string;
      metadata?: Record<string, unknown>;
      turns?: Array<{
        index: number;
        utterance: string;
        response: string;
        ok: boolean;
        failures: string[];
        metadata?: Record<string, unknown>;
      }>;
    }>;
  };
  const failed = j.results.filter((r) => !r.ok);
  const passed = j.results.filter((r) => r.ok);
  return {
    track,
    total: j.total,
    passed: j.passed,
    failed: j.failed,
    passRate: j.passRate,
    softOk: j.softOk,
    criticalOk: j.criticalOk,
    criticalFailed: j.criticalFailed,
    ok: j.ok,
    passedIds: passed.map((r) => r.id),
    failedCases: failed.map((r) => ({
      id: r.id,
      failures: r.failures,
      responsePreview: String(r.response ?? r.turns?.at(-1)?.response ?? "").slice(
        0,
        220,
      ),
      meta: briefMeta(r.metadata ?? r.turns?.find((t) => !t.ok)?.metadata),
      turnDetails: r.turns
        ?.filter((t) => !t.ok)
        .map((t) => ({
          index: t.index,
          utterance: t.utterance,
          failures: t.failures,
          responsePreview: t.response.slice(0, 180),
          meta: briefMeta(t.metadata),
        })),
    })),
  };
}

const st = summarize(
  resolve(root, "docs/qa/phase-4-last-eval.json"),
  "LIVE_MODEL",
);
const mt = summarize(
  resolve(root, "docs/qa/phase-4-multi-turn-last-eval.json"),
  "LIVE_MODEL_MT",
);
const out = { st, mt };
writeFileSync(
  resolve(root, "docs/qa/core-pack-live-fail-summary.json"),
  `${JSON.stringify(out, null, 2)}\n`,
);
process.stderr.write(
  `${JSON.stringify(
    {
      st: {
        total: st.total,
        passed: st.passed,
        failed: st.failed,
        failedIds: st.failedCases.map((c) => c.id),
      },
      mt: {
        total: mt.total,
        passed: mt.passed,
        failed: mt.failed,
        failedIds: mt.failedCases.map((c) => c.id),
      },
    },
    null,
    2,
  )}\n`,
);
