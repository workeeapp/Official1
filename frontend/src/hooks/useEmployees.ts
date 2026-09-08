import { useCallback, useEffect, useState } from "react";
import type { EmployeeInput, PublicEmployee } from "@workee/shared";
import { employeeApi, withDefaultEmployee } from "@/services/employee.service";
import { ApiError } from "@/types";

interface EmployeesState {
  employees: PublicEmployee[];
  tableEmployees: PublicEmployee[];
  count: number;
  status: "loading" | "ready" | "error";
  error: string | null;
  reload: () => Promise<void>;
  createEmployee: (input: EmployeeInput) => Promise<void>;
  updateEmployee: (id: string, input: EmployeeInput) => Promise<void>;
  deleteEmployee: (id: string) => Promise<void>;
}

function toVisibleState(employees: PublicEmployee[]) {
  const visibleEmployees = withDefaultEmployee(employees);
  return {
    employees: visibleEmployees,
    tableEmployees: employees,
    count: visibleEmployees.length,
  };
}

export function useEmployees(): EmployeesState {
  const [state, setState] = useState<Omit<
    EmployeesState,
    "reload" | "createEmployee" | "updateEmployee" | "deleteEmployee"
  >>({
    employees: [],
    tableEmployees: [],
    count: 0,
    status: "loading",
    error: null,
  });

  const load = useCallback(async () => {
    const { employees } = await employeeApi.list();
    setState({
      ...toVisibleState(employees),
      status: "ready",
      error: null,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    employeeApi
      .list()
      .then(({ employees }) => {
        if (!cancelled) {
          setState({
            ...toVisibleState(employees),
            status: "ready",
            error: null,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            ...toVisibleState([]),
            status: "error",
            error:
              error instanceof ApiError
                ? error.message
                : "Unable to load employees.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const createEmployee = useCallback(async (input: EmployeeInput) => {
    await employeeApi.create(input);
    await load();
  }, [load]);

  const updateEmployee = useCallback(
    async (id: string, input: EmployeeInput) => {
      await employeeApi.update(id, input);
      await load();
    },
    [load],
  );

  const deleteEmployee = useCallback(
    async (id: string) => {
      await employeeApi.remove(id);
      await load();
    },
    [load],
  );

  return {
    ...state,
    reload: load,
    createEmployee,
    updateEmployee,
    deleteEmployee,
  };
}
