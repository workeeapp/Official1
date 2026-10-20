import type { ChatAttachmentRef } from "./attachments.js";
import type { JobUrgency } from "./job-urgency.js";
import type { LlmReplyButton } from "./llm-message.js";

export interface PublicUser {
  id: string;
  username: string;
}

export interface AuthUserResponse {
  user: PublicUser;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}

export interface LoginRequest {
  username: string;
  password: string;
}

export type EmployeeKind = "human" | "digital";

/** OpenAI reasoning effort for gpt-6 models; temperature is sent only with "none". */
export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : null;
}

/** How Lucy addresses a human speaker in Hebrew second person. */
export type AddressGender = "male" | "female";

export interface PublicEmployee {
  id: string;
  kind?: EmployeeKind;
  name: string;
  surname: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  model?: string | null;
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  instructions?: string | null;
  protected?: boolean;
  isOwner?: boolean;
  /** Humans only: male | female | null/undefined when unknown. */
  addressGender?: AddressGender | null;
  /**
   * After guest registration: this human's host-account employee id that remains
   * on shared lists (visible_to). Null for guests and host-only humans.
   */
  shareMirrorEmployeeId?: string | null;
}

export interface EmployeesResponse {
  employees: PublicEmployee[];
  count: number;
}

export interface EmployeeRecordField {
  label: string;
  value: string;
}

/** Shopping/custom list linked from a tasks item (Employees UI). */
export interface EmployeeRecordLinkedList {
  listId: string;
  listType: string;
  listName: string;
}

export interface EmployeeRecordItem {
  id: string;
  kind: "list" | "filing" | "reminder";
  title: string;
  details: EmployeeRecordField[];
  fields: EmployeeRecordField[];
  createdBy: string;
  createdAt: string;
  /** Non-normal urgency only (urgent / very_urgent). */
  urgency?: JobUrgency;
  attachments?: ChatAttachmentRef[];
  linkedLists?: EmployeeRecordLinkedList[];
}

export interface EmployeeRecordMutationRequest {
  fields: EmployeeRecordField[];
}

export interface EmployeeRecordGroup {
  type: string;
  title: string;
  /** Present for list groups so linked-list anchors can scroll here. */
  listId?: string;
  items: EmployeeRecordItem[];
}

export interface EmployeeRecordsResponse {
  employeeId: string;
  groups: EmployeeRecordGroup[];
}

export interface EmployeeUsageMonth {
  /** `YYYY-MM` in Asia/Jerusalem time. */
  month: string;
  conversations: number;
  interactions: number;
  totalUsd: number;
}

export interface EmployeeUsageSummary {
  employeeId: string;
  conversations: number;
  interactions: number;
  totalUsd: number;
  /** Newest first. */
  months: EmployeeUsageMonth[];
}

export interface TeamUsageMonth {
  /** `YYYY-MM` in Asia/Jerusalem time. */
  month: string;
  allEmployeesUsd: number;
  humanEmployeesUsd: number;
}

/** Sums of the per-employee amounts shown on the Employees screen. */
export interface TeamUsageSummary {
  allEmployeesUsd: number;
  humanEmployeesUsd: number;
  /** Newest first; months with no cost are omitted. */
  months: TeamUsageMonth[];
}

export interface EmployeeInput {
  kind?: EmployeeKind;
  name: string;
  surname?: string;
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
  model?: string | null;
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  instructions?: string | null;
  isOwner?: boolean;
  /** Humans only; omit / null = unknown (Lucy asks once). */
  addressGender?: AddressGender | null;
}

export interface DigitalEmployeeDefaults {
  model: string;
  temperature: number;
  reasoningEffort: ReasoningEffort;
  instructions: string;
}

/** Who may receive a tip. */
export const TIP_AUDIENCES = ["guest", "member", "any"] as const;
export type TipAudience = (typeof TIP_AUDIENCES)[number];

/** How a tip is triggered. */
export const TIP_TRIGGER_KINDS = ["action", "model", "general"] as const;
export type TipTriggerKind = (typeof TIP_TRIGGER_KINDS)[number];

/** ACTION area for action-triggered tips. */
export const TIP_TRIGGER_AREAS = [
  "reminders",
  "filing",
  "lists",
  "directory",
] as const;
export type TipTriggerArea = (typeof TIP_TRIGGER_AREAS)[number];

export const TIP_TRIGGER_OPS = ["add", "remove", "update"] as const;
export type TipTriggerOp = (typeof TIP_TRIGGER_OPS)[number];

/** Pedagogy ladder for tips. */
export const TIP_TIERS = [
  "basic",
  "intermediate",
  "advanced",
  "personal",
] as const;
export type TipTier = (typeof TIP_TIERS)[number];

/** Product topics for tip ladders (copy + unlock), not raw ACTION names. */
export const TIP_TOPICS = [
  "shopping",
  "tasks",
  "meetings",
  "custom",
  "filing",
  "reminders",
  "directory",
  "guest",
] as const;
export type TipTopic = (typeof TIP_TOPICS)[number];

export interface PublicTip {
  id: string;
  key: string;
  audience: TipAudience;
  digitalEmployeeId: string | null;
  /** Display name of the target digital, when set. */
  digitalName: string | null;
  triggerKind: TipTriggerKind;
  triggerArea: TipTriggerArea | null;
  triggerOp: TipTriggerOp | null;
  tier: TipTier;
  topic: TipTopic | null;
  listType: string | null;
  unlockAfterKey: string | null;
  systemSeed: boolean;
  maxShows: number;
  order: number;
  text: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TipsResponse {
  tips: PublicTip[];
  count: number;
}

export interface TipInput {
  key: string;
  audience: TipAudience;
  digitalEmployeeId?: string | null;
  triggerKind: TipTriggerKind;
  triggerArea?: TipTriggerArea | null;
  triggerOp?: TipTriggerOp | null;
  tier?: TipTier;
  topic?: TipTopic | null;
  listType?: string | null;
  unlockAfterKey?: string | null;
  maxShows: number;
  order: number;
  text: string;
  enabled?: boolean;
}

export interface TipUpdateInput {
  audience?: TipAudience;
  digitalEmployeeId?: string | null;
  triggerKind?: TipTriggerKind;
  triggerArea?: TipTriggerArea | null;
  triggerOp?: TipTriggerOp | null;
  tier?: TipTier;
  topic?: TipTopic | null;
  listType?: string | null;
  unlockAfterKey?: string | null;
  maxShows?: number;
  order?: number;
  text?: string;
  enabled?: boolean;
}

export function isDigitalEmployee(
  employee: Pick<PublicEmployee, "kind">,
): boolean {
  return employee.kind === "digital";
}

export function humanEmployees<T extends Pick<PublicEmployee, "kind">>(
  employees: T[],
): T[] {
  return employees.filter((employee) => employee.kind !== "digital");
}

export function digitalEmployees<T extends Pick<PublicEmployee, "kind">>(
  employees: T[],
): T[] {
  return employees.filter((employee) => employee.kind === "digital");
}

/** WhatsApp inbound auto-created outsider — not a real team member. */
export function isGuestEmployee(
  employee: Pick<PublicEmployee, "kind" | "name" | "nickname">,
): boolean {
  if (employee.kind === "digital") {
    return false;
  }
  const name = (employee.name ?? "").trim();
  const nickname = employee.nickname?.trim() ?? "";
  return name === "אורח" || nickname === "אורח" || nickname.startsWith("אורח ");
}

/** Humans shown in Employees / Chat-as (excludes WhatsApp guest shells). */
export function workspaceHumans<
  T extends Pick<PublicEmployee, "kind" | "name" | "nickname">,
>(employees: T[]): T[] {
  return humanEmployees(employees).filter((employee) => !isGuestEmployee(employee));
}

/** Dedicated WhatsApp onboarding digital — converts guests into members. */
export const GUEST_LUCY_NAME = "לוסי-אורח";

export function isGuestLucy(
  employee: Pick<PublicEmployee, "kind" | "name" | "nickname">,
): boolean {
  if (employee.kind !== "digital") {
    return false;
  }
  const name = (employee.name ?? "").trim();
  const nickname = employee.nickname?.trim() ?? "";
  return name === GUEST_LUCY_NAME || nickname === GUEST_LUCY_NAME;
}

/** Digitals shown in Chat-with (excludes לוסי-אורח). */
export function workspaceDigitals<
  T extends Pick<PublicEmployee, "kind" | "name" | "nickname">,
>(employees: T[]): T[] {
  return digitalEmployees(employees).filter((employee) => !isGuestLucy(employee));
}

export function isProtectedEmployee(
  employee: Pick<PublicEmployee, "protected">,
): boolean {
  return employee.protected === true;
}

export function isAccountOwner(
  employee: Pick<PublicEmployee, "isOwner" | "kind">,
): boolean {
  return employee.kind !== "digital" && employee.isOwner === true;
}

export interface ChatMessageRequest {
  message: string;
  employeeId: string;
  digitalEmployeeId?: string;
}

export interface ChatReplyTiming {
  llmMs: number;
  afterLlmMs: number;
}

/** Saved `ChatMessages` ids of this turn, so the client merges its bubbles with history by id. */
export interface ChatTurnMessageIds {
  user: string;
  /** First assistant message of the turn. */
  assistant: string;
  /** Every assistant message of the turn, in send order (one per spoken response). */
  assistants?: string[];
}

export interface ChatMessageResponse {
  reply: string;
  raw: unknown;
  request?: unknown;
  notifications?: ChatThreadNotification[];
  timing?: ChatReplyTiming;
  messageIds?: ChatTurnMessageIds;
  /** Files sent with this reply (metadata.send_attachments). */
  attachments?: ChatAttachmentRef[];
}

export interface ChatThreadNotification {
  employeeId: string;
  digitalEmployeeId?: string;
  message: ChatThreadMessage;
  raw?: unknown;
}

export type ChatMessageAuthor = "you" | "assistant";

export interface ChatThreadMessage {
  id: string;
  author: ChatMessageAuthor;
  speaker: string;
  text: string;
  createdAt?: string;
  actions?: string[];
  buttons?: LlmReplyButton[];
  navigateAddress?: string;
  /** Emoji reaction attached to the speaker's message (metadata.show_icon). */
  showIcon?: string;
  /** Files on this message (view-only in the web chat). */
  attachments?: ChatAttachmentRef[];
  llmMs?: number;
  afterLlmMs?: number;
}

export interface ChatHistoryResponse {
  employeeId: string;
  digitalEmployeeId?: string;
  conversationId: string | null;
  startedAt: string | null;
  messages: ChatThreadMessage[];
  raw: unknown;
  request?: unknown;
  isNew: boolean;
}

export interface ChatLiveEvent {
  employeeId: string;
  digitalEmployeeId?: string;
  message: ChatThreadMessage;
  raw?: unknown;
}

export interface WhatsAppFlowEvent {
  at: string;
  step: string;
  detail: string;
}

export interface WhatsAppStatusResponse {
  expectedWebhook: string;
  metaWabaWebhook: string | null;
  metaAppWebhook: string | null;
  webhookMismatch: boolean;
  hasAccessToken: boolean;
  lastInboundAt: string | null;
  events: WhatsAppFlowEvent[];
}

export function chatThreadKey(employeeId: string, digitalEmployeeId: string): string {
  return `${employeeId}:${digitalEmployeeId}`;
}
