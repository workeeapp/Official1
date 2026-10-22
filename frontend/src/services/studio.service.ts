import { api } from "./http";

export type StudioTrack = "LIVE_MODEL" | "LIVE_MODEL_MT" | "LIVE_FULL";

export type StudioSafetyCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type StudioSafetyReport = {
  track: StudioTrack;
  allowed: boolean;
  checks: StudioSafetyCheck[];
  blockers: string[];
  notes: string[];
};

export type StudioTrackCapabilities = {
  track: StudioTrack;
  label: string;
  captures: string[];
  doesNotProve: string[];
  executable: boolean;
  safety?: StudioSafetyReport;
};

export type StudioRunSummary = {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: string;
  track: StudioTrack;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    ok: boolean;
  };
  blockers?: string[];
  productionApply?: boolean;
  promptSource?: string;
  promptHash?: string;
};

export const studioApi = {
  tracks() {
    return api<{ tracks: StudioTrackCapabilities[] }>("/api/studio/tracks");
  },
  safety() {
    return api<{
      liveFull: StudioSafetyReport;
      liveModel: StudioSafetyReport;
      writeTracksExposed: boolean;
      writeTracksNote: string;
      isolationPolicy: string;
    }>("/api/studio/safety");
  },
  cases(track: StudioTrack) {
    return api<{
      track: StudioTrack;
      cases: Array<{
        id: string;
        tag?: string;
        tags?: string[];
        description?: string;
        utterancePreview: string;
        turnCount: number;
      }>;
      count: number;
    }>(`/api/studio/cases?track=${encodeURIComponent(track)}`);
  },
  runs() {
    return api<{ runs: StudioRunSummary[]; count: number }>("/api/studio/runs");
  },
  run(id: string) {
    return api<{ run: Record<string, unknown> }>(
      `/api/studio/runs/${encodeURIComponent(id)}`,
    );
  },
  drafts() {
    return api<{ drafts: Array<{ id: string; path: string }> }>(
      "/api/studio/drafts",
    );
  },
  draft(id: string) {
    return api<{ id: string; draft: unknown }>(
      `/api/studio/drafts/${encodeURIComponent(id)}`,
    );
  },
};
