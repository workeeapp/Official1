/**
 * UWM retrieval/cost instrumentation (Phase 2).
 * Separates API vs web_search vs cache vs token purposes — measurement first.
 */
import { recordWhatsAppEvent } from "./whatsapp-log.js";

export type UwmMetricKind =
  | "select"
  | "api_call"
  | "web_search"
  | "cache"
  | "source_memory"
  | "tokens"
  | "action"
  | "notify";

export type UwmMetricEvent = {
  at: string;
  kind: UwmMetricKind;
  fields: Record<string, string | number | boolean | null>;
};

const MAX = 200;
const events: UwmMetricEvent[] = [];

export function resetUwmMetrics(): void {
  events.length = 0;
}

export function listUwmMetrics(): UwmMetricEvent[] {
  return [...events];
}

export function recordUwmMetric(
  kind: UwmMetricKind,
  fields: Record<string, string | number | boolean | null> = {},
): UwmMetricEvent {
  const event: UwmMetricEvent = {
    at: new Date().toISOString(),
    kind,
    fields,
  };
  events.unshift(event);
  if (events.length > MAX) {
    events.length = MAX;
  }
  const detail = Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? "" : String(v)}`)
    .join(" ")
    .slice(0, 360);
  recordWhatsAppEvent(`uwm_${kind}`, detail);
  return event;
}

/** Count helpers for tests / dashboards. */
export function countUwmMetrics(
  kind: UwmMetricKind,
  pred?: (e: UwmMetricEvent) => boolean,
): number {
  return events.filter((e) => e.kind === kind && (!pred || pred(e))).length;
}
