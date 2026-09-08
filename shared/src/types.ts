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
}
