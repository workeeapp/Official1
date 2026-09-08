import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/chat", label: "Chat" },
] as const;

export function AppNav() {
  return (
    <nav
      aria-label="Main"
      data-testid="app-nav"
      className="border-b border-border bg-surface"
    >
      <div className="mx-auto flex w-full max-w-5xl gap-1 px-4 sm:px-6 lg:px-8">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-semibold transition-colors ${
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-text-secondary hover:text-text-primary"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
