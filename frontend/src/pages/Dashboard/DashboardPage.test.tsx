import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { DashboardPage } from "./DashboardPage";
import { EmployeesPage } from "@/pages/Employees/EmployeesPage";
import { ChatPage } from "@/pages/Chat/ChatPage";
import { WhatsAppPage } from "@/pages/WhatsApp/WhatsAppPage";
import { LoginPage } from "@/pages/Login/LoginPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

const { loginMock, meMock, logoutMock, listEmployeesMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  meMock: vi.fn(),
  logoutMock: vi.fn(),
  listEmployeesMock: vi.fn(),
}));

vi.mock("@/services/auth.service", () => ({
  authApi: {
    login: loginMock,
    me: meMock,
    logout: logoutMock,
  },
}));

vi.mock("@/services/employee.service", async () => {
  const actual = await vi.importActual<typeof import("@/services/employee.service")>(
    "@/services/employee.service",
  );
  return {
    ...actual,
    employeeApi: {
      list: listEmployeesMock,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      records: vi.fn().mockResolvedValue({ employeeId: "", groups: [] }),
      updateRecord: vi.fn(),
      deleteRecord: vi.fn(),
    },
  };
});

function renderDashboard(extraRoutes = false) {
  return renderApp(
    <Routes>
      {extraRoutes ? <Route path="/login" element={<LoginPage />} /> : null}
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/whatsapp" element={<WhatsAppPage />} />
      </Route>
    </Routes>,
    { route: "/dashboard" },
  );
}

describe("Dashboard page", () => {
  beforeEach(() => {
    loginMock.mockReset();
    meMock.mockReset();
    logoutMock.mockReset().mockResolvedValue({ ok: true });
    listEmployeesMock.mockReset().mockResolvedValue({
      count: 2,
      employees: [
        {
          id: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
          name: "עמית",
          surname: "חתן",
          nickname: "עמית",
          email: "amit@example.com",
          phone: "050-0000001",
        },
        {
          id: "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
          name: "טל",
          surname: "דור",
          nickname: "טל",
          email: "tal@example.com",
          phone: "050-0000002",
        },
      ],
    });
    meMock.mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111", username: "Amit" },
    });
  });

  it("displays a greeting with the authenticated username", async () => {
    renderDashboard();

    expect(await screen.findByTestId("dashboard-greeting")).toHaveTextContent(
      "Hello, Amit",
    );
    expect(screen.getByText("Welcome back to your dashboard.")).toBeInTheDocument();
    expect(screen.queryByTestId("employee-count")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Employees" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "WhatsApp" })).toBeInTheDocument();
  });

  it("opens the employees screen from the Employees tab", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("link", { name: "Employees" }));

    expect(await screen.findByTestId("employees-page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Employees" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens the chat screen from the Chat tab", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("link", { name: "Chat" }));

    expect(await screen.findByTestId("chat-page")).toBeInTheDocument();
    expect(screen.getByLabelText("Chat As")).toBeInTheDocument();
  });

  it("logs the user out and returns to login", async () => {
    const user = userEvent.setup();
    renderDashboard(true);

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(logoutMock).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("login-page")).toBeInTheDocument();
  });
});
