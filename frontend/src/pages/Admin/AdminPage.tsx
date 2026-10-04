import { useCallback, useEffect, useState } from "react";
import type {
  AdminCiStatusResponse,
  AdminCodeChangesResponse,
  AdminMonitoringResponse,
  AdminUserRow,
} from "@workee/shared";
import { Button } from "@/components/Button";
import { useAuth } from "@/hooks/useAuth";
import { adminApi } from "@/services/admin.service";
import { ApiError } from "@/types";
import { buildCiView } from "./ci-view";
import { buildMonitoringView } from "./monitoring-view";

const CODE_PREVIEW_COUNT = 5;

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function checkTone(state: "ok" | "warn" | "bad" | "idle"): string {
  if (state === "ok" || state === "idle") {
    return "border-border bg-background text-text-primary";
  }
  if (state === "warn") {
    return "border-amber-500/40 bg-amber-500/5 text-text-primary";
  }
  return "border-error/40 bg-error/5 text-text-primary";
}

function runBadge(status: string, conclusion: string | null): string {
  const s = status.toLowerCase();
  const c = (conclusion ?? "").toLowerCase();
  if (s === "in_progress" || s === "queued") {
    return "Running";
  }
  if (c === "success") {
    return "Pass";
  }
  if (c === "failure" || c === "timed_out") {
    return "Fail";
  }
  return conclusion ?? status;
}

export function AdminPage() {
  const { user: me } = useAuth();
  const [monitoring, setMonitoring] = useState<AdminMonitoringResponse | null>(
    null,
  );
  const [ciStatus, setCiStatus] = useState<AdminCiStatusResponse | null>(null);
  const [codeChanges, setCodeChanges] =
    useState<AdminCodeChangesResponse | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [lookbackHours, setLookbackHours] = useState(24);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const monitoringView = monitoring
    ? buildMonitoringView(monitoring)
    : null;
  const ciView = ciStatus ? buildCiView(ciStatus) : null;
  const adminCount = users.filter((row) => row.isAdmin).length;

  const load = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      setError(null);
      if (!silent) {
        setLoading(true);
      }
      try {
        const [nextMonitoring, nextCi, nextCode, nextUsers] = await Promise.all([
          adminApi.monitoring(signal),
          adminApi.ciStatus(signal),
          adminApi.codeChanges(lookbackHours, signal),
          adminApi.users(signal),
        ]);
        setMonitoring(nextMonitoring);
        setCiStatus(nextCi);
        setCodeChanges(nextCode);
        setUsers(nextUsers.users);
        setCodeExpanded(false);
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === "ABORTED") {
          return;
        }
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Unable to load admin data.",
        );
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [lookbackHours],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      void load(undefined, true);
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  async function toggleAdmin(row: AdminUserRow): Promise<void> {
    setUsersError(null);
    setBusyUserId(row.id);
    try {
      const result = await adminApi.setAdmin(row.id, !row.isAdmin);
      setUsers((prev) =>
        prev.map((user) => (user.id === result.user.id ? result.user : user)),
      );
    } catch (caught) {
      setUsersError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to update admin flag.",
      );
    } finally {
      setBusyUserId(null);
    }
  }

  const visibleCommits = codeChanges
    ? codeExpanded
      ? codeChanges.commits
      : codeChanges.commits.slice(0, CODE_PREVIEW_COUNT)
    : [];
  const hiddenCommitCount = codeChanges
    ? Math.max(0, codeChanges.commits.length - CODE_PREVIEW_COUNT)
    : 0;

  return (
    <section data-testid="admin-page" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-primary">Admin</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Platform ops
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary sm:text-base">
            System health and CI first, then admin logins, then recent git
            commits.
          </p>
        </div>
        <Button
          type="button"
          className="w-auto"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      ) : null}

      <section
        data-testid="admin-monitoring"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <h2 className="text-lg font-semibold text-text-primary">
          System status
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Plain-language view of whether Workee can run — not raw log dump.
        </p>

        {monitoringView ? (
          <div className="mt-4 space-y-5 text-sm">
            <div
              data-testid="ops-failures-banner"
              className={`rounded-xl border px-4 py-3 ${
                monitoringView.level === "healthy"
                  ? "border-border bg-background"
                  : monitoringView.level === "critical"
                    ? "border-error/40 bg-error/5"
                    : "border-amber-500/40 bg-amber-500/5"
              }`}
              role={monitoringView.level === "healthy" ? undefined : "alert"}
            >
              <p
                data-testid="system-status-headline"
                className="text-base font-semibold text-text-primary"
              >
                {monitoringView.headline}
              </p>
              <p className="mt-1 text-text-secondary">{monitoringView.subline}</p>
              {monitoring && monitoring.failuresLastHour > 0 ? (
                <p className="mt-2 text-xs text-text-secondary">
                  {monitoring.failuresLastHour} recorded failure
                  {monitoring.failuresLastHour === 1 ? "" : "s"} in the last{" "}
                  {monitoring.statusLookbackMinutes ?? 60} min
                </p>
              ) : null}
            </div>

            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Status board
              </h3>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {monitoringView.checks.map((check) => (
                  <li
                    key={check.id}
                    data-testid={`status-check-${check.id}`}
                    className={`rounded-lg border px-3 py-2 ${checkTone(check.state)}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{check.label}</p>
                      <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        {check.badge}
                      </span>
                    </div>
                    <p className="mt-1 text-text-secondary">{check.meaning}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-base font-semibold text-text-primary">
                What went wrong (explained)
              </h3>
              {monitoringView.failures.length === 0 ? (
                <p className="mt-2 text-text-secondary">
                  Nothing recent to explain — no durable failures stored.
                </p>
              ) : (
                <ol className="mt-3 max-h-80 space-y-2 overflow-auto">
                  {monitoringView.failures.map((event) => (
                    <li
                      key={`fail-${event.at}-${event.step}-${event.detail}`}
                      className={`rounded-lg border px-3 py-2 ${
                        event.severity === "critical"
                          ? "border-error/40 bg-error/5"
                          : event.severity === "noise"
                            ? "border-border bg-background"
                            : "border-amber-500/30 bg-amber-500/5"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-text-primary">
                          {event.title}
                        </p>
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                          {event.severity}
                        </span>
                      </div>
                      <p className="mt-1 text-text-secondary">{event.meaning}</p>
                      <p className="mt-2 text-xs text-text-secondary">
                        {formatWhen(event.at)} · tech: {event.step}
                        {event.alertKey ? ` / ${event.alertKey}` : ""}
                      </p>
                      {event.detail ? (
                        <div
                          data-testid="ops-failure-cause"
                          className="mt-2 rounded-md border border-border bg-background px-2 py-1.5"
                        >
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                            Cause (log)
                          </p>
                          <p className="mt-1 break-all font-mono text-xs text-text-primary">
                            {event.detail.length > 220
                              ? `${event.detail.slice(0, 220)}…`
                              : event.detail}
                          </p>
                          {event.detail.length > 220 ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-text-secondary">
                                Full technical detail
                              </summary>
                              <p className="mt-1 break-all font-mono text-xs text-text-secondary">
                                {event.detail}
                              </p>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        ) : loading ? (
          <p className="mt-4 text-sm text-text-secondary">
            Loading monitoring…
          </p>
        ) : null}
      </section>

      <section
        data-testid="admin-ci"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <h2 className="text-lg font-semibold text-text-primary">CI tests</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Latest GitHub Actions Test workflow on main — shared / backend /
          frontend.
        </p>

        {ciView ? (
          <div className="mt-4 space-y-5 text-sm">
            <div
              data-testid="ci-status-banner"
              className={`rounded-xl border px-4 py-3 ${
                ciView.level === "healthy" || ciView.level === "idle"
                  ? "border-border bg-background"
                  : ciView.level === "critical"
                    ? "border-error/40 bg-error/5"
                    : "border-amber-500/40 bg-amber-500/5"
              }`}
              role={
                ciView.level === "healthy" || ciView.level === "idle"
                  ? undefined
                  : "alert"
              }
            >
              <p
                data-testid="ci-status-headline"
                className="text-base font-semibold text-text-primary"
              >
                {ciView.headline}
              </p>
              <p className="mt-1 text-text-secondary">{ciView.subline}</p>
              {ciStatus?.latest ? (
                <p className="mt-2 text-xs text-text-secondary">
                  Updated {formatWhen(ciStatus.latest.updatedAt)}
                  {ciStatus.repo ? ` · ${ciStatus.repo}` : ""}
                  {" · "}
                  <a
                    className="underline underline-offset-2"
                    href={ciStatus.latest.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open run
                  </a>
                </p>
              ) : null}
            </div>

            {ciView.checks.length > 0 ? (
              <div>
                <h3 className="text-base font-semibold text-text-primary">
                  Package board
                </h3>
                <ul className="mt-3 grid gap-2 sm:grid-cols-3">
                  {ciView.checks.map((check) => (
                    <li
                      key={check.id}
                      data-testid={`ci-check-${check.id}`}
                      className={`rounded-lg border px-3 py-2 ${checkTone(check.state)}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{check.label}</p>
                        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                          {check.badge}
                        </span>
                      </div>
                      <p className="mt-1 text-text-secondary">{check.meaning}</p>
                      {check.htmlUrl ? (
                        <a
                          className="mt-2 inline-block text-xs text-text-secondary underline underline-offset-2"
                          href={check.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Job log
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {ciStatus && ciStatus.recentRuns.length > 0 ? (
              <div>
                <h3 className="text-base font-semibold text-text-primary">
                  Recent runs
                </h3>
                <ol
                  data-testid="ci-recent-runs"
                  className="mt-3 max-h-64 space-y-2 overflow-auto"
                >
                  {ciStatus.recentRuns.map((run) => (
                    <li
                      key={run.id}
                      className="rounded-lg border border-border px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-text-primary">
                          {run.headSha.slice(0, 7)} · {run.event}
                        </p>
                        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                          {runBadge(run.status, run.conclusion)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        {formatWhen(run.updatedAt)}
                        {" · "}
                        <a
                          className="underline underline-offset-2"
                          href={run.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Actions
                        </a>
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : loading ? (
          <p className="mt-4 text-sm text-text-secondary">Loading CI status…</p>
        ) : null}
      </section>

      <section
        data-testid="admin-users"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <h2 className="text-lg font-semibold text-text-primary">Admins</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Grant or revoke the Admin tab for login users (
          <code className="text-xs">Users.is_admin</code>). Not the same as
          employee owner.
        </p>
        {usersError ? (
          <p className="mt-3 text-sm text-error" role="alert">
            {usersError}
          </p>
        ) : null}
        {users.length > 0 ? (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border text-sm">
            {users.map((row) => {
              const isSelf = row.id === me?.id;
              const revokeBlocked = row.isAdmin && adminCount <= 1;
              const busy = busyUserId === row.id;
              return (
                <li
                  key={row.id}
                  data-testid={`admin-user-${row.username}`}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <p className="font-medium text-text-primary">
                    {row.username}
                    {isSelf ? (
                      <span className="ml-2 text-xs font-normal text-text-secondary">
                        (you)
                      </span>
                    ) : null}
                  </p>
                  <label
                    className={`inline-flex items-center gap-2 text-xs ${
                      busy || revokeBlocked
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer text-text-secondary"
                    }`}
                    title={
                      revokeBlocked
                        ? "Cannot revoke the last admin"
                        : row.isAdmin
                          ? "Revoke Admin tab"
                          : "Grant Admin tab"
                    }
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 rounded border-border"
                      data-testid={`admin-toggle-${row.username}`}
                      checked={row.isAdmin}
                      disabled={busy || revokeBlocked}
                      onChange={() => void toggleAdmin(row)}
                    />
                    Admin
                  </label>
                </li>
              );
            })}
          </ul>
        ) : loading ? (
          <p className="mt-4 text-sm text-text-secondary">Loading users…</p>
        ) : (
          <p className="mt-4 text-sm text-text-secondary">No login users.</p>
        )}
      </section>

      <section
        data-testid="admin-code-changes"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Code changes
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Recent git commits in the selected window.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            Hours
            <select
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-text-primary"
              value={lookbackHours}
              onChange={(event) => {
                setLookbackHours(Number(event.target.value));
              }}
            >
              <option value={24}>24</option>
              <option value={48}>48</option>
              <option value={168}>168 (week)</option>
            </select>
          </label>
        </div>

        {codeChanges ? (
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-text-secondary">
              HEAD {codeChanges.headSha.slice(0, 10)} ·{" "}
              {codeChanges.commits.length} commit
              {codeChanges.commits.length === 1 ? "" : "s"} · last{" "}
              {codeChanges.lookbackHours}h
            </p>
            {codeChanges.commits.length === 0 ? (
              <p className="text-text-secondary">No commits in this window.</p>
            ) : (
              <>
                <ol
                  data-testid="admin-code-commit-list"
                  className="space-y-2"
                >
                  {visibleCommits.map((row) => (
                    <li
                      key={row.sha}
                      className="rounded-lg border border-border px-3 py-2"
                    >
                      <p className="font-medium text-text-primary">
                        {row.subject}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {row.sha.slice(0, 10)}
                      </p>
                      {row.files.length > 0 ? (
                        <p className="mt-1 break-all text-xs text-text-secondary">
                          {row.files.slice(0, 8).join(", ")}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {hiddenCommitCount > 0 ? (
                  <Button
                    type="button"
                    className="w-auto"
                    data-testid="admin-code-expand"
                    onClick={() => setCodeExpanded((open) => !open)}
                  >
                    {codeExpanded
                      ? "Show less"
                      : `Show all ${codeChanges.commits.length} commits`}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : loading ? (
          <p className="mt-4 text-sm text-text-secondary">Loading commits…</p>
        ) : null}
      </section>
    </section>
  );
}
