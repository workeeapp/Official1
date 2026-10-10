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
  configFileDefaultsMock,
  updateEmployeeMock,
  usageMock,
  teamUsageMock,
} = vi.hoisted(() => ({
  configFileDefaultsMock: vi.fn(),
  updateEmployeeMock: vi.fn(),
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
      configFileDefaults: configFileDefaultsMock,
      create: vi.fn(),
      update: updateEmployeeMock,
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
          reasoningEffort: "low" as const,
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
      months: [
        { month: "2026-10", conversations: 2, interactions: 12, totalUsd: 0.0015 },
        { month: "2026-09", conversations: 1, interactions: 5, totalUsd: 0.0006528 },
      ],
    });
    teamUsageMock.mockReset().mockResolvedValue({
      allEmployeesUsd: 0.0196,
      humanEmployeesUsd: 0.0098,
      months: [
        { month: "2026-10", allEmployeesUsd: 0.0126, humanEmployeesUsd: 0.0063 },
        { month: "2026-09", allEmployeesUsd: 0.007, humanEmployeesUsd: 0.0035 },
      ],
    });
    updateRecordMock.mockReset();
    deleteRecordMock.mockReset();
    digitalDefaultsMock.mockReset().mockResolvedValue({
      model: "gpt-4.1-mini",
      temperature: 0,
      reasoningEffort: "low",
      instructions: "You manage lists and filings.",
    });
    configFileDefaultsMock.mockReset().mockResolvedValue({
      model: "gpt-file-model",
      temperature: 0.7,
      reasoningEffort: "low",
      instructions: "Prompt from LLM.config.json",
    });
    updateEmployeeMock.mockReset();
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

  it("splits the team amounts by month, newest first", async () => {
    renderEmployees();

    const months = await screen.findByTestId("team-usage-months");
    const rows = within(months).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("10/2026 $0.0126 ($0.0063)");
    expect(rows[1]).toHaveTextContent("09/2026 $0.007 ($0.0035)");
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

    const rows = within(screen.getByTestId("employee-usage-months")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("10/2026");
    expect(rows[0]).toHaveTextContent("Number of conversations 2 (12)");
    expect(rows[0]).toHaveTextContent("Total amount $0.0015");
    expect(rows[1]).toHaveTextContent("09/2026");
    expect(rows[1]).toHaveTextContent("Number of conversations 1 (5)");
    expect(rows[1]).toHaveTextContent("Total amount $0.0007");
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
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("low");
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
        reasoningEffort: "low",
        instructions: "You manage lists and filings.",
      })
      .mockResolvedValueOnce({
        model: "gpt-4.1",
        temperature: 0.3,
        reasoningEffort: "medium",
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
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("medium");
  });

  it("saves the reasoning effort chosen next to the model", async () => {
    const user = userEvent.setup();
    updateEmployeeMock.mockResolvedValue({});
    renderEmployees();

    await user.click(await screen.findByTitle("לוסי · gpt-4.1-mini"));
    expect(screen.getByTestId("employee-contact")).toHaveTextContent("Reasoning low");
    await user.click(screen.getByRole("button", { name: "Update employee" }));

    const effort = screen.getByLabelText("Reasoning effort");
    expect(effort).toHaveValue("low");
    await user.selectOptions(effort, "high");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateEmployeeMock).toHaveBeenCalledWith(
      "7aaae1a2-c4c1-4edc-9d87-fe5ac740c1f4",
      expect.objectContaining({ model: "gpt-4.1-mini", reasoningEffort: "high" }),
    );
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

  it("replaces only Lucy's on-screen prompt from the config file after confirm", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEmployees();

    await user.click(await screen.findByTitle("לוסי · gpt-4.1-mini"));
    await user.click(screen.getByRole("button", { name: "Update employee" }));
    await user.click(screen.getByRole("button", { name: "Inherit Lucy config file" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Confirm change of existing prompt with LLM.config.json?\nPLEASE SAVE CURRENT PROMPT FOR BACKUP!",
    );
    expect(await screen.findByLabelText("Instructions")).toHaveValue(
      "Prompt from LLM.config.json",
    );
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4.1-mini");
    expect(screen.getByLabelText("Temperature")).toHaveValue(0);
    expect(updateEmployeeMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("keeps the prompt when the config file replace is cancelled", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEmployees();

    await user.click(await screen.findByTitle("לוסי · gpt-4.1-mini"));
    await user.click(screen.getByRole("button", { name: "Update employee" }));
    await user.click(screen.getByRole("button", { name: "Inherit Lucy config file" }));

    expect(configFileDefaultsMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "You manage lists and filings.",
    );
    confirmSpy.mockRestore();
  });

  it("does not offer the config file prompt when adding a digital worker", async () => {
    const user = userEvent.setup();
    renderEmployees();

    await user.click(await screen.findByRole("button", { name: "Add employee" }));
    await user.click(screen.getByRole("button", { name: "Workee (digital)" }));
    await screen.findByLabelText("Instructions");

    expect(
      screen.queryByRole("button", { name: "Inherit Lucy config file" }),
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
