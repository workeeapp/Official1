import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { WhatsAppPage } from "./WhatsAppPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ApiError } from "@/types";

const { meMock, statusMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  statusMock: vi.fn(),
}));

vi.mock("@/services/auth.service", () => ({
  authApi: {
    login: vi.fn(),
    me: meMock,
    logout: vi.fn(),
  },
}));

vi.mock("@/services/whatsapp.service", () => ({
  whatsappApi: {
    status: statusMock,
  },
}));

function renderWhatsApp() {
  return renderApp(
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route path="/whatsapp" element={<WhatsAppPage />} />
      </Route>
    </Routes>,
    { route: "/whatsapp" },
  );
}

describe("WhatsApp page", () => {
  beforeEach(() => {
    meMock.mockReset().mockResolvedValue({
      user: { id: "u1", username: "tal" },
    });
    statusMock.mockReset().mockResolvedValue({
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
    });
  });

  it("shows the Meta override mismatch and flow events", async () => {
    renderWhatsApp();

    expect(await screen.findByTestId("whatsapp-page")).toBeInTheDocument();
    expect(
      await screen.findByText(/Meta still points the WABA or phone webhook/i),
    ).toBeInTheDocument();
    expect(screen.getByText("webhook_post")).toBeInTheDocument();
    expect(screen.getByText("fields=messages inbound=0")).toBeInTheDocument();
  });

  it("shows aligned webhooks without a mismatch alert", async () => {
    statusMock.mockResolvedValue({
      expectedWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      metaWabaWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      metaAppWebhook: "https://wa.workee.site/api/whatsapp/webhook",
      webhookMismatch: false,
      hasAccessToken: true,
      lastInboundAt: "2026-09-24T07:00:00.000Z",
      events: [],
    });
    renderWhatsApp();

    expect(await screen.findByText("configured")).toBeInTheDocument();
    expect(
      screen.getByText("No webhook events since this API process started."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("https://wa.workee.site/api/whatsapp/webhook").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.queryByText(/Meta still points the WABA or phone webhook/i),
    ).not.toBeInTheDocument();
  });

  it("shows an error when status fails to load", async () => {
    statusMock.mockRejectedValue(
      new ApiError("SERVICE_UNAVAILABLE", "Unable to load WhatsApp status.", 503),
    );
    renderWhatsApp();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to load WhatsApp status.",
    );
  });

  it("reloads status when Refresh is clicked", async () => {
    const user = userEvent.setup();
    renderWhatsApp();
    await screen.findByText("webhook_post");
    expect(statusMock).toHaveBeenCalled();
    const callsBefore = statusMock.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await vi.waitFor(() => {
      expect(statusMock.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});