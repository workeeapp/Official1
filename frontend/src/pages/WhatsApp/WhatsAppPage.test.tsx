import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { WhatsAppPage } from "./WhatsAppPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

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
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/whatsapp" element={<WhatsAppPage />} />
        </Route>
      </Routes>,
      { route: "/whatsapp" },
    );

    expect(await screen.findByTestId("whatsapp-page")).toBeInTheDocument();
    expect(
      await screen.findByText(/Meta still points the WABA or phone webhook/i),
    ).toBeInTheDocument();
    expect(screen.getByText("webhook_post")).toBeInTheDocument();
    expect(screen.getByText("fields=messages inbound=0")).toBeInTheDocument();
  });
});
