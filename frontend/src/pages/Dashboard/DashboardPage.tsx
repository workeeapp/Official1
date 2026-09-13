import { useAuth } from "@/hooks/useAuth";

export function DashboardPage() {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

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
    </section>
  );
}
