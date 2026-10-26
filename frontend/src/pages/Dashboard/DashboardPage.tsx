import { useEffect, useState } from "react";
import {
  humanEmployees,
  isGuestEmployee,
  workspaceHumans,
  type TeamUsageMonth,
  type TeamUsageSummary,
} from "@workee/shared";
import { useAuth } from "@/hooks/useAuth";
import { employeeApi, formatUsd } from "@/services/employee.service";
import { teamApi } from "@/services/team.service";

type DashboardCounts = {
  teams: number;
  employees: number;
  guests: number;
};

type UsageCard = {
  key: string;
  label: string;
  totalUsd: number;
  months: Array<{ month: string; usd: number }>;
  testId: string;
  monthsTestId: string;
  title?: string;
  /** Emphasize primary summary cards (Total / Team). */
  emphasize?: boolean;
};

function nonZeroMonths(
  months: TeamUsageMonth[],
  pick: (row: TeamUsageMonth) => number,
): Array<{ month: string; usd: number }> {
  return months
    .map((row) => ({ month: row.month, usd: pick(row) }))
    .filter((row) => row.usd !== 0);
}

function usageCards(usage: TeamUsageSummary): UsageCard[] {
  return [
    {
      key: "total",
      label: "Total usage",
      totalUsd: usage.totalUsd,
      months: nonZeroMonths(usage.months, (row) => row.totalUsd),
      testId: "dashboard-usage-total",
      monthsTestId: "dashboard-usage-total-months",
      title: "All LLM spend (once per call)",
      emphasize: true,
    },
    {
      key: "team",
      label: "Team usage",
      totalUsd: usage.humanEmployeesUsd,
      months: nonZeroMonths(usage.months, (row) => row.humanEmployeesUsd),
      testId: "dashboard-team-usage",
      monthsTestId: "dashboard-team-usage-months",
      title: "Human employees only",
      emphasize: true,
    },
    {
      key: "tips",
      label: "Tips",
      totalUsd: usage.purposes.catalogTipUsd,
      months: nonZeroMonths(usage.months, (row) => row.purposes.catalogTipUsd),
      testId: "dashboard-usage-tips",
      monthsTestId: "dashboard-usage-tips-months",
    },
    {
      key: "weather",
      label: "Weather tips",
      totalUsd: usage.purposes.weatherTipUsd,
      months: nonZeroMonths(usage.months, (row) => row.purposes.weatherTipUsd),
      testId: "dashboard-usage-weather",
      monthsTestId: "dashboard-usage-weather-months",
    },
    {
      key: "reminder",
      label: "Reminder compose",
      totalUsd: usage.purposes.reminderComposeUsd,
      months: nonZeroMonths(
        usage.months,
        (row) => row.purposes.reminderComposeUsd,
      ),
      testId: "dashboard-usage-reminder-compose",
      monthsTestId: "dashboard-usage-reminder-compose-months",
    },
    {
      key: "live",
      label: "Live select",
      totalUsd: usage.purposes.liveSelectUsd,
      months: nonZeroMonths(usage.months, (row) => row.purposes.liveSelectUsd),
      testId: "dashboard-usage-live-select",
      monthsTestId: "dashboard-usage-live-select-months",
    },
    {
      key: "guests",
      label: "Guests",
      totalUsd: usage.guestsUsd,
      months: nonZeroMonths(usage.months, (row) => row.guestsUsd),
      testId: "dashboard-usage-guests",
      monthsTestId: "dashboard-usage-guests-months",
    },
  ];
}

function UsageAmountCard({ card }: { card: UsageCard }) {
  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3">
      <p
        className={`text-sm text-text-secondary ${
          card.emphasize ? "font-bold" : "font-medium"
        }`}
      >
        {card.label}
      </p>
      <p
        data-testid={card.testId}
        className={`mt-1 text-xl tabular-nums text-text-primary ${
          card.emphasize ? "font-bold" : "font-semibold"
        }`}
        title={card.title}
      >
        {formatUsd(card.totalUsd)}
      </p>
      {card.months.length > 0 ? (
        <ul
          data-testid={card.monthsTestId}
          className="mt-2 space-y-0.5 text-sm text-text-secondary"
        >
          {card.months.map((row) => {
            const [year, month] = row.month.split("-");
            return (
              <li key={row.month}>
                <span className="font-medium">
                  {month}/{year}
                </span>{" "}
                {formatUsd(row.usd)}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<DashboardCounts | null>(null);
  const [teamUsage, setTeamUsage] = useState<TeamUsageSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();

    Promise.all([
      employeeApi.list(),
      teamApi.get(),
      employeeApi.teamUsage(abort.signal).catch(() => null),
    ])
      .then(([employeesResponse, teamResponse, usage]) => {
        if (cancelled) {
          return;
        }
        const employees = employeesResponse.employees;
        setCounts({
          teams: teamResponse.team ? 1 : 0,
          employees: workspaceHumans(employees).length,
          guests: humanEmployees(employees).filter((employee) =>
            isGuestEmployee(employee),
          ).length,
        });
        setTeamUsage(usage);
      })
      .catch(() => {
        if (!cancelled) {
          setCounts({ teams: 0, employees: 0, guests: 0 });
          setTeamUsage(null);
        }
      });

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, []);

  if (!user) {
    return null;
  }

  const cards = teamUsage ? usageCards(teamUsage) : [];

  return (
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

      <dl className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-background px-4 py-3">
          <dt className="text-sm text-text-secondary">Teams</dt>
          <dd
            data-testid="dashboard-teams-count"
            className="mt-1 text-2xl font-semibold tabular-nums text-text-primary"
          >
            {counts === null ? "…" : counts.teams}
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-background px-4 py-3">
          <dt className="text-sm text-text-secondary">Employees</dt>
          <dd
            data-testid="dashboard-employees-count"
            className="mt-1 text-2xl font-semibold tabular-nums text-text-primary"
          >
            {counts === null ? "…" : counts.employees}
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-background px-4 py-3">
          <dt className="text-sm text-text-secondary">Guests</dt>
          <dd
            data-testid="dashboard-guests-count"
            className="mt-1 text-2xl font-semibold tabular-nums text-text-primary"
          >
            {counts === null ? "…" : counts.guests}
          </dd>
        </div>
      </dl>

      {teamUsage ? (
        <div
          data-testid="dashboard-usage-breakdown"
          className="mt-6 grid gap-4 sm:grid-cols-2"
        >
          {cards.map((card) => (
            <UsageAmountCard key={card.key} card={card} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
