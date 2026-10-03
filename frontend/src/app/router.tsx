import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LoginPage } from "@/pages/Login/LoginPage";
import { DashboardPage } from "@/pages/Dashboard/DashboardPage";
import { EmployeesPage } from "@/pages/Employees/EmployeesPage";
import { ChatPage } from "@/pages/Chat/ChatPage";
import { WhatsAppPage } from "@/pages/WhatsApp/WhatsAppPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/whatsapp" element={<WhatsAppPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
