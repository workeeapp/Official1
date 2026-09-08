import { useState } from "react";
import type { EmployeeInput, PublicEmployee } from "@workee/shared";
import { useAuth } from "@/hooks/useAuth";
import { useEmployees } from "@/hooks/useEmployees";
import { EmployeeFormDialog } from "@/components/EmployeeFormDialog";
import {
  IconButton,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/IconButton";
import {
  employeeDisplayName,
  employeeFullName,
  isDefaultEmployee,
} from "@/services/employee.service";
import { ApiError } from "@/types";

type DialogMode = "add" | "update" | null;

export function DashboardPage() {
  const { user } = useAuth();
  const {
    employees,
    count,
    status,
    error,
    createEmployee,
    updateEmployee,
    deleteEmployee,
  } = useEmployees();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedEmployee =
    employees.find((employee) => employee.id === selectedId) ?? null;
  const canMutateSelected = Boolean(
    selectedEmployee && !isDefaultEmployee(selectedEmployee),
  );

  function openAdd() {
    setFormError(null);
    setActionError(null);
    setDialogMode("add");
  }

  function openUpdate() {
    if (!canMutateSelected) {
      setActionError(
        selectedEmployee
          ? "The default employee cannot be updated."
          : "Select an employee to update.",
      );
      return;
    }

    setFormError(null);
    setActionError(null);
    setDialogMode("update");
  }

  async function handleDelete() {
    if (!selectedEmployee || !canMutateSelected) {
      setActionError(
        selectedEmployee
          ? "The default employee cannot be deleted."
          : "Select an employee to delete.",
      );
      return;
    }

    const confirmed = window.confirm(
      `Delete ${employeeDisplayName(selectedEmployee)}?`,
    );
    if (!confirmed) {
      return;
    }

    setActionError(null);
    try {
      await deleteEmployee(selectedEmployee.id);
      setSelectedId(null);
    } catch (caught) {
      setActionError(
        caught instanceof ApiError ? caught.message : "Unable to delete employee.",
      );
    }
  }

  async function handleSubmit(input: EmployeeInput) {
    setSubmitting(true);
    setFormError(null);

    try {
      if (dialogMode === "add") {
        await createEmployee(input);
      } else if (dialogMode === "update" && selectedEmployee) {
        await updateEmployee(selectedEmployee.id, input);
      }
      setDialogMode(null);
    } catch (caught) {
      setFormError(
        caught instanceof ApiError ? caught.message : "Unable to save employee.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!user) {
    return null;
  }

  return (
    <>
      <section
        data-testid="dashboard-page"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <p className="text-sm font-medium text-primary">Dashboard</p>
        <h1
          data-testid="dashboard-greeting"
          className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl"
        >
          Hello, {user.username}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary sm:text-base">
          Welcome back to your dashboard.
        </p>
      </section>

      <section
        data-testid="employees-section"
        className="mt-6 rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-primary">Employees</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">
              Team
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p
              data-testid="employee-count"
              className="text-sm font-medium text-text-secondary"
            >
              {status === "loading"
                ? "Loading employees…"
                : `${count} ${count === 1 ? "employee" : "employees"}`}
            </p>
            <div
              data-testid="employee-actions"
              className="flex items-center rounded-xl border border-border bg-background p-0.5"
            >
              <IconButton label="Add employee" onClick={openAdd}>
                <PlusIcon />
              </IconButton>
              <IconButton
                label="Update employee"
                onClick={openUpdate}
                disabled={!canMutateSelected}
              >
                <PencilIcon />
              </IconButton>
              <IconButton
                label="Delete employee"
                onClick={handleDelete}
                disabled={!canMutateSelected}
              >
                <TrashIcon />
              </IconButton>
            </div>
          </div>
        </div>

        {status === "error" ? (
          <p role="alert" className="mt-4 text-sm text-error">
            {error}
          </p>
        ) : null}

        {actionError ? (
          <p role="alert" className="mt-4 text-sm text-error">
            {actionError}
          </p>
        ) : null}

        {status === "ready" && employees.length === 0 ? (
          <p className="mt-4 text-sm text-text-secondary">No employees yet.</p>
        ) : null}

        {selectedEmployee ? (
          <p
            data-testid="employee-contact"
            className="mt-4 text-sm text-text-secondary"
          >
            {[selectedEmployee.email, selectedEmployee.phone]
              .filter(Boolean)
              .join(" · ") || "No email or phone"}
          </p>
        ) : null}

        {employees.length > 0 ? (
          <ul
            data-testid="employee-nicknames"
            className="mt-5 flex flex-wrap gap-2"
          >
            {employees.map((employee) => (
              <EmployeeChip
                key={employee.id}
                employee={employee}
                selected={employee.id === selectedId}
                onSelect={() => {
                  setSelectedId(employee.id);
                  setActionError(null);
                }}
              />
            ))}
          </ul>
        ) : null}
      </section>

      {dialogMode ? (
        <EmployeeFormDialog
          mode={dialogMode}
          employee={dialogMode === "update" ? selectedEmployee : null}
          submitting={submitting}
          error={formError}
          onClose={() => setDialogMode(null)}
          onSubmit={handleSubmit}
        />
      ) : null}
    </>
  );
}

function EmployeeChip({
  employee,
  selected,
  onSelect,
}: {
  employee: PublicEmployee;
  selected: boolean;
  onSelect: () => void;
}) {
  const fullName = employeeFullName(employee);
  const contact = [employee.email, employee.phone].filter(Boolean).join(" · ");
  const title = contact ? `${fullName} · ${contact}` : fullName;

  return (
    <li>
      <button
        type="button"
        title={title}
        aria-pressed={selected}
        aria-label={`${employeeDisplayName(employee)}, ${fullName}`}
        onClick={onSelect}
        className={`group relative inline-flex min-h-11 cursor-pointer items-center rounded-full px-3.5 text-sm font-medium transition-colors ${
          selected
            ? "bg-primary text-white"
            : "bg-primary-light text-primary hover:bg-primary/15"
        }`}
      >
        <span dir="auto">{employeeDisplayName(employee)}</span>
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-text-primary px-2.5 py-1 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span dir="auto">{title}</span>
        </span>
      </button>
    </li>
  );
}
