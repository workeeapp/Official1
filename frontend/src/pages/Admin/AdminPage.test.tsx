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
  ciStatusMock,
  codeChangesMock,
  usersMock,
  setAdminMock,
  whatsappStatusMock,
} = vi.hoisted(() => ({
  meMock: vi.fn(),
  monitoringMock: vi.fn(),
  ciStatusMock: vi.fn(),
  codeChangesMock: vi.fn(),
  usersMock: vi.fn(),
  setAdminMock: vi.fn(),
  whatsappStatusMock: vi.fn(),
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
    ciStatus: ciStatusMock,
    codeChanges: codeChangesMock,
    users: usersMock,
    setAdmin: setAdminMock,
  },
}));

vi.mock("@/services/whatsapp.service", () => ({
  whatsappApi: {
    status: whatsappStatusMock,
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
      statusLookbackMinutes: 60,
      recentFailures: [
        {
          at: "2026-10-04T06:00:00.000Z",
          step: "chat_failed",
          detail: "status=429 code=insufficient_quota no credits remaining",
          alertKey: "llm_credits",
        },
      ],
    });
    ciStatusMock.mockReset().mockResolvedValue({
      configured: true,
      branch: "main",
      workflow: "Test",
      repo: "workeeapp/Official1",
      latest: {
        id: 100,
        status: "completed",
        conclusion: "success",
        event: "push",
        headSha: "abc123def456",
        htmlUrl: "https://github.com/workeeapp/Official1/actions/runs/100",
        startedAt: "2026-10-04T07:22:00.000Z",
        updatedAt: "2026-10-04T07:22:44.000Z",
      },
      jobs: [
        {
          name: "shared",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/shared",
        },
        {
          name: "backend",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/backend",
        },
        {
          name: "frontend",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://example.com/frontend",
        },
      ],
      recentRuns: [
        {
          id: 100,
          status: "completed",
          conclusion: "success",
          event: "push",
          headSha: "abc123def456",
          htmlUrl: "https://github.com/workeeapp/Official1/actions/runs/100",
          startedAt: "2026-10-04T07:22:00.000Z",
          updatedAt: "2026-10-04T07:22:44.000Z",
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
    whatsappStatusMock.mockReset().mockResolvedValue({
      expectedWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      metaWabaWebhook: "https://dead.trycloudflare.com/api/whatsapp/webhook",
      metaAppWebhook: "https://dead.trycloudflare.com/api/whatsapp/webhook",
      webhookMismatch: true,
      hasAccessToken: true,
      lastInboundAt: null,
      events: [
        {
          at: "2026-09-24T06:00:00.000Z",
          step: "webhook_post",
          detail: "fields=messages inbound=0",
        },
      ],
      recentFailures: [],
      failuresLastHour: 0,
      opsAlertConfigured: false,
    });
  });

  it("shows monitoring above WhatsApp channel above CI", async () => {
    renderAdmin();

    expect(await screen.findByTestId("admin-page")).toBeInTheDocument();
    const monitoring = await screen.findByTestId("admin-monitoring");
    const whatsapp = await screen.findByTestId("admin-whatsapp-channel");
    const ci = await screen.findByTestId("admin-ci");
    const admins = await screen.findByTestId("admin-users");
    const code = screen.getByTestId("admin-code-changes");
    expect(
      monitoring.compareDocumentPosition(whatsapp) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      whatsapp.compareDocumentPosition(ci) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      ci.compareDocumentPosition(admins) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      admins.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      await screen.findByText(/Meta still points the WABA or phone webhook/i),
    ).toBeInTheDocument();
    expect(screen.getByText("webhook_post")).toBeInTheDocument();
    expect(screen.getByTestId("ci-status-headline")).toHaveTextContent(
      /healthy/i,
    );
    expect(screen.getByTestId("ci-check-backend")).toHaveTextContent(/Pass/i);
    expect(screen.getByTestId("admin-user-Amit")).toBeInTheDocument();
    expect(screen.getByTestId("admin-user-Tal")).toBeInTheDocument();
    expect(screen.getByTestId("admin-toggle-Amit")).toBeDisabled();
    expect(screen.getByTestId("admin-toggle-Tal")).not.toBeChecked();
  });

  it("shows aligned WhatsApp webhooks without a mismatch alert", async () => {
    whatsappStatusMock.mockResolvedValue({
      expectedWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      metaWabaWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      metaAppWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      webhookMismatch: false,
      hasAccessToken: true,
      lastInboundAt: "2026-09-24T07:00:00.000Z",
      events: [],
    });
    renderAdmin();

    expect(await screen.findByText("configured")).toBeInTheDocument();
    expect(
      screen.getByText("No webhook events since this API process started."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Meta still points the WABA or phone webhook/i),
    ).not.toBeInTheDocument();
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
