import { NavLink } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

const productTabs = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/employees", label: "Employees" },
  { to: "/chat", label: "Chat" },
  { to: "/whatsapp", label: "WhatsApp" },
] as const;

export function AppNav() {
  const { user } = useAuth();
  const tabs = user?.isAdmin
    ? [...productTabs, { to: "/admin", label: "Admin" } as const]
    : productTabs;

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
