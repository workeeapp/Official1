import { useEffect, useMemo, useState } from "react";
import type {
  ChatAttachmentRef,
  EmployeeInput,
  EmployeeRecordField,
  EmployeeRecordItem,
  EmployeeRecordLinkedList,
  EmployeeRecordsResponse,
  EmployeeUsageSummary,
  JobUrgency,
  PublicEmployee,
  PublicTeam,
  TeamUsageSummary,
} from "@workee/shared";
import {
  DEFAULT_REGISTERED_TEAM_NAME,
  JOB_URGENCY_POLICY,
  isDigitalEmployee,
  isProtectedEmployee,
} from "@workee/shared";
import { useEmployees } from "@/hooks/useEmployees";
import { EmployeeFormDialog } from "@/components/EmployeeFormDialog";
import { EmployeeRecordDialog } from "@/components/EmployeeRecordDialog";
import { employeeApi } from "@/services/employee.service";
import { teamApi } from "@/services/team.service";
import { attachmentApi } from "@/services/attachment.service";
import {
  IconButton,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/IconButton";
import {
  employeeDisplayName,
  employeeFullName,
  formatUsd,
} from "@/services/employee.service";
import { WorkeeMark } from "@/components/Logo";
import { ApiError } from "@/types";

type DialogMode = "add" | "update" | null;

export function EmployeesPage() {
  const {
    employees,
    status,
    error,
    createEmployee,
    updateEmployee,
    deleteEmployee,
  } = useEmployees();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [teams, setTeams] = useState<PublicTeam[]>([]);
  const [teamsStatus, setTeamsStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [watchedTeamId, setWatchedTeamId] = useState<string>("");
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [records, setRecords] = useState<EmployeeRecordsResponse | null>(null);
  const [recordsStatus, setRecordsStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [usage, setUsage] = useState<EmployeeUsageSummary | null>(null);
  const [teamUsage, setTeamUsage] = useState<TeamUsageSummary | null>(null);
  const [editingItem, setEditingItem] = useState<EmployeeRecordItem | null>(null);
  const [recordSubmitting, setRecordSubmitting] = useState(false);
  const [recordFormError, setRecordFormError] = useState<string | null>(null);

  const visibleEmployees = useMemo(() => {
    if (!watchedTeamId) {
      return employees;
    }
    return employees.filter((employee) => employee.teamId === watchedTeamId);
  }, [employees, watchedTeamId]);

  const count = visibleEmployees.length;
  const selectedEmployee =
    visibleEmployees.find((employee) => employee.id === selectedId) ?? null;
  const canUpdateSelected = Boolean(selectedEmployee);
  const canDeleteSelected = Boolean(
    selectedEmployee && !isProtectedEmployee(selectedEmployee),
  );
  const watchedTeam =
    teams.find((team) => team.id === watchedTeamId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setTeamsStatus("loading");
    teamApi
      .list()
      .then(({ teams: next }) => {
        if (cancelled) {
          return;
        }
        setTeams(next);
        setTeamsStatus("ready");
        setWatchedTeamId((current) => {
          if (current && next.some((team) => team.id === current)) {
            return current;
          }
          const personal =
            next.find((team) => team.name !== DEFAULT_REGISTERED_TEAM_NAME) ??
            next[0];
          return personal?.id ?? "";
        });
      })
      .catch(() => {
        if (!cancelled) {
          setTeams([]);
          setTeamsStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    if (!visibleEmployees.some((employee) => employee.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleEmployees]);

  useEffect(() => {
    if (status !== "ready" || !watchedTeamId) {
      return;
    }
    const abort = new AbortController();
    employeeApi
      .teamUsage({ teamId: watchedTeamId, signal: abort.signal })
      .then(setTeamUsage)
      .catch(() => setTeamUsage(null));
    return () => abort.abort();
  }, [status, employees, watchedTeamId]);

  useEffect(() => {
    if (!selectedEmployee) {
      setRecords(null);
      setRecordsStatus("idle");
      setRecordsError(null);
      setUsage(null);
      return;
    }

    const employeeId = selectedEmployee.id;
    const abort = new AbortController();
    setRecordsStatus("loading");
    setRecordsError(null);
    setUsage(null);

    employeeApi
      .usage(employeeId, abort.signal)
      .then(setUsage)
      .catch(() => setUsage(null));

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
    if (!canUpdateSelected) {
      setActionError("Select an employee to update.");
      return;
    }

    setFormError(null);
    setActionError(null);
    setDialogMode("update");
  }

  async function handleDelete() {
    if (!selectedEmployee || !canDeleteSelected) {
      setActionError(
        selectedEmployee
          ? "Lucy cannot be deleted."
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
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-primary">Employees</p>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="max-w-xs w-full">
                <label
                  htmlFor="watched-team"
                  className="text-sm font-medium text-text-primary"
                >
                  Watching team
                </label>
                <select
                  id="watched-team"
                  name="watchedTeam"
                  data-testid="watched-team"
                  value={watchedTeamId}
                  disabled={teamsStatus !== "ready" || teams.length === 0}
                  onChange={(event) => {
                    setWatchedTeamId(event.target.value);
                    setActionError(null);
                  }}
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-text-primary shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                >
                  {teamsStatus === "loading" ? (
                    <option value="">Loading teams…</option>
                  ) : teamsStatus === "error" ? (
                    <option value="">Unable to load teams</option>
                  ) : teams.length === 0 ? (
                    <option value="">No teams</option>
                  ) : (
                    teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {teamDisplayName(team)}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <h1 className="flex flex-wrap items-baseline gap-x-3 text-xl font-semibold tracking-tight text-text-primary">
                <span data-testid="watched-team-heading">
                  {watchedTeam ? teamDisplayName(watchedTeam) : "Team"}
                </span>
                {teamUsage ? (
                  <span
                    data-testid="team-usage"
                    className="text-sm font-medium text-text-secondary"
                    title="Employees on this team (human employees only)"
                  >
                    {formatUsd(teamUsage.allEmployeesUsd)} (
                    {formatUsd(teamUsage.humanEmployeesUsd)})
                  </span>
                ) : null}
              </h1>
            </div>
            {teamUsage && teamUsage.months.length > 0 ? (
              <ul
                data-testid="team-usage-months"
                className="mt-1 space-y-0.5 text-sm text-text-secondary"
              >
                {teamUsage.months.map((row) => {
                  const [year, month] = row.month.split("-");
                  return (
                    <li key={row.month}>
                      <span className="font-medium">
                        {month}/{year}
                      </span>{" "}
                      {formatUsd(row.allEmployeesUsd)} ({formatUsd(row.humanEmployeesUsd)})
                    </li>
                  );
                })}
              </ul>
            ) : null}
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
                disabled={!canUpdateSelected}
              >
                <PencilIcon />
              </IconButton>
              <IconButton
                label="Delete employee"
                onClick={handleDelete}
                disabled={!canDeleteSelected}
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

        {status === "ready" && visibleEmployees.length === 0 ? (
          <p className="mt-4 text-sm text-text-secondary">
            {employees.length === 0
              ? "No employees yet."
              : "No employees on this team."}
          </p>
        ) : null}

        {selectedEmployee ? (
          <p
            data-testid="employee-contact"
            className="mt-4 text-sm text-text-secondary"
          >
            {isDigitalEmployee(selectedEmployee)
              ? [
                  selectedEmployee.model,
                  selectedEmployee.temperature != null
                    ? `Temperature ${selectedEmployee.temperature}`
                    : null,
                  selectedEmployee.reasoningEffort
                    ? `Reasoning ${selectedEmployee.reasoningEffort}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No model configured"
              : [selectedEmployee.email, selectedEmployee.phone]
                  .filter(Boolean)
                  .join(" · ") || "No email or phone"}
          </p>
        ) : null}

        {visibleEmployees.length > 0 ? (
          <ul
            data-testid="employee-nicknames"
            className="mt-5 flex flex-wrap gap-2"
          >
            {visibleEmployees.map((employee) => (
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
          usage={usage}
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

function teamDisplayName(team: PublicTeam): string {
  const name = team.name?.trim();
  return name && name.length > 0 ? name : "Untitled team";
}

function recordGroupKey(group: {
  type: string;
  title: string;
  listId?: string;
}): string {
  return `${group.type}-${group.listId ?? group.title}`;
}

function EmployeeRecordsPanel({
  employee,
  records,
  usage,
  status,
  error,
  onEdit,
  onDelete,
}: {
  employee: PublicEmployee;
  records: EmployeeRecordsResponse | null;
  usage: EmployeeUsageSummary | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onEdit: (item: EmployeeRecordItem) => void;
  onDelete: (item: EmployeeRecordItem) => void;
}) {
  const groups = records?.groups ?? [];
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setOpenKeys(new Set());
  }, [employee.id]);

  function toggleGroup(key: string) {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function openLinkedList(listId: string) {
    const target = groups.find((group) => group.listId === listId);
    if (!target) {
      return;
    }
    const key = recordGroupKey(target);
    setOpenKeys((current) => {
      if (current.has(key)) {
        return current;
      }
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  return (
    <section
      data-testid="employee-records"
      className="mt-6 rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
    >
      <p className="text-sm font-medium text-primary">Saved data</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">
        {employeeDisplayName(employee)}
      </h2>
      {usage ? (
        <p
          data-testid="employee-usage"
          className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-secondary"
        >
          <span>
            Number of conversations{" "}
            <span className="font-semibold text-text-primary">{usage.conversations}</span>{" "}
            <span title="Interactions">({usage.interactions})</span>
          </span>
          <span>
            Total amount{" "}
            <span className="font-semibold text-text-primary">
              {formatUsd(usage.totalUsd)}
            </span>
          </span>
        </p>
      ) : null}
      {usage && usage.months.length > 0 ? (
        <ul
          data-testid="employee-usage-months"
          className="mt-1 space-y-0.5 text-sm text-text-secondary"
        >
          {usage.months.map((row) => {
            const [year, month] = row.month.split("-");
            return (
              <li key={row.month} className="flex flex-wrap gap-x-6 gap-y-1">
                <span className="font-medium">
                  {month}/{year}
                </span>
                <span>
                  Number of conversations{" "}
                  <span className="font-semibold text-text-primary">{row.conversations}</span>{" "}
                  <span title="Interactions">({row.interactions})</span>
                </span>
                <span>
                  Total amount{" "}
                  <span className="font-semibold text-text-primary">
                    {formatUsd(row.totalUsd)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

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
          No lists, tasks, contacts, filings, or reminders saved for this employee.
        </p>
      ) : null}

      {status === "ready"
        ? groups.map((group) => {
            const key = recordGroupKey(group);
            const open = openKeys.has(key);
            const panelId = `employee-record-group-${key}`;
            return (
              <div
                key={key}
                id={group.listId ? recordListAnchorId(group.listId) : undefined}
                className="mt-4 scroll-mt-4"
              >
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => toggleGroup(key)}
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-center transition-colors hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <span
                    className="text-lg font-semibold tracking-tight text-text-primary sm:text-xl"
                    dir="auto"
                  >
                    {group.title}
                  </span>
                  <span className="text-sm font-medium text-text-secondary">
                    ({group.items.length})
                  </span>
                  <span
                    aria-hidden="true"
                    className={`text-text-secondary transition-transform ${open ? "rotate-180" : ""}`}
                  >
                    ▾
                  </span>
                </button>
                {open ? (
                  <ul
                    id={panelId}
                    className="mt-1 divide-y divide-border/70 border-t border-border/70"
                  >
                    {group.items.map((item) => (
                      <EmployeeRecordRow
                        key={item.id}
                        item={item}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onOpenLinkedList={openLinkedList}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })
        : null}
    </section>
  );
}

function EmployeeRecordRow({
  item,
  onEdit,
  onDelete,
  onOpenLinkedList,
}: {
  item: EmployeeRecordItem;
  onEdit: (item: EmployeeRecordItem) => void;
  onDelete: (item: EmployeeRecordItem) => void;
  onOpenLinkedList: (listId: string) => void;
}) {
  const canMutate = item.kind === "list" || item.kind === "filing";

  return (
    <li
      data-testid="employee-record-item"
      className="flex min-h-11 items-center gap-2 py-1.5 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-text-primary" dir="auto">
          <span className="font-medium">{item.title}</span>
          {item.urgency ? <UrgencyBadge urgency={item.urgency} /> : null}
          {item.linkedLists?.map((linked) => (
            <LinkedListChip
              key={linked.listId}
              linked={linked}
              onOpen={onOpenLinkedList}
            />
          ))}
          {item.attachments?.map((file) => (
            <AttachmentChip key={file.id} file={file} />
          ))}
        </p>
      </div>
      {canMutate ? (
        <div className="flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5">
          <IconButton label={`Edit ${item.title}`} onClick={() => onEdit(item)}>
            <PencilIcon />
          </IconButton>
          <IconButton label={`Delete ${item.title}`} onClick={() => onDelete(item)}>
            <TrashIcon />
          </IconButton>
        </div>
      ) : null}
    </li>
  );
}

function UrgencyBadge({ urgency }: { urgency: JobUrgency }) {
  if (urgency === "normal") {
    return null;
  }
  const label = JOB_URGENCY_POLICY[urgency].label || urgency;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
        urgency === "very_urgent"
          ? "bg-error/15 text-error"
          : "bg-amber-100 text-amber-800"
      }`}
    >
      {label}
    </span>
  );
}

function LinkedListChip({
  linked,
  onOpen,
}: {
  linked: EmployeeRecordLinkedList;
  onOpen: (listId: string) => void;
}) {
  return (
    <a
      href={`#${recordListAnchorId(linked.listId)}`}
      onClick={() => onOpen(linked.listId)}
      className="inline-flex max-w-[12rem] truncate rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/20"
      title={linked.listName}
      dir="auto"
    >
      🗂️ {linked.listName}
    </a>
  );
}

function AttachmentChip({ file }: { file: ChatAttachmentRef }) {
  const url = attachmentApi.contentUrl(file.id);
  const label = file.file_name || file.kind;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-[12rem] truncate rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/20"
      title={label}
      dir="auto"
    >
      📎 {label}
    </a>
  );
}

function recordListAnchorId(listId: string): string {
  return `employee-list-${listId}`;
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
  const contact = isDigitalEmployee(employee)
    ? employee.model
    : [employee.email, employee.phone].filter(Boolean).join(" · ");
  const title = contact ? `${fullName} · ${contact}` : fullName;

  return (
    <li>
      <button
        type="button"
        title={title}
        aria-pressed={selected}
        aria-label={`${employeeDisplayName(employee)}, ${fullName}`}
        onClick={onSelect}
        className={`group relative inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors ${
          selected
            ? "bg-primary text-white"
            : "bg-primary-light text-primary hover:bg-primary/15"
        }`}
      >
        {isDigitalEmployee(employee) ? <WorkeeMark inverted={selected} /> : null}
        <span dir="auto">
          {employeeDisplayName(employee)}
          {employee.isOwner ? " · owner" : ""}
        </span>
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
