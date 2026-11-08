/**
 * G8: production live facts come from ONE composer (composeTurnContext) used by
 * sendChatMessage and by the LIVE_FULL harness — order and gating cannot drift.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeTurnContext,
  type TurnContextParts,
} from "../src/services/chat.service.js";
import { mapSeededDumpLines } from "../src/eval/run-live-full.js";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const snapshot = (name: string): EmployeeRecordSnapshot => ({
  lists: [
    {
      list_type: "custom",
      list_name: name,
      owner: "טל",
      scope: "personal",
      items: [],
    },
  ],
  filing: [],
});

function parts(over: Partial<TurnContextParts> = {}): TurnContextParts {
  return {
    guestSpeaker: false,
    consultFrom: false,
    viewerId: "viewer-1",
    addressGender: "male",
    speakerSnapshot: snapshot("רשימת-דובר"),
    workerSnapshot: snapshot("רשימת-לוסי"),
    speakerContacts: [],
    contactBookShare: null,
    teamSchedules: [],
    recentOutbound: [],
    openJobs: [],
    activeMissionsBlock: "",
    lastNumberedDump: [{ n: 1, id: "item-1", kind: "custom", title_stem: "חלב" }],
    pendingAttachments: [
      {
        attachment_id: "att-1",
        file_name: "קבלה.pdf",
      } as TurnContextParts["pendingAttachments"][number],
    ],
    pendingLocation: null,
    lastLiveLocation: null,
    pendingInvite: null,
    tipsContext: "",
    ...over,
  };
}

describe("composeTurnContext", () => {
  it("keeps production order", () => {
    const text = composeTurnContext(parts());
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Data markers (block prose may mention other blocks' names).
    const order = [
      at("gender: male"),
      at("רשימת-דובר"),
      at("רשימת-לוסי"),
      at('"item-1"'),
      at('"att-1"'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("gender: male");
  });

  it("guest: only clock + shared data (+ tips); consult: no PENDING_ATTACHMENTS", () => {
    const guest = composeTurnContext(parts({ guestSpeaker: true, tipsContext: "TIPS" }));
    for (const hidden of ["gender: male", "רשימת-לוסי", '"item-1"', '"att-1"']) {
      expect(guest).not.toContain(hidden);
    }
    expect(guest).toContain("רשימת-דובר");
    expect(guest.endsWith("TIPS")).toBe(true);
    const consult = composeTurnContext(parts({ consultFrom: true }));
    expect(consult).not.toContain('"att-1"');
    expect(consult).toContain('"item-1"');
  });

  it("empty sources add nothing (no dump / files / worker → no blocks)", () => {
    const text = composeTurnContext(
      parts({ lastNumberedDump: [], pendingAttachments: [], workerSnapshot: null }),
    );
    expect(text).not.toContain('"item-1"');
    expect(text).not.toContain('"att-1"');
    expect(text).not.toContain("רשימת-לוסי");
    expect(text).not.toMatch(/^LAST_NUMBERED_DUMP:$/m);
    expect(text).not.toMatch(/^PENDING_ATTACHMENTS:$/m);
  });
});

describe("LIVE_FULL harness uses the production composer", () => {
  it("sendChatMessage and run-live-full both call composeTurnContext; facts ride as liveFacts", () => {
    const chat = read("src/services/chat.service.ts");
    expect(chat.match(/composeTurnContext\(\{/g)?.length).toBe(1);
    const harness = read("src/eval/run-live-full.ts");
    expect(harness).toContain("chat.composeTurnContext({");
    expect(harness).toContain("liveFacts = await buildProductionLiveFacts(");
    expect(harness).toContain("message = `${speaker}: ${input.utterance}`;");
    // Production loaders, not re-implementations.
    for (const loader of [
      "listOpenJobsForViewer(",
      "listPendingAttachments(",
      "getTeamSchedules(",
      "getContactBookShare(",
      "listRecentReminderOutbounds(",
      "getPendingLocation(",
      "chat.withAttachmentRefsSafe(",
    ]) {
      expect(harness, loader).toContain(loader);
    }
  });

  it("seeded dump ids map to seeded rows; unknown ids pass through", () => {
    const mapped = mapSeededDumpLines(
      [
        { n: 1, id: "eval-item-a", kind: "custom", title_stem: "א" },
        { n: 2, id: "raw-id", kind: "custom", title_stem: "ב" },
      ],
      new Map([["eval-item-a", "uuid-a"]]),
    );
    expect(mapped.map((l) => l.id)).toEqual(["uuid-a", "raw-id"]);
  });
});
