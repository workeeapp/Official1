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
  instructions?: string | null;
  protected?: boolean;
}

export interface EmployeesResponse {
  employees: PublicEmployee[];
  count: number;
}

export interface EmployeeRecordField {
  label: string;
  value: string;
}

export interface EmployeeRecordItem {
  id: string;
  kind: "list" | "filing";
  title: string;
  details: EmployeeRecordField[];
  fields: EmployeeRecordField[];
  createdBy: string;
  createdAt: string;
}

export interface EmployeeRecordMutationRequest {
  fields: EmployeeRecordField[];
}

export interface EmployeeRecordGroup {
  type: string;
  title: string;
  items: EmployeeRecordItem[];
}

export interface EmployeeRecordsResponse {
  employeeId: string;
  groups: EmployeeRecordGroup[];
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
  instructions?: string | null;
}

export interface DigitalEmployeeDefaults {
  model: string;
  temperature: number;
  instructions: string;
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

export function isProtectedEmployee(
  employee: Pick<PublicEmployee, "protected">,
): boolean {
  return employee.protected === true;
}

export interface ChatMessageRequest {
  message: string;
  employeeId: string;
  digitalEmployeeId?: string;
}

export interface ChatMessageResponse {
  reply: string;
  raw: unknown;
  notifications?: ChatThreadNotification[];
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
}

export interface ChatHistoryResponse {
  employeeId: string;
  digitalEmployeeId?: string;
  conversationId: string | null;
  startedAt: string | null;
  messages: ChatThreadMessage[];
  raw: unknown;
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
