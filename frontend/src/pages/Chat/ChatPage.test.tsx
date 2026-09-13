import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { ChatPage } from "./ChatPage";
import { DashboardPage } from "@/pages/Dashboard/DashboardPage";
import { EmployeesPage } from "@/pages/Employees/EmployeesPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ApiError } from "@/types";

const { meMock, listEmployeesMock, sendMock, historyMock, resetMock, subscribeMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  listEmployeesMock: vi.fn(),
  sendMock: vi.fn(),
  historyMock: vi.fn(),
  resetMock: vi.fn(),
  subscribeMock: vi.fn(() => () => {}),
}));

vi.mock("@/services/auth.service", () => ({
  authApi: {
    login: vi.fn(),
    me: meMock,
    logout: vi.fn(),
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

vi.mock("@/services/chat.service", () => ({
  chatApi: {
    send: sendMock,
    history: historyMock,
    reset: resetMock,
    subscribe: subscribeMock,
  },
}));

describe("Chat page", () => {
  beforeEach(() => {
    meMock.mockReset().mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111", username: "Amit" },
    });
    listEmployeesMock.mockReset().mockResolvedValue({
      count: 2,
      employees: [
        {
          id: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
          name: "עמית",
          surname: "חתן",
          nickname: "עמית",
          email: null,
          phone: null,
        },
        {
          id: "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
          name: "טל",
          surname: "דור",
          nickname: "טל",
          email: null,
          phone: null,
        },
      ],
    });
    sendMock.mockReset().mockResolvedValue({
      reply: "Hello from the assistant",
      raw: { output_text: "Hello from the assistant" },
    });
    historyMock.mockReset().mockImplementation(async (employeeId: string) => ({
      employeeId,
      conversationId: null,
      startedAt: null,
      messages: [],
      raw: null,
      isNew: true,
    }));
    resetMock.mockReset().mockImplementation(async (employeeId: string) => ({
      employeeId,
      conversationId: "conv_reset",
      startedAt: "2026-09-13T10:00:00.000Z",
      messages: [],
      raw: null,
      isNew: true,
    }));
    subscribeMock.mockReset().mockImplementation(() => () => {});
  });

  it("shows saved chat history when opening a conversation", async () => {
    historyMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      messages: [
        {
          id: "m1",
          author: "you",
          speaker: "עמית",
          text: "yesterday hello",
        },
        {
          id: "m2",
          author: "assistant",
          speaker: "Assistant",
          text: "saved reply",
        },
      ],
      raw: { output_text: "saved raw" },
    });

    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    expect(await screen.findByText("yesterday hello")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("chat-messages")).getByText("saved reply"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent(
      "saved raw",
    );
    expect(historyMock).toHaveBeenCalledWith(
      "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      expect.any(AbortSignal),
    );
  });

  it("sends the typed message to the API and shows the reply", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    expect(await screen.findByTestId("chat-page")).toBeInTheDocument();
    expect(screen.getByTestId("chat-messages").className).toMatch(/overflow-y-auto/);
    expect(await screen.findByTestId("new-conversation")).toHaveTextContent(
      "New conversation",
    );
    expect(screen.getByRole("button", { name: "Reset Conversation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Chat As")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "עמית" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "טל" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "לוסי" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    await user.type(screen.getByLabelText("Message"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(sendMock).toHaveBeenCalledWith(
      {
        message: "hi",
        employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      },
      expect.any(AbortSignal),
    );
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(
      await within(screen.getByTestId("chat-messages")).findByText(
        "Hello from the assistant",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent(
      "Hello from the assistant",
    );
  });

  it("shows only the JSON response in the dialog and an action when present", async () => {
    sendMock.mockResolvedValue({
      reply: JSON.stringify({
        response: "Milk was added to the shopping list.",
        metadata: {
          lists: [
            {
              action: "add",
              list_type: "shopping",
              items: [{ name: "milk" }],
            },
          ],
          filing: [],
        },
      }),
      raw: { output_text: "full payload" },
    });
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "add milk");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const dialog = screen.getByTestId("chat-messages");
    expect(
      await within(dialog).findByText("Milk was added to the shopping list."),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId("chat-action")).toHaveTextContent(
      "Add to shopping list: milk",
    );
    expect(within(dialog).queryByText(/metadata/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/list_type/)).not.toBeInTheDocument();
  });

  it("sends the message when Enter is pressed", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "hi{Enter}");

    expect(sendMock).toHaveBeenCalledWith(
      {
        message: "hi",
        employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      },
      expect.any(AbortSignal),
    );
  });

  it("keeps a separate thread for each Chat As employee", async () => {
    sendMock
      .mockResolvedValueOnce({
        reply: "Reply for Amit",
        raw: { output_text: "Reply for Amit" },
      })
      .mockResolvedValueOnce({
        reply: "Reply for Tal",
        raw: { output_text: "Reply for Tal" },
      });
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "list for amit");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await within(screen.getByTestId("chat-messages")).findByText("Reply for Amit"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent(
      "Reply for Amit",
    );

    await user.selectOptions(
      screen.getByLabelText("Chat As"),
      "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
    );
    expect(screen.queryByText("list for amit")).not.toBeInTheDocument();
    expect(screen.queryByText("Reply for Amit")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "list for tal");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(sendMock).toHaveBeenLastCalledWith(
      {
        message: "list for tal",
        employeeId: "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
      },
      expect.any(AbortSignal),
    );
    expect(
      await within(screen.getByTestId("chat-messages")).findByText("Reply for Tal"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent(
      "Reply for Tal",
    );

    await user.selectOptions(
      screen.getByLabelText("Chat As"),
      "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
    );
    expect(screen.getByText("list for amit")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("chat-messages")).getByText("Reply for Amit"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent(
      "Reply for Amit",
    );
    expect(screen.queryByText("list for tal")).not.toBeInTheDocument();
  });

  it("shows an error when the chat API fails", async () => {
    sendMock.mockRejectedValue(
      new ApiError("SERVICE_UNAVAILABLE", "Something went wrong. Please try again.", 503),
    );
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Please try again.",
    );
  });

  it("turns Send red into Stop and cancels the request", async () => {
    sendMock.mockImplementation(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          const fail = () =>
            reject(new ApiError("ABORTED", "Request cancelled", 0));
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail);
        }),
    );
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(stop.className).toMatch(/bg-error/);
    expect(screen.getByTestId("chat-pending")).toBeInTheDocument();

    await user.click(stop);

    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Hello from the assistant")).not.toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("keeps each employee conversation after changing tabs", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "keep this thread");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await within(screen.getByTestId("chat-messages")).findByText(
        "Hello from the assistant",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(await screen.findByTestId("dashboard-page")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Chat" }));
    expect(await screen.findByTestId("chat-page")).toBeInTheDocument();
    expect(screen.getByText("keep this thread")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("chat-messages")).getByText(
        "Hello from the assistant",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent(
      "Hello from the assistant",
    );
  });

  it("shows a pushed assistant notification when switching to the target employee", async () => {
    sendMock.mockResolvedValue({
      reply: "רשמתי לטל לקנות חלב",
      raw: { output_text: "assigned" },
      notifications: [
        {
          employeeId: "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
          message: {
            id: "n1",
            author: "assistant",
            speaker: "Assistant",
            text: "עמית הוסיף חלב לרשימת הקניות שלך",
            actions: ["Add to shopping list: חלב"],
          },
        },
      ],
    });
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    await user.type(await screen.findByLabelText("Message"), "טל צריך לקנות חלב");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await within(screen.getByTestId("chat-messages")).findByText(
        "רשמתי לטל לקנות חלב",
      ),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Chat As"),
      "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
    );
    expect(
      await within(screen.getByTestId("chat-messages")).findByText(
        "עמית הוסיף חלב לרשימת הקניות שלך",
      ),
    ).toBeInTheDocument();
  });

  it("refetches the other employee's thread so saved notifications appear", async () => {
    historyMock.mockImplementation(async (employeeId: string) => ({
      employeeId,
      messages:
        employeeId === "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4"
          ? [
              {
                id: "n1",
                author: "assistant" as const,
                speaker: "Assistant",
                text: "טל קנה קופסת טונה",
              },
            ]
          : [],
      raw: null,
    }));
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    expect(await screen.findByRole("option", { name: "טל" })).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Chat As"),
      "4cded1a2-c4c1-4edc-9d87-fe5ac740c1f4",
    );
    expect(
      await within(screen.getByTestId("chat-messages")).findByText(
        "טל קנה קופסת טונה",
      ),
    ).toBeInTheDocument();
  });

  it("shows a live notification pushed from another session", async () => {
    let onEvent:
      | ((event: {
          employeeId: string;
          message: {
            id: string;
            author: "assistant";
            speaker: string;
            text: string;
          };
        }) => void)
      | undefined;
    subscribeMock.mockImplementation((_employeeId: string, listener) => {
      onEvent = listener;
      return () => {};
    });
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    expect(await screen.findByRole("option", { name: "עמית" })).toBeInTheDocument();
    await waitFor(() => expect(onEvent).toBeTypeOf("function"));
    onEvent?.({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      message: {
        id: "live-1",
        author: "assistant",
        speaker: "Assistant",
        text: "טל קנה חלב",
      },
    });
    expect(
      await within(screen.getByTestId("chat-messages")).findByText("טל קנה חלב"),
    ).toBeInTheDocument();
  });

  it("resets the dialog to a new conversation", async () => {
    historyMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      conversationId: "conv_old",
      startedAt: "2026-09-13T08:00:00.000Z",
      messages: [
        {
          id: "m1",
          author: "you",
          speaker: "עמית",
          text: "old hello",
        },
        {
          id: "m2",
          author: "assistant",
          speaker: "Assistant",
          text: "old reply",
        },
      ],
      raw: { output_text: "old raw" },
      isNew: false,
    });
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    expect(await screen.findByText("old hello")).toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).toHaveTextContent("old raw");

    historyMock.mockImplementation(async (employeeId: string) => ({
      employeeId,
      conversationId: "conv_reset",
      startedAt: "2026-09-13T10:00:00.000Z",
      messages: [],
      raw: null,
      isNew: true,
    }));
    await user.click(screen.getByRole("button", { name: "Reset Conversation" }));

    expect(resetMock).toHaveBeenCalledWith("415ff13e-38d0-4dee-98b5-71e5dd11a38d");
    expect(await screen.findByTestId("new-conversation")).toHaveTextContent(
      "New conversation",
    );
    expect(screen.queryByText("old hello")).not.toBeInTheDocument();
    expect(screen.queryByText("old reply")).not.toBeInTheDocument();
    expect(screen.getByTestId("llm-complete-response")).not.toHaveTextContent(
      "old raw",
    );
  });

  it("shows a new conversation when the server expires an idle thread", async () => {
    historyMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      conversationId: "conv_old",
      startedAt: "2026-09-13T08:00:00.000Z",
      messages: [
        {
          id: "m1",
          author: "you",
          speaker: "עמית",
          text: "stale hello",
        },
      ],
      raw: { output_text: "stale raw" },
      isNew: false,
    });
    renderApp(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Routes>,
      { route: "/chat" },
    );

    expect(await screen.findByText("stale hello")).toBeInTheDocument();

    historyMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      conversationId: "conv_idle",
      startedAt: "2026-09-13T10:00:00.000Z",
      messages: [],
      raw: null,
      isNew: true,
    });

    expect(await screen.findByTestId("new-conversation", {}, { timeout: 3000 })).toHaveTextContent(
      "New conversation",
    );
    expect(screen.queryByText("stale hello")).not.toBeInTheDocument();
  });
});
