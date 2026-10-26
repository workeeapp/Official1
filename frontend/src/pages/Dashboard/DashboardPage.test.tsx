import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { DashboardPage } from "./DashboardPage";
import { EmployeesPage } from "@/pages/Employees/EmployeesPage";
import { ChatPage } from "@/pages/Chat/ChatPage";
import { WhatsAppPage } from "@/pages/WhatsApp/WhatsAppPage";
import { LoginPage } from "@/pages/Login/LoginPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

const {
  loginMock,
  meMock,
  logoutMock,
  listEmployeesMock,
  getTeamMock,
  teamUsageMock,
} = vi.hoisted(() => ({
  loginMock: vi.fn(),
  meMock: vi.fn(),
  logoutMock: vi.fn(),
  listEmployeesMock: vi.fn(),
  getTeamMock: vi.fn(),
  teamUsageMock: vi.fn(),
}));

vi.mock("@/services/auth.service", () => ({
  authApi: {
    login: loginMock,
    me: meMock,
    logout: logoutMock,
  },
}));

vi.mock("@/services/team.service", () => ({
  teamApi: {
    get: getTeamMock,
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
      teamUsage: teamUsageMock,
      digitalDefaults: vi.fn().mockResolvedValue({}),
      configFileDefaults: vi.fn().mockResolvedValue({}),
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
    getTeamMock.mockReset().mockResolvedValue({
      team: {
        id: "22222222-2222-4222-8222-222222222222",
        userId: "11111111-1111-4111-8111-111111111111",
        name: "Amit",
      },
    });
    teamUsageMock.mockReset().mockResolvedValue({
      totalUsd: 0.0112,
      allEmployeesUsd: 0.0196,
      humanEmployeesUsd: 0.0098,
      guestsUsd: 0.0012,
      purposes: {
        chatUsd: 0.007,
        catalogTipUsd: 0.0015,
        weatherTipUsd: 0.0008,
        reminderComposeUsd: 0.0004,
        liveSelectUsd: 0.0003,
      },
      months: [
        {
          month: "2026-10",
          totalUsd: 0.007,
          allEmployeesUsd: 0.012,
          humanEmployeesUsd: 0.005,
          guestsUsd: 0.001,
          purposes: {
            chatUsd: 0.004,
            catalogTipUsd: 0.001,
            weatherTipUsd: 0.0005,
            reminderComposeUsd: 0.0003,
            liveSelectUsd: 0.0002,
          },
        },
        {
          month: "2026-09",
          totalUsd: 0.0042,
          allEmployeesUsd: 0.0076,
          humanEmployeesUsd: 0.0048,
          guestsUsd: 0.0002,
          purposes: {
            chatUsd: 0.003,
            catalogTipUsd: 0.0005,
            weatherTipUsd: 0.0003,
            reminderComposeUsd: 0.0001,
            liveSelectUsd: 0.0001,
          },
        },
      ],
    });
    listEmployeesMock.mockReset().mockResolvedValue({
      count: 4,
      employees: [
        {
          id: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
          kind: "human",
          name: "עמית",
          surname: "חתן",
          nickname: "עמית",
          email: "amit@example.com",
          phone: "050-0000001",
          isGuest: false,
          teamId: "22222222-2222-4222-8222-222222222222",
        },
        {
          id: "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
          kind: "human",
          name: "טל",
          surname: "דור",
          nickname: "טל",
          email: "tal@example.com",
          phone: "050-0000002",
          isGuest: false,
          teamId: "22222222-2222-4222-8222-222222222222",
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          kind: "human",
          name: "אורח",
          surname: "",
          nickname: "אורח …1495",
          email: null,
          phone: "972501234567",
          isGuest: true,
          teamId: null,
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "digital",
          name: "לוסי",
          surname: "",
          nickname: "לוסי",
          email: null,
          phone: null,
          isGuest: false,
          teamId: "22222222-2222-4222-8222-222222222222",
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
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Employees" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "WhatsApp" })).toBeInTheDocument();
  });

  it("shows teams, person employees, and guest counts", async () => {
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-teams-count")).toHaveTextContent("1");
    });
    expect(screen.getByTestId("dashboard-employees-count")).toHaveTextContent("2");
    expect(screen.getByTestId("dashboard-guests-count")).toHaveTextContent("1");
  });

  it("shows total usage first, then human-only team usage", async () => {
    renderDashboard();

    const total = await screen.findByTestId("dashboard-usage-total");
    expect(total).toHaveTextContent("$0.0112");
    const totalMonths = screen.getByTestId("dashboard-usage-total-months");
    expect(totalMonths).toHaveTextContent("10/2026");
    expect(totalMonths).toHaveTextContent("$0.007");
    expect(totalMonths).toHaveTextContent("09/2026");
    expect(totalMonths).toHaveTextContent("$0.0042");

    const breakdown = screen.getByTestId("dashboard-usage-breakdown");
    const cards = breakdown.querySelectorAll("[data-testid]");
    expect(cards[0]).toHaveAttribute("data-testid", "dashboard-usage-total");

    expect(screen.getByTestId("dashboard-team-usage")).toHaveTextContent("$0.0098");
    expect(screen.getByTestId("dashboard-team-usage")).not.toHaveTextContent(
      "$0.0196",
    );
    const months = screen.getByTestId("dashboard-team-usage-months");
    expect(months).toHaveTextContent("10/2026");
    expect(months).toHaveTextContent("$0.005");
    expect(months).not.toHaveTextContent("$0.012");
  });

  it("shows purpose and guest usage cards with monthly breakdowns", async () => {
    renderDashboard();

    expect(await screen.findByTestId("dashboard-usage-breakdown")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-usage-chat")).not.toBeInTheDocument();
    expect(screen.getByTestId("dashboard-usage-tips")).toHaveTextContent("$0.0015");
    expect(screen.getByTestId("dashboard-usage-weather")).toHaveTextContent("$0.0008");
    expect(screen.getByTestId("dashboard-usage-reminder-compose")).toHaveTextContent(
      "$0.0004",
    );
    expect(screen.getByTestId("dashboard-usage-live-select")).toHaveTextContent(
      "$0.0003",
    );
    expect(screen.getByTestId("dashboard-usage-guests")).toHaveTextContent("$0.0012");

    const tipsMonths = screen.getByTestId("dashboard-usage-tips-months");
    expect(tipsMonths).toHaveTextContent("10/2026");
    expect(tipsMonths).toHaveTextContent("$0.001");
    expect(tipsMonths).toHaveTextContent("09/2026");
    expect(tipsMonths).toHaveTextContent("$0.0005");

    const guestMonths = screen.getByTestId("dashboard-usage-guests-months");
    expect(guestMonths).toHaveTextContent("10/2026");
    expect(guestMonths).toHaveTextContent("$0.001");
    expect(guestMonths).toHaveTextContent("09/2026");
    expect(guestMonths).toHaveTextContent("$0.0002");
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
