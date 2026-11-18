/**
 * UWM shared types for monitor items / state (Phase 3–4).
 */
import type { UwmSourcePlan } from "./uwm-source-selector.js";

export type UwmEvidenceGrade =
  | "unverified"
  | "observed"
  | "corroborated"
  | "disputed";

export type UwmFactProvenance = {
  sourceId: string;
  kind: "api" | "web" | "web_page" | "hybrid";
  url?: string;
  fetchedAt: string;
  publishedAt?: string | null;
  verifiedAt: string;
  evidenceRole: "primary" | "corroboration";
  officialHint?: boolean;
  cacheHit?: boolean;
};

export type NormalizedMonitorItem = {
  itemId: string;
  /** Title+venue core used for alias merge (no eventAt). */
  identityCore?: string;
  title: string;
  summary?: string;
  url?: string;
  sourceUrls: string[];
  eventAt?: string | null;
  locationText?: string | null;
  attributes: Record<string, string | number | boolean | null>;
  contentFp: string;
  /** Per changeAspect fingerprint (Phase 4). */
  aspectFps?: Record<string, string>;
  confidence: number;
  retrievedAt: string;
  publishedAt?: string | null;
  verified: boolean;
  evidenceGrade: UwmEvidenceGrade;
  provenance: UwmFactProvenance[];
  /** Soft-404 / empty / blocked page. */
  retrievalOk?: boolean;
};

export type UwmChangeHistoryEntry = {
  at: string;
  aspect: string;
  fromFp?: string;
  toFp: string;
  fromEventAt?: string | null;
  toEventAt?: string | null;
};

export type UwmMonitorItemState = {
  firstSeenAt: string;
  lastSeenAt: string;
  contentFp: string;
  identityCore?: string;
  eventAt?: string | null;
  status?: "active" | "cancelled" | "expired";
  evidenceGrade?: UwmEvidenceGrade;
  provenance?: UwmFactProvenance[];
  boundUrls?: string[];
  /** phase → ISO when notified / missed */
  notified: Record<string, string>;
  boundFailCount?: number;
  aspectFps?: Record<string, string>;
  changeHistory?: UwmChangeHistoryEntry[];
  /** Alternate itemIds merged into this one. */
  aliases?: string[];
};

/** Armed precise pre-event notification on this Reminder (one at a time). */
export type UwmNextPrecise = {
  itemId: string;
  objectiveId: string;
  minutesBefore: number;
  fireAtIso: string;
  eventAtIso: string;
};

export type UwmMonitorState = {
  version: 1;
  lastPollAt?: string;
  lastSnapshotKey?: string;
  lastErrorClass?:
    | "quota"
    | "empty"
    | "stale"
    | "normalize"
    | "match"
    | "api_fail"
    | "page_fail"
    | null;
  sourcePlan?: UwmSourcePlan;
  items: Record<string, UwmMonitorItemState>;
  /** URLs discovered for bound monitoring (deduped). */
  boundSources?: Array<{ url: string; sourceId: string; failCount: number }>;
  /** Dual-schedule precise arm (Phase 4). */
  nextPrecise?: UwmNextPrecise | null;
};

export type UwmPollNotify = {
  shouldNotify: boolean;
  fingerprint: string;
  bodyHe?: string;
  item?: NormalizedMonitorItem;
  phase?: string;
  reason?:
    | "no_match"
    | "already_notified"
    | "low_confidence"
    | "unverified"
    | "disputed"
    | "stale"
    | "quota"
    | "empty"
    | "page_fail"
    | "missed"
    | "cancelled"
    | "precise";
};
