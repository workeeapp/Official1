export type JobUrgency = "normal" | "urgent" | "very_urgent";

export const JOB_URGENCIES: readonly JobUrgency[] = ["normal", "urgent", "very_urgent"];

export interface JobUrgencyPolicy {
  /** Follow-up clocks the server fires on its own after the first message. */
  autoNudges: number;
  /** Seconds between the first message and each follow-up. */
  intervalSeconds: number;
  /** Prefix on the follow-up text the subject receives. */
  label: string;
}

export const JOB_URGENCY_POLICY: Record<JobUrgency, JobUrgencyPolicy> = {
  normal: { autoNudges: 0, intervalSeconds: 0, label: "" },
  urgent: { autoNudges: 2, intervalSeconds:  60 * 60, label: "דחוף" },
  very_urgent: { autoNudges: 6, intervalSeconds: 20 * 60, label: "דחוף מאוד" },
};

export function parseJobUrgency(value: unknown): JobUrgency {
  if (typeof value !== "string") {
    return "normal";
  }
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (JOB_URGENCIES as readonly string[]).includes(key)
    ? (key as JobUrgency)
    : "normal";
}
