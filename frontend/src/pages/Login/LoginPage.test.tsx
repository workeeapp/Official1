import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { LoginPage } from "./LoginPage";
import { DashboardPage } from "@/pages/Dashboard/DashboardPage";
import { EmployeesPage } from "@/pages/Employees/EmployeesPage";
import { ChatPage } from "@/pages/Chat/ChatPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ApiError } from "@/types";

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

function renderLoginFlow(route = "/login") {
  return renderApp(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/chat" element={<ChatPage />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe("Login page", () => {
  beforeEach(() => {
    loginMock.mockReset();
    meMock.mockReset();
    logoutMock.mockReset();
    listEmployeesMock.mockReset().mockResolvedValue({ count: 0, employees: [] });
    meMock.mockRejectedValue(new ApiError("UNAUTHORIZED", "Authentication required", 401));
  });

  it("renders the login form", async () => {
    renderLoginFlow();

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
  });

  it("shows validation errors for empty fields", async () => {
    const user = userEvent.setup();
    renderLoginFlow();

    await user.click(await screen.findByRole("button", { name: "Login" }));

    expect(await screen.findByText("Username is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("shows a validation error for an unsupported username", async () => {
    const user = userEvent.setup();
    renderLoginFlow();

    await user.type(await screen.findByLabelText("Username"), "bad user");
    await user.type(screen.getByLabelText("Password"), "ChangeMe123!");
    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(
      await screen.findByText(
        "Username can only contain letters, numbers, underscores, and hyphens",
      ),
    ).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("stays on the login page when credentials are invalid", async () => {
    const user = userEvent.setup();
    loginMock.mockRejectedValue(
      new ApiError("INVALID_CREDENTIALS", "Invalid username or password", 401),
    );
    renderLoginFlow();

    await user.type(await screen.findByLabelText("Username"), "Amit");
    await user.type(screen.getByLabelText("Password"), "WrongPass1");
    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByTestId("login-error")).toHaveTextContent(
      "Invalid username or password",
    );
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
  });

  it("redirects to the dashboard after a successful login", async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111", username: "Amit" },
    });
    renderLoginFlow();

    await user.type(await screen.findByLabelText("Username"), "Amit");
    await user.type(screen.getByLabelText("Password"), "ChangeMe123!");
    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByTestId("dashboard-greeting")).toHaveTextContent(
      "Hello, Amit",
    );
  });

  it("uses a responsive centered card layout", async () => {
    renderLoginFlow();

    const page = await screen.findByTestId("login-page");
    const card = screen.getByTestId("login-card");
    const frame = card.parentElement;

    expect(page.className).toContain("min-h-dvh");
    expect(page.className).toContain("px-4");
    expect(card.className).toContain("w-full");
    expect(frame?.className).toContain("max-w-md");
  });
});

describe("protected routing", () => {
  beforeEach(() => {
    loginMock.mockReset();
    meMock.mockReset();
    logoutMock.mockReset();
    listEmployeesMock.mockReset().mockResolvedValue({ count: 0, employees: [] });
  });

  it("redirects unauthenticated users from the dashboard to login", async () => {
    meMock.mockRejectedValue(new ApiError("UNAUTHORIZED", "Authentication required", 401));
    renderLoginFlow("/dashboard");

    expect(await screen.findByTestId("login-page")).toBeInTheDocument();
  });

  it("renders the dashboard for an authenticated user", async () => {
    meMock.mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111", username: "Amit" },
    });
    renderLoginFlow("/dashboard");

    expect(await screen.findByTestId("dashboard-greeting")).toHaveTextContent(
      "Hello, Amit",
    );
  });

  it("redirects authenticated users away from login", async () => {
    meMock.mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111", username: "Amit" },
    });
    renderLoginFlow("/login");

    await waitFor(() => {
      expect(screen.queryByTestId("login-page")).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId("dashboard-greeting")).toHaveTextContent(
      "Hello, Amit",
    );
  });
});
