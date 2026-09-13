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

export interface PublicEmployee {
  id: string;
  name: string;
  surname: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
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
  name: string;
  surname: string;
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ChatMessageRequest {
  message: string;
  employeeId: string;
}

export interface ChatMessageResponse {
  reply: string;
  raw: unknown;
  notifications?: ChatThreadNotification[];
}

export interface ChatThreadNotification {
  employeeId: string;
  message: ChatThreadMessage;
  raw?: unknown;
}

export type ChatMessageAuthor = "you" | "assistant";

export interface ChatThreadMessage {
  id: string;
  author: ChatMessageAuthor;
  speaker: string;
  text: string;
  actions?: string[];
}

export interface ChatHistoryResponse {
  employeeId: string;
  conversationId: string | null;
  startedAt: string | null;
  messages: ChatThreadMessage[];
  raw: unknown;
  isNew: boolean;
}

export interface ChatLiveEvent {
  employeeId: string;
  message: ChatThreadMessage;
  raw?: unknown;
}
