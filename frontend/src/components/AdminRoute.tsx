import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

/** Nested under ProtectedRoute — requires Users.isAdmin. */
export function AdminRoute() {
  const { user } = useAuth();
  const location = useLocation();

  if (!user?.isAdmin) {
    return <Navigate to="/dashboard" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
