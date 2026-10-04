import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { AdminPage } from "./AdminPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AdminRoute } from "@/components/AdminRoute";

const {
  meMock,
  monitoringMock,
  codeChangesMock,
  usersMock,
  setAdminMock,
} = vi.hoisted(() => ({
  meMock: vi.fn(),
  monitoringMock: vi.fn(),
  codeChangesMock: vi.fn(),
  usersMock: vi.fn(),
  setAdminMock: vi.fn(),
}));

vi.mock("@/services/auth.service", () => ({
  authApi: {
    login: vi.fn(),
    me: meMock,
    logout: vi.fn(),
  },
}));

vi.mock("@/services/admin.service", () => ({
  adminApi: {
    monitoring: monitoringMock,
    codeChanges: codeChangesMock,
    users: usersMock,
    setAdmin: setAdminMock,
  },
}));

function renderAdmin(route = "/admin") {
  return renderApp(
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<p data-testid="dashboard-stub">Dash</p>} />
        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<AdminPage />} />
        </Route>
      </Route>
    </Routes>,
    { route },
  );
}

function sixCommits() {
  return Array.from({ length: 6 }, (_, index) => ({
    sha: `abc123def45${index}`,
    subject: `Commit subject ${index + 1}`,
    body: "",
    files: [`file-${index + 1}.ts`],
  }));
}

describe("Admin page", () => {
  beforeEach(() => {
    meMock.mockReset().mockResolvedValue({
      user: { id: "u1", username: "Amit", isAdmin: true },
    });
    monitoringMock.mockReset().mockResolvedValue({
      health: {
        status: "ok",
        db: true,
        openaiConfigured: true,
        whatsappConfigured: true,
        opsAlertConfigured: true,
        opsAlertMode: "off",
      },
      failuresLastHour: 2,
      recentFailures: [
        {
          at: "2026-10-04T06:00:00.000Z",
          step: "chat_failed",
          detail: "status=429 code=insufficient_quota no credits remaining",
          alertKey: "llm_credits",
        },
      ],
    });
    codeChangesMock.mockReset().mockResolvedValue({
      headSha: "abc123def456",
      lookbackHours: 24,
      commits: [
        {
          sha: "abc123def456",
          subject: "Teach Lucy send-me digests",
          body: "",
          files: ["LLM.config.json"],
        },
      ],
      summaryText: "1. Teach Lucy send-me digests",
    });
    usersMock.mockReset().mockResolvedValue({
      users: [
        { id: "u1", username: "Amit", isAdmin: true },
        { id: "u2", username: "Tal", isAdmin: false },
      ],
    });
    setAdminMock.mockReset();
  });

  it("shows monitoring above admins above code changes", async () => {
    renderAdmin();

    expect(await screen.findByTestId("admin-page")).toBeInTheDocument();
    const monitoring = await screen.findByTestId("admin-monitoring");
    const admins = await screen.findByTestId("admin-users");
    const code = screen.getByTestId("admin-code-changes");
    expect(
      monitoring.compareDocumentPosition(admins) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      admins.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("admin-user-Amit")).toBeInTheDocument();
    expect(screen.getByTestId("admin-user-Tal")).toBeInTheDocument();
    expect(screen.getByTestId("admin-toggle-Amit")).toBeDisabled();
    expect(screen.getByTestId("admin-toggle-Tal")).not.toBeChecked();
  });

  it("grants admin to another login user", async () => {
    const user = userEvent.setup();
    setAdminMock.mockResolvedValue({
      user: { id: "u2", username: "Tal", isAdmin: true },
    });
    renderAdmin();
    await screen.findByTestId("admin-user-Tal");
    await user.click(screen.getByTestId("admin-toggle-Tal"));
    expect(setAdminMock).toHaveBeenCalledWith("u2", true);
    expect(await screen.findByTestId("admin-toggle-Tal")).toBeChecked();
  });

  it("shows Cause (log) with the real failure detail", async () => {
    renderAdmin();
    expect(await screen.findByTestId("ops-failure-cause")).toHaveTextContent(
      /insufficient_quota/i,
    );
    expect(screen.getByTestId("ops-failure-cause")).toHaveTextContent(
      /Cause \(log\)/i,
    );
  });

  it("previews five commits and expands to show all", async () => {
    const user = userEvent.setup();
    codeChangesMock.mockResolvedValue({
      headSha: "abc123def456",
      lookbackHours: 24,
      commits: sixCommits(),
      summaryText: "six commits",
    });
    renderAdmin();

    expect(await screen.findByText("Commit subject 1")).toBeInTheDocument();
    expect(screen.getByText("Commit subject 5")).toBeInTheDocument();
    expect(screen.queryByText("Commit subject 6")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("admin-code-expand"));
    expect(await screen.findByText("Commit subject 6")).toBeInTheDocument();
    expect(screen.getByTestId("admin-code-expand")).toHaveTextContent(
      /Show less/i,
    );
  });

  it("redirects non-admins away from /admin", async () => {
    meMock.mockResolvedValue({
      user: { id: "u2", username: "Tal", isAdmin: false },
    });
    renderAdmin();
    expect(await screen.findByTestId("dashboard-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-page")).not.toBeInTheDocument();
  });
});
