import type {
  AdminCodeChangesResponse,
  AdminCiStatusResponse,
  AdminMonitoringResponse,
  AdminSetAdminResponse,
  AdminUsersResponse,
} from "@workee/shared";
import { api } from "./http";

export const adminApi = {
  monitoring(signal?: AbortSignal): Promise<AdminMonitoringResponse> {
    return api<AdminMonitoringResponse>("/api/admin/monitoring", { signal });
  },
  ciStatus(signal?: AbortSignal): Promise<AdminCiStatusResponse> {
    return api<AdminCiStatusResponse>("/api/admin/ci-status", { signal });
  },
  codeChanges(
    hours = 24,
    signal?: AbortSignal,
  ): Promise<AdminCodeChangesResponse> {
    return api<AdminCodeChangesResponse>(
      `/api/admin/code-changes?hours=${encodeURIComponent(String(hours))}`,
      { signal },
    );
  },
  users(signal?: AbortSignal): Promise<AdminUsersResponse> {
    return api<AdminUsersResponse>("/api/admin/users", { signal });
  },
  setAdmin(
    userId: string,
    isAdmin: boolean,
  ): Promise<AdminSetAdminResponse> {
    return api<AdminSetAdminResponse>(
      `/api/admin/users/${encodeURIComponent(userId)}/admin`,
      {
        method: "PATCH",
        body: JSON.stringify({ isAdmin }),
      },
    );
  },
};
