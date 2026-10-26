import type {
  DigitalEmployeeDefaults,
  EmployeeInput,
  EmployeeRecordField,
  EmployeeRecordsResponse,
  EmployeesResponse,
  EmployeeUsageSummary,
  PublicEmployee,
  TeamUsageSummary,
} from "@workee/shared";
import { api } from "./http";

export const employeeApi = {
  list(): Promise<EmployeesResponse> {
    return api<EmployeesResponse>("/api/employees");
  },

  digitalDefaults(): Promise<DigitalEmployeeDefaults> {
    return api<DigitalEmployeeDefaults>("/api/employees/digital-defaults");
  },

  configFileDefaults(): Promise<DigitalEmployeeDefaults> {
    return api<DigitalEmployeeDefaults>("/api/employees/config-defaults");
  },

  create(input: EmployeeInput): Promise<{ employee: PublicEmployee }> {
    return api<{ employee: PublicEmployee }>("/api/employees", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  update(id: string, input: EmployeeInput): Promise<{ employee: PublicEmployee }> {
    return api<{ employee: PublicEmployee }>(`/api/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  remove(id: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/employees/${id}`, {
      method: "DELETE",
    });
  },

  records(id: string, signal?: AbortSignal): Promise<EmployeeRecordsResponse> {
    return api<EmployeeRecordsResponse>(`/api/employees/${id}/records`, { signal });
  },

  teamUsage(signal?: AbortSignal): Promise<TeamUsageSummary> {
    return api<TeamUsageSummary>("/api/employees/usage", { signal });
  },

  usage(id: string, signal?: AbortSignal): Promise<EmployeeUsageSummary> {
    return api<EmployeeUsageSummary>(`/api/employees/${id}/usage`, { signal });
  },

  updateRecord(
    employeeId: string,
    itemId: string,
    fields: EmployeeRecordField[],
  ): Promise<{ records: EmployeeRecordsResponse }> {
    return api<{ records: EmployeeRecordsResponse }>(
      `/api/employees/${employeeId}/records/${itemId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ fields }),
      },
    );
  },

  deleteRecord(
    employeeId: string,
    itemId: string,
  ): Promise<{ records: EmployeeRecordsResponse }> {
    return api<{ records: EmployeeRecordsResponse }>(
      `/api/employees/${employeeId}/records/${itemId}`,
      { method: "DELETE" },
    );
  },
};

export function employeeFullName(employee: PublicEmployee): string {
  return `${employee.name} ${employee.surname}`.trim();
}

export function employeeDisplayName(employee: PublicEmployee): string {
  return employee.nickname?.trim() || employee.name;
}

/** Per-turn LLM costs are tiny; sub-$0.0001 keep 6 decimals, else under $1 keep 4. */
export function formatUsd(amount: number): string {
  const maxFractionDigits =
    amount > 0 && amount < 0.0001 ? 6 : amount > 0 && amount < 1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFractionDigits,
  }).format(amount);
}
