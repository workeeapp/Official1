import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderApp } from "@/test/render";
import { EmployeesPage } from "./EmployeesPage";
import { DashboardPage } from "@/pages/Dashboard/DashboardPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

const {
  meMock,
  listEmployeesMock,
  recordsMock,
  updateRecordMock,
  deleteRecordMock,
  digitalDefaultsMock,
  usageMock,
  teamUsageMock,
} = vi.hoisted(() => ({
  usageMock: vi.fn(),
  teamUsageMock: vi.fn(),
  meMock: vi.fn(),
  listEmployeesMock: vi.fn(),
  recordsMock: vi.fn(),
  updateRecordMock: vi.fn(),
  deleteRecordMock: vi.fn(),
  digitalDefaultsMock: vi.fn(),
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
      digitalDefaults: digitalDefaultsMock,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      records: recordsMock,
      usage: usageMock,
      teamUsage: teamUsageMock,
      updateRecord: updateRecordMock,
      deleteRecord: deleteRecordMock,
    },
  };
});

function renderEmployees() {
  return renderApp(
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
      </Route>
    </Routes>,
    { route: "/employees" },
  );
}

describe("Employees page", () => {
  beforeEach(() => {
    listEmployeesMock.mockReset().mockResolvedValue({
      count: 3,
      employees: [
        {
          id: "7aaae1a2-c4c1-4edc-9d87-fe5ac740c1f4",
          kind: "digital" as const,
          protected: true,
          name: "לוסי",
          surname: "",
          nickname: "לוסי",
          email: null,
          phone: null,
          model: "gpt-4.1-mini",
          temperature: 0,
          instructions: "You manage lists and filings.",
        },
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
    meMock.mockReset().mockResolvedValue({
      user: { id: "11111111-1111-4111-8111-111111111111", username: "Amit" },
    });
    recordsMock.mockReset().mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      groups: [],
    });
    usageMock.mockReset().mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      conversations: 3,
      interactions: 17,
      totalUsd: 0.0021528,
    });
    teamUsageMock.mockReset().mockResolvedValue({
      allEmployeesUsd: 0.0196,
      humanEmployeesUsd: 0.0098,
    });
    updateRecordMock.mockReset();
    deleteRecordMock.mockReset();
    digitalDefaultsMock.mockReset().mockResolvedValue({
      model: "gpt-4.1-mini",
      temperature: 0,
      instructions: "You manage lists and filings.",
    });
  });

  it("lists employees and keeps default actions disabled until a row is selected", async () => {
    renderEmployees();

    expect(await screen.findByTestId("employees-page")).toBeInTheDocument();
    expect(await screen.findByText("3 employees")).toBeInTheDocument();
    expect(screen.getByTitle("לוסי · gpt-4.1-mini")).toHaveTextContent("לוסי");
    expect(
      within(screen.getByTitle("לוסי · gpt-4.1-mini")).getByTestId("workee-mark"),
    ).toBeInTheDocument();
    expect(screen.getByTitle("עמית חתן · amit@example.com · 050-0000001")).toHaveTextContent(
      "עמית",
    );
    expect(
      within(screen.getByTitle("עמית חתן · amit@example.com · 050-0000001")).queryByTestId(
        "workee-mark",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("טל דור · tal@example.com · 050-0000002")).toHaveTextContent(
      "טל",
    );
    expect(screen.getByRole("button", { name: "Add employee" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Update employee" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete employee" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Employees" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument();
  });

  it("enables update and delete after selecting an employee", async () => {
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByTitle("עמית חתן · amit@example.com · 050-0000001"));

    expect(screen.getByTestId("employee-contact")).toHaveTextContent(
      "amit@example.com · 050-0000001",
    );

    expect(screen.getByRole("button", { name: "Update employee" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete employee" })).toBeEnabled();
    expect(await screen.findByTestId("employee-records")).toHaveTextContent(
      "No lists, tasks, contacts, or filings saved for this employee.",
    );
  });

  it("shows the team total and the human-only total next to Team", async () => {
    renderEmployees();

    expect(await screen.findByTestId("team-usage")).toHaveTextContent("$0.0196 ($0.0098)");
  });

  it("shows conversation count and total LLM cost for the selected employee", async () => {
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByTitle("עמית חתן · amit@example.com · 050-0000001"));

    const usage = await screen.findByTestId("employee-usage");
    expect(usage).toHaveTextContent("Number of conversations 3 (17)");
    expect(usage).toHaveTextContent("Total amount $0.0022");
    expect(usageMock).toHaveBeenCalledWith(
      "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      expect.any(AbortSignal),
    );
  });

  it("shows saved lists, tasks, and filings with creator and time", async () => {
    recordsMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      groups: [
        {
          type: "shopping",
          title: "Shopping",
          items: [
            {
              id: "item-tuna",
              kind: "list" as const,
              title: "טונה",
              details: [{ label: "כמות", value: "2" }],
              fields: [
                { label: "שם פריט", value: "טונה" },
                { label: "כמות", value: "2" },
              ],
              createdBy: "טל",
              createdAt: "2026-09-13T07:00:00.000Z",
            },
          ],
        },
        {
          type: "tasks",
          title: "Tasks",
          items: [
            {
              id: "item-book",
              kind: "list" as const,
              title: "לקרוא ספר",
              details: [],
              fields: [{ label: "שם מטלה", value: "לקרוא ספר" }],
              createdBy: "עמית",
              createdAt: "2026-09-13T07:00:00.000Z",
            },
          ],
        },
        {
          type: "filing",
          title: "Filings",
          items: [
            {
              id: "filing-1",
              kind: "filing" as const,
              title: "מספר רכב",
              details: [{ label: "Details", value: "3434343" }],
              fields: [
                { label: "Name", value: "מספר רכב" },
                { label: "Details", value: "3434343" },
              ],
              createdBy: "עמית",
              createdAt: "2026-09-13T07:00:00.000Z",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByTitle("עמית חתן · amit@example.com · 050-0000001"));

    expect(recordsMock).toHaveBeenCalledWith(
      "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      expect.any(AbortSignal),
    );
    const panel = await screen.findByTestId("employee-records");
    expect(panel).toHaveTextContent("Shopping");
    expect(panel).toHaveTextContent("טונה");
    expect(panel).toHaveTextContent("כמות");
    expect(panel).toHaveTextContent("Created by טל");
    expect(panel).toHaveTextContent("Tasks");
    expect(panel).toHaveTextContent("לקרוא ספר");
    expect(panel).toHaveTextContent("Created by עמית");
    expect(panel).toHaveTextContent("Filings");
    expect(panel).toHaveTextContent("מספר רכב");
    expect(panel).toHaveTextContent("3434343");
  });

  it("shows email and phone fields after choosing a person", async () => {
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByRole("button", { name: "Add employee" }));
    expect(screen.getByRole("button", { name: "Person" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workee (digital)" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Person" }));

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
  });

  it("shows model, temperature, and instructions for a digital employee", async () => {
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByRole("button", { name: "Add employee" }));
    await user.click(screen.getByRole("button", { name: "Workee (digital)" }));

    expect(await screen.findByLabelText("Nickname")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4.1-mini");
    expect(screen.getByLabelText("Temperature")).toHaveValue(0);
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "You manage lists and filings.",
    );
    expect(
      screen.getByRole("button", { name: "Inherit from Lucy" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("lets Inherit from Lucy overwrite the digital prompt fields", async () => {
    const user = userEvent.setup();
    digitalDefaultsMock
      .mockResolvedValueOnce({
        model: "gpt-4.1-mini",
        temperature: 0,
        instructions: "You manage lists and filings.",
      })
      .mockResolvedValueOnce({
        model: "gpt-4.1",
        temperature: 0.3,
        instructions: "Lucy live prompt from DB",
      });
    renderEmployees();

    await user.click(await screen.findByRole("button", { name: "Add employee" }));
    await user.click(screen.getByRole("button", { name: "Workee (digital)" }));
    await screen.findByLabelText("Instructions");

    await user.clear(screen.getByLabelText("Instructions"));
    await user.type(screen.getByLabelText("Instructions"), "custom draft");
    await user.click(screen.getByRole("button", { name: "Inherit from Lucy" }));

    expect(await screen.findByLabelText("Instructions")).toHaveValue(
      "Lucy live prompt from DB",
    );
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4.1");
    expect(screen.getByLabelText("Temperature")).toHaveValue(0.3);
  });

  it("lets Lucy be edited but not deleted", async () => {
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByTitle("לוסי · gpt-4.1-mini"));

    expect(screen.getByRole("button", { name: "Update employee" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete employee" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Update employee" }));

    expect(screen.getByLabelText("Name")).toHaveValue("לוסי");
    expect(screen.getByLabelText("Nickname")).toHaveValue("לוסי");
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4.1-mini");
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "You manage lists and filings.",
    );
    expect(
      screen.queryByRole("button", { name: "Inherit from Lucy" }),
    ).not.toBeInTheDocument();
  });

  it("edits a saved item and refreshes the records", async () => {
    recordsMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      groups: [
        {
          type: "shopping",
          title: "Shopping",
          items: [
            {
              id: "item-tuna",
              kind: "list",
              title: "טונה",
              details: [{ label: "כמות", value: "2" }],
              fields: [
                { label: "שם פריט", value: "טונה" },
                { label: "כמות", value: "2" },
              ],
              createdBy: "טל",
              createdAt: "2026-09-13T07:00:00.000Z",
            },
          ],
        },
      ],
    });
    updateRecordMock.mockResolvedValue({
      records: {
        employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
        groups: [
          {
            type: "shopping",
            title: "Shopping",
            items: [
              {
                id: "item-tuna",
                kind: "list",
                title: "טונה",
                details: [{ label: "כמות", value: "4" }],
                fields: [
                  { label: "שם פריט", value: "טונה" },
                  { label: "כמות", value: "4" },
                ],
                createdBy: "טל",
                createdAt: "2026-09-13T07:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByTitle("עמית חתן · amit@example.com · 050-0000001"));
    await user.click(await screen.findByRole("button", { name: "Edit טונה" }));
    await user.clear(screen.getByLabelText("כמות"));
    await user.type(screen.getByLabelText("כמות"), "4");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateRecordMock).toHaveBeenCalledWith(
      "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      "item-tuna",
      [
        { label: "שם פריט", value: "טונה" },
        { label: "כמות", value: "4" },
      ],
    );
    expect(await screen.findByText("4")).toBeInTheDocument();
  });

  it("deletes a saved item after confirmation", async () => {
    recordsMock.mockResolvedValue({
      employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      groups: [
        {
          type: "tasks",
          title: "Tasks",
          items: [
            {
              id: "item-book",
              kind: "list",
              title: "לקרוא ספר",
              details: [],
              fields: [{ label: "שם מטלה", value: "לקרוא ספר" }],
              createdBy: "עמית",
              createdAt: "2026-09-13T07:00:00.000Z",
            },
          ],
        },
      ],
    });
    deleteRecordMock.mockResolvedValue({
      records: {
        employeeId: "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
        groups: [],
      },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByTitle("עמית חתן · amit@example.com · 050-0000001"));
    await user.click(await screen.findByRole("button", { name: "Delete לקרוא ספר" }));

    expect(confirm).toHaveBeenCalled();
    expect(deleteRecordMock).toHaveBeenCalledWith(
      "415ff13e-38d0-4dee-98b5-71e5dd11a38d",
      "item-book",
    );
    expect(
      await screen.findByText("No lists, tasks, contacts, or filings saved for this employee."),
    ).toBeInTheDocument();
    confirm.mockRestore();
  });
});
