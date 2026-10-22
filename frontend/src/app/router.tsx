import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LoginPage } from "@/pages/Login/LoginPage";
import { DashboardPage } from "@/pages/Dashboard/DashboardPage";
import { EmployeesPage } from "@/pages/Employees/EmployeesPage";
import { TipsPage } from "@/pages/Tips/TipsPage";
import { ChatPage } from "@/pages/Chat/ChatPage";
import { WhatsAppPage } from "@/pages/WhatsApp/WhatsAppPage";
import { StudioPage } from "@/pages/Studio/StudioPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/tips" element={<TipsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/whatsapp" element={<WhatsAppPage />} />
        <Route path="/studio" element={<StudioPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
