import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    employee: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    team: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    employeeListItem: {
      findMany: vi.fn(),
    },
    employeeFiling: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/database/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/tips.service.js", () => ({
  ensureDefaultTips: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config/llm.js", () => ({
  loadLlmConfig: () => ({
    model: "test",
    temperature: 0,
    reasoningEffort: null,
    systemMessage: "test",
  }),
}));

import { resolveExternalSharePartners } from "../src/services/contact.service.js";
import { listRegisteredHumansByPhones } from "../src/services/employee.service.js";
import {
  loadFilingOwners,
  loadListItemOwners,
} from "../src/services/employee-records.service.js";

function humanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "hum-1",
    userId: "user-b",
    teamId: "team-b",
    kind: "human",
    name: "Michal",
    surname: "Cohen",
    nickname: null,
    email: null,
    phone: "972501111111",
    model: null,
    temperature: null,
    reasoningEffort: null,
    instructions: null,
    isProtected: false,
    isOwner: true,
    isGuest: false,
    addressGender: null,
    shareMirrorEmployeeId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("cross-account share helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listRegisteredHumansByPhones returns only non-guest humans", async () => {
    prismaMock.employee.findMany.mockResolvedValue([
      humanRow({ id: "hum-1", phone: "972501111111" }),
    ]);
    const rows = await listRegisteredHumansByPhones(["0501111111"]);
    expect(prismaMock.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "human",
          isGuest: false,
        }),
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: "hum-1",
        phone: "972501111111",
        isGuest: false,
      }),
    ]);
  });

  it("resolveExternalSharePartners maps contact names onto registered humans", async () => {
    prismaMock.employee.findMany.mockResolvedValue([
      humanRow({ id: "hum-2", phone: "972502222222", nickname: null }),
    ]);
    const partners = await resolveExternalSharePartners(
      [
        {
          id: "c1",
          name: "מיכל מהעבודה",
          phone: "0502222222",
          kind: "personal",
        },
      ],
      new Set(),
    );
    expect(partners).toEqual([
      expect.objectContaining({
        id: "hum-2",
        nickname: "מיכל מהעבודה",
      }),
    ]);
  });

  it("resolveExternalSharePartners skips same-account exclude ids", async () => {
    prismaMock.employee.findMany.mockResolvedValue([
      humanRow({
        id: "same-team",
        userId: "user-a",
        phone: "972503333333",
        name: "Tal",
        nickname: "טל",
      }),
    ]);
    const partners = await resolveExternalSharePartners(
      [{ id: "c2", name: "טל", phone: "0503333333", kind: "personal" }],
      new Set(["same-team"]),
    );
    expect(partners).toEqual([]);
  });

  it("loadListItemOwners includes cross-account rows the actor can see", async () => {
    const itemId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    prismaMock.employeeListItem.findMany.mockResolvedValue([
      {
        id: itemId,
        visibleTo: ["owner-b", "actor-a"],
        list: {
          employeeId: "owner-b",
          listType: "shopping",
          name: "",
          scope: "shared",
          visibleTo: ["owner-b", "actor-a"],
          employee: { userId: "user-b" },
        },
      },
    ]);
    const owners = await loadListItemOwners("user-a", [itemId], "actor-a");
    expect(owners.get(itemId)?.ownerId).toBe("owner-b");
  });

  it("loadListItemOwners rejects foreign rows the actor cannot see", async () => {
    const itemId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    prismaMock.employeeListItem.findMany.mockResolvedValue([
      {
        id: itemId,
        visibleTo: ["owner-b"],
        list: {
          employeeId: "owner-b",
          listType: "shopping",
          name: "",
          scope: "personal",
          visibleTo: [],
          employee: { userId: "user-b" },
        },
      },
    ]);
    const owners = await loadListItemOwners("user-a", [itemId], "actor-a");
    expect(owners.size).toBe(0);
  });

  it("loadFilingOwners includes cross-account filings in visible_to", async () => {
    const filingId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    prismaMock.employeeFiling.findMany.mockResolvedValue([
      {
        id: filingId,
        employeeId: "owner-b",
        visibleTo: ["owner-b", "actor-a"],
        scope: "shared",
        employee: { userId: "user-b" },
      },
    ]);
    const owners = await loadFilingOwners("user-a", [filingId], "actor-a");
    expect(owners.get(filingId)?.ownerId).toBe("owner-b");
  });
});
