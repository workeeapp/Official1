import type {
  EmployeeInput,
  EmployeeRecordField,
  EmployeeRecordsResponse,
  EmployeesResponse,
  PublicEmployee,
} from "@workee/shared";
import { api } from "./http";

export const DEFAULT_EMPLOYEE: PublicEmployee = {
  id: "default-lucy",
  name: "לוסי",
  surname: "",
  nickname: "לוסי",
  email: null,
  phone: null,
};

export function isDefaultEmployee(employee: Pick<PublicEmployee, "id">): boolean {
  return employee.id === DEFAULT_EMPLOYEE.id;
}

export const employeeApi = {
  list(): Promise<EmployeesResponse> {
    return api<EmployeesResponse>("/api/employees");
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

export function withDefaultEmployee(employees: PublicEmployee[]): PublicEmployee[] {
  const alreadyIncluded = employees.some(
    (employee) =>
      employee.id === DEFAULT_EMPLOYEE.id || employee.nickname === DEFAULT_EMPLOYEE.nickname,
  );

  return alreadyIncluded ? employees : [DEFAULT_EMPLOYEE, ...employees];
}

export function employeeFullName(employee: PublicEmployee): string {
  return `${employee.name} ${employee.surname}`.trim();
}

export function employeeDisplayName(employee: PublicEmployee): string {
  return employee.nickname?.trim() || employee.name;
}
