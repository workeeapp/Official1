import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ChatProvider } from "@/hooks/useChat";
import { AppShell } from "./AppShell";
import { Logo } from "./Logo";

export function ProtectedRoute() {
  const { user, status, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Logo />
          <p className="text-sm text-text-secondary">Loading your workspace…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <ChatProvider>
      <AppShell user={user} onLogout={handleLogout}>
        <Outlet />
      </AppShell>
    </ChatProvider>
  );
}
