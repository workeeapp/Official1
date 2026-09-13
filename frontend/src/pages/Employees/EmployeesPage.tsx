import { useEffect, useState } from "react";
import type {
  EmployeeInput,
  EmployeeRecordField,
  EmployeeRecordItem,
  EmployeeRecordsResponse,
  PublicEmployee,
} from "@workee/shared";
import { useEmployees } from "@/hooks/useEmployees";
import { EmployeeFormDialog } from "@/components/EmployeeFormDialog";
import { EmployeeRecordDialog } from "@/components/EmployeeRecordDialog";
import { employeeApi } from "@/services/employee.service";
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

export function EmployeesPage() {
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
  const [records, setRecords] = useState<EmployeeRecordsResponse | null>(null);
  const [recordsStatus, setRecordsStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<EmployeeRecordItem | null>(null);
  const [recordSubmitting, setRecordSubmitting] = useState(false);
  const [recordFormError, setRecordFormError] = useState<string | null>(null);

  const selectedEmployee =
    employees.find((employee) => employee.id === selectedId) ?? null;
  const canMutateSelected = Boolean(
    selectedEmployee && !isDefaultEmployee(selectedEmployee),
  );

  useEffect(() => {
    if (!selectedEmployee || isDefaultEmployee(selectedEmployee)) {
      setRecords(null);
      setRecordsStatus(selectedEmployee ? "ready" : "idle");
      setRecordsError(null);
      return;
    }

    const employeeId = selectedEmployee.id;
    const abort = new AbortController();
    setRecordsStatus("loading");
    setRecordsError(null);

    employeeApi
      .records(employeeId, abort.signal)
      .then((payload) => {
        setRecords(payload);
        setRecordsStatus("ready");
      })
      .catch((caught) => {
        if (caught instanceof ApiError && caught.code === "ABORTED") {
          return;
        }
        setRecords(null);
        setRecordsStatus("error");
        setRecordsError(
          caught instanceof ApiError
            ? caught.message
            : "Unable to load saved employee data.",
        );
      });

    return () => abort.abort();
  }, [selectedEmployee]);

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

  async function handleRecordSave(fields: EmployeeRecordField[]) {
    if (!selectedEmployee || !editingItem) {
      return;
    }

    setRecordSubmitting(true);
    setRecordFormError(null);
    try {
      const { records: next } = await employeeApi.updateRecord(
        selectedEmployee.id,
        editingItem.id,
        fields,
      );
      setRecords(next);
      setEditingItem(null);
    } catch (caught) {
      setRecordFormError(
        caught instanceof ApiError ? caught.message : "Unable to update item.",
      );
    } finally {
      setRecordSubmitting(false);
    }
  }

  async function handleRecordDelete(item: EmployeeRecordItem) {
    if (!selectedEmployee) {
      return;
    }

    const confirmed = window.confirm(`Delete ${item.title}?`);
    if (!confirmed) {
      return;
    }

    setActionError(null);
    try {
      const { records: next } = await employeeApi.deleteRecord(
        selectedEmployee.id,
        item.id,
      );
      setRecords(next);
    } catch (caught) {
      setActionError(
        caught instanceof ApiError ? caught.message : "Unable to delete item.",
      );
    }
  }

  return (
    <>
      <section
        data-testid="employees-page"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-primary">Employees</p>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">
              Team
            </h1>
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

      {selectedEmployee ? (
        <EmployeeRecordsPanel
          employee={selectedEmployee}
          records={records}
          status={recordsStatus}
          error={recordsError}
          onEdit={setEditingItem}
          onDelete={(item) => void handleRecordDelete(item)}
        />
      ) : null}

      {editingItem ? (
        <EmployeeRecordDialog
          item={editingItem}
          submitting={recordSubmitting}
          error={recordFormError}
          onClose={() => {
            setEditingItem(null);
            setRecordFormError(null);
          }}
          onSubmit={handleRecordSave}
        />
      ) : null}

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

function EmployeeRecordsPanel({
  employee,
  records,
  status,
  error,
  onEdit,
  onDelete,
}: {
  employee: PublicEmployee;
  records: EmployeeRecordsResponse | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onEdit: (item: EmployeeRecordItem) => void;
  onDelete: (item: EmployeeRecordItem) => void;
}) {
  const groups = records?.groups ?? [];

  return (
    <section
      data-testid="employee-records"
      className="mt-6 rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
    >
      <p className="text-sm font-medium text-primary">Saved data</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">
        {employeeDisplayName(employee)}
      </h2>

      {status === "loading" ? (
        <p className="mt-4 text-sm text-text-secondary">Loading saved data…</p>
      ) : null}

      {status === "error" ? (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      ) : null}

      {status === "ready" && groups.length === 0 ? (
        <p className="mt-4 text-sm text-text-secondary">
          No lists, tasks, contacts, or filings saved for this employee.
        </p>
      ) : null}

      {status === "ready"
        ? groups.map((group) => (
            <div key={`${group.type}-${group.title}`} className="mt-6">
              <h3 className="text-sm font-semibold text-text-primary">{group.title}</h3>
              <ul className="mt-3 space-y-3">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    data-testid="employee-record-item"
                    className="rounded-xl border border-border bg-background px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium text-text-primary" dir="auto">
                        {item.title}
                      </p>
                      <div className="flex shrink-0 items-center rounded-xl border border-border bg-surface p-0.5">
                        <IconButton label={`Edit ${item.title}`} onClick={() => onEdit(item)}>
                          <PencilIcon />
                        </IconButton>
                        <IconButton label={`Delete ${item.title}`} onClick={() => onDelete(item)}>
                          <TrashIcon />
                        </IconButton>
                      </div>
                    </div>
                    {item.details.length > 0 ? (
                      <dl className="mt-2 space-y-1 text-sm text-text-secondary">
                        {item.details.map((detail) => (
                          <div key={`${item.id}-${detail.label}`} className="flex flex-wrap gap-x-2">
                            <dt className="font-medium">{detail.label}</dt>
                            <dd dir="auto">{detail.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    <p className="mt-2 text-xs text-text-secondary">
                      Created by {item.createdBy} · {formatRecordDate(item.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
    </section>
  );
}

function formatRecordDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
