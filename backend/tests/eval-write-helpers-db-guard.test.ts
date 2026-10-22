/**
 * Defense-in-depth: exported eval write helpers must refuse unapproved DB
 * before any Prisma / production-apply call. Prisma and apply services are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const catchable = () => {
    const p = Promise.resolve(undefined);
    return Object.assign(p, { catch: vi.fn(() => Promise.resolve(undefined)) });
  };
  return {
    user: { create: vi.fn(), delete: vi.fn(() => catchable()) },
    employee: { create: vi.fn(), deleteMany: vi.fn() },
    reminder: {
      deleteMany: vi.fn(() => catchable()),
      create: vi.fn(),
    },
    contact: { deleteMany: vi.fn(() => catchable()), upsert: vi.fn() },
    contactBook: { deleteMany: vi.fn(() => catchable()) },
    employeeFiling: { deleteMany: vi.fn(), create: vi.fn() },
    employeeList: {
      deleteMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    employeeListItem: { create: vi.fn(), update: vi.fn(() => catchable()) },
  };
});

const applyListOps = vi.hoisted(() => vi.fn());
const applyEmployeeRecords = vi.hoisted(() =>
  vi.fn(async () => ({ mutations: [] })),
);
const applyReminders = vi.hoisted(() => vi.fn());

vi.mock("../src/database/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/services/list-ops.service.js", () => ({
  applyListOps,
}));
vi.mock("../src/services/employee-records.service.js", () => ({
  applyEmployeeRecords,
  getEmployeeRecordSnapshot: vi.fn(),
  formatEmployeeContext: vi.fn(),
}));
vi.mock("../src/services/reminder.service.js", () => ({
  applyReminders,
}));
vi.mock("../src/services/attachment.service.js", () => ({
  withAttachmentRefs: vi.fn(async (x: unknown) => x),
}));
vi.mock("../src/services/list-item-list-link.service.js", () => ({
  withLinkedListRefs: vi.fn(async (x: unknown) => x),
}));

import {
  applyFixtureTurn,
  createHarnessAccount,
  destroyHarnessAccount,
  seedSetup,
  type HarnessAccount,
} from "../src/eval/run-multi-turn.js";
import { applyModelMetadataTurn } from "../src/eval/run-model-apply.js";
import { UnapprovedEvalDatabaseError } from "../src/eval/studio-db-guard.js";
import { emptyLlmMetadata } from "@workee/shared";

const fakeAccount: HarnessAccount = {
  userId: "user-1",
  employeeId: "emp-1",
  speaker: "טל",
  actor: {
    id: "emp-1",
    kind: "human",
    name: "טל",
    surname: "",
    nickname: "טל",
    email: null,
    phone: null,
    isOwner: true,
  },
  partners: [],
  employees: [],
};
fakeAccount.employees = [fakeAccount.actor];

function resetPrismaMocks(): void {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group)) {
      if (typeof fn === "function" && "mockClear" in fn) {
        (fn as ReturnType<typeof vi.fn>).mockClear();
      }
    }
  }
  applyListOps.mockClear();
  applyEmployeeRecords.mockClear();
  applyReminders.mockClear();
}

function expectNoPrismaOrApply(): void {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group)) {
      if (typeof fn === "function" && "mock" in fn) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  }
  expect(applyListOps).not.toHaveBeenCalled();
  expect(applyEmployeeRecords).not.toHaveBeenCalled();
  expect(applyReminders).not.toHaveBeenCalled();
}

describe("exported eval write helpers refuse unapproved DB before Prisma", () => {
  const prevApproved = process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
  const prevDb = process.env.DATABASE_URL;

  beforeEach(() => {
    resetPrismaMocks();
    delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://workee:workee@127.0.0.1:5435/workee";
  });

  afterEach(() => {
    if (prevApproved === undefined) {
      delete process.env.WORKEE_APPROVED_TEST_DATABASE_URL;
    } else {
      process.env.WORKEE_APPROVED_TEST_DATABASE_URL = prevApproved;
    }
    if (prevDb === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = prevDb;
    }
  });

  it("createHarnessAccount", async () => {
    await expect(createHarnessAccount("טל")).rejects.toBeInstanceOf(
      UnapprovedEvalDatabaseError,
    );
    expectNoPrismaOrApply();
  });

  it("destroyHarnessAccount", async () => {
    await expect(destroyHarnessAccount(fakeAccount)).rejects.toBeInstanceOf(
      UnapprovedEvalDatabaseError,
    );
    expectNoPrismaOrApply();
  });

  it("seedSetup", async () => {
    await expect(
      seedSetup("emp-1", "טל", { lists: [] }, new Map()),
    ).rejects.toBeInstanceOf(UnapprovedEvalDatabaseError);
    expectNoPrismaOrApply();
  });

  it("applyFixtureTurn", async () => {
    await expect(
      applyFixtureTurn({
        account: fakeAccount,
        fixtureRaw: emptyLlmMetadata(),
        idMap: new Map(),
      }),
    ).rejects.toBeInstanceOf(UnapprovedEvalDatabaseError);
    expectNoPrismaOrApply();
  });

  it("applyModelMetadataTurn", async () => {
    await expect(
      applyModelMetadataTurn({
        account: fakeAccount,
        metadata: emptyLlmMetadata(),
      }),
    ).rejects.toBeInstanceOf(UnapprovedEvalDatabaseError);
    expectNoPrismaOrApply();
  });

  it("destroyHarnessAccount also refuses product workee self-approval", async () => {
    const product = "postgresql://workee:workee@127.0.0.1:5435/workee";
    process.env.DATABASE_URL = product;
    process.env.WORKEE_APPROVED_TEST_DATABASE_URL = product;
    await expect(destroyHarnessAccount(fakeAccount)).rejects.toThrow(
      /product database/i,
    );
    expectNoPrismaOrApply();
  });
});
