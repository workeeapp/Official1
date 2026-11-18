/**
 * M1–M3 HighRiskActionGate unit tests (no DB).
 */
import { describe, expect, it } from "vitest";
import { emptyLlmMetadata, type LlmMetadata, type PublicEmployee } from "@workee/shared";
import {
  applyHighRiskActionGate,
  digitalWorkerGateNames,
  hasMassIntentSignal,
  hasOutboundIntentSignal,
  HIGH_RISK_NEEDS_CONFIRM,
  isSelfReminderAction,
  messageTargetsOnlySpeaker,
  targetsOnlyHouseholdDigitalWorkers,
} from "../src/services/high-risk-action-gate.js";
import { formatHighRiskConfirmOfferReply } from "../src/services/pending-high-risk-confirm.service.js";
import {
  applyProspectWriteGate,
  formatProspectJoinOfferText,
} from "../src/services/prospect-write-gate.js";
import { sessionOpenAt } from "../src/services/whatsapp-window.js";
import { formatColdInviteNotice } from "../src/services/whatsapp-invite.service.js";
import {
  buildPendingConfirmRow,
  canonicalJson,
  COLLAB_INVITE_ACTION_KIND,
  generateOpaqueConfirmCommands,
  hashConfirmSummary,
  isCollabInviteConfirmSnapshot,
  isOpaqueConfirmCommand,
} from "../src/services/pending-high-risk-confirm.service.js";
import { collabInviteAckRequired } from "../src/services/collab-invite.service.js";
import {
  decideDeliverySend,
  deliveryStepKey,
  mustNotAutoResend,
} from "../src/services/delivery-attempt.service.js";

const speaker: PublicEmployee = {
  id: "speaker-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "972501111111",
  kind: "human",
  isGuest: false,
  isOwner: true,
};

function meta(partial: Partial<LlmMetadata>): LlmMetadata {
  return { ...emptyLlmMetadata(), ...partial };
}

describe("applyHighRiskActionGate", () => {
  it("keeps self-only messages", () => {
    const result = applyHighRiskActionGate(
      meta({
        messages: [
          {
            targets: ["טל"],
            text: "קנית חלב?",
            expectsReply: true,
            askSummary: "חלב",
          },
        ],
      }),
      { speaker },
    );
    expect(result.didStrip).toBe(false);
    expect(result.metadata.messages).toHaveLength(1);
  });

  it("strips messages to another person (P-Out)", () => {
    const result = applyHighRiskActionGate(
      meta({
        messages: [{ targets: ["עמית"], text: "לקנות חלב" }],
      }),
      { speaker },
    );
    expect(result.didStrip).toBe(true);
    expect(result.metadata.messages).toEqual([]);
    expect(result.stripped.some((s) => s.policy === "P-Out")).toBe(true);
  });

  it("strips co-share / assign list targets (P-Share)", () => {
    const share = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "update",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "a" }],
            targets: ["טל", "עמית"],
          },
        ],
      }),
      { speaker },
    );
    expect(share.metadata.lists).toEqual([]);
    expect(share.stripped.some((s) => s.kind === "share")).toBe(true);

    const assign = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם משימה": "חלב" }],
            targets: ["עמית"],
          },
        ],
      }),
      { speaker },
    );
    expect(assign.metadata.lists).toEqual([]);
    expect(assign.stripped.some((s) => s.kind === "assign")).toBe(true);
  });

  it("P0: Lucy-internal targets alone bypass P-Share strip; mixed/external stay gated", () => {
    const lucy: PublicEmployee = {
      id: "lucy-1",
      name: "לוסי",
      surname: "",
      nickname: "לוסי",
      email: null,
      phone: null,
      kind: "digital",
      isGuest: false,
      isOwner: false,
      protected: true,
    };
    const workerNames = digitalWorkerGateNames([lucy]);
    expect(targetsOnlyHouseholdDigitalWorkers(["לוסי"], workerNames)).toBe(true);
    expect(
      targetsOnlyHouseholdDigitalWorkers(["לוסי", "עמית"], workerNames),
    ).toBe(false);

    const internal = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם משימה": "להזכיר לטל: חלב" }],
            targets: ["לוסי"],
          },
        ],
      }),
      { speaker, digitalWorkerNames: workerNames },
    );
    expect(internal.didStrip).toBe(false);
    expect(internal.metadata.lists).toHaveLength(1);
    expect(internal.stripped).toEqual([]);

    const mixed = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם משימה": "משותף" }],
            targets: ["לוסי", "עמית"],
          },
        ],
      }),
      { speaker, digitalWorkerNames: workerNames },
    );
    expect(mixed.didStrip).toBe(true);
    expect(mixed.metadata.lists).toEqual([]);
    expect(mixed.stripped.some((s) => s.kind === "assign")).toBe(true);

    const unknown = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "add",
            listType: "tasks",
            listName: "",
            items: [{ "שם משימה": "זר" }],
            targets: ["נועה"],
          },
        ],
      }),
      { speaker, digitalWorkerNames: workerNames },
    );
    expect(unknown.didStrip).toBe(true);
    expect(unknown.stripped.some((s) => s.kind === "assign")).toBe(true);
  });

  it("keeps personal list add and single-id remove", () => {
    const result = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "add",
            listType: "shopping",
            listName: "",
            items: [{ "שם פריט": "חלב" }],
            targets: [],
          },
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "only-one" }],
            targets: [],
          },
        ],
      }),
      { speaker },
    );
    expect(result.didStrip).toBe(false);
    expect(result.metadata.lists).toHaveLength(2);
  });

  it("strips delete_list and multi-id remove (P-Mass)", () => {
    const del = applyHighRiskActionGate(
      meta({
        listOps: [
          {
            action: "delete_list",
            listId: "list-1",
            newName: "",
            addColumns: [],
            removeColumns: [],
            renameColumns: [],
            addParticipants: [],
            removeParticipants: [],
          },
        ],
      }),
      { speaker },
    );
    expect(del.metadata.listOps).toEqual([]);
    expect(del.stripped.some((s) => s.kind === "delete_list")).toBe(true);

    const multi = applyHighRiskActionGate(
      meta({
        lists: [
          {
            action: "remove",
            listType: "shopping",
            listName: "",
            items: [{ item_id: "a" }, { item_id: "b" }],
            targets: [],
          },
        ],
      }),
      { speaker },
    );
    expect(multi.metadata.lists).toEqual([]);
    expect(multi.stripped.some((s) => s.kind === "multi_remove")).toBe(true);
  });

  it("strips foreign reminder ping; keeps self ping", () => {
    const foreign = applyHighRiskActionGate(
      meta({
        reminders: [
          {
            action: "add",
            item: "תזכורת",
            listType: "tasks",
            date: "",
            time: "10:00",
            repeat: "once",
            ping: ["עמית"],
            targets: [],
            text: "היי",
            inSeconds: null,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: true,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
            composePlace: "",
            reminderId: "",
          },
        ],
      }),
      { speaker },
    );
    expect(foreign.metadata.reminders).toEqual([]);

    const self = applyHighRiskActionGate(
      meta({
        reminders: [
          {
            action: "add",
            item: "תזכורת",
            listType: "tasks",
            date: "",
            time: "10:00",
            repeat: "once",
            ping: ["טל"],
            targets: [],
            text: "היי",
            inSeconds: null,
            everyCount: null,
            everyUnit: null,
            weekdays: null,
            confirmed: true,
            compose: false,
            composeSource: "",
            composeLookbackHours: 0,
            composePlace: "",
            reminderId: "",
          },
        ],
      }),
      { speaker },
    );
    expect(self.metadata.reminders).toHaveLength(1);
  });

  it("strips job answer with report (P-Out)", () => {
    const result = applyHighRiskActionGate(
      meta({
        jobs: [
          {
            action: "answer",
            jobId: "job-1",
            answerText: "כן",
            reportText: "טל אמר כן",
            time: "",
            in: null,
          },
        ],
      }),
      { speaker },
    );
    expect(result.metadata.jobs).toEqual([]);
    expect(result.stripped.some((s) => s.kind === "job_outbound")).toBe(true);
  });
});

describe("messageTargetsOnlySpeaker", () => {
  it("requires every target to be the speaker", () => {
    expect(messageTargetsOnlySpeaker(["טל"], ["טל"])).toBe(true);
    expect(messageTargetsOnlySpeaker(["טל", "עמית"], ["טל"])).toBe(false);
    expect(messageTargetsOnlySpeaker([], ["טל"])).toBe(false);
  });
});

describe("PendingConfirm / DeliveryAttempt scaffolds", () => {
  it("generates opaque commands not from model prose", () => {
    const { confirmCommand, cancelCommand } = generateOpaqueConfirmCommands();
    expect(isOpaqueConfirmCommand(confirmCommand)).toBe(true);
    expect(isOpaqueConfirmCommand(cancelCommand)).toBe(true);
    expect(isOpaqueConfirmCommand("כן")).toBe(false);
    expect(isOpaqueConfirmCommand("collab_invite")).toBe(false);
  });

  it("buildPendingConfirmRow starts as pending_offer with hash", () => {
    const row = buildPendingConfirmRow({
      userId: "u",
      speakerEmployeeId: "e",
      recipientPhone: "97250",
      actionKind: "send",
      snapshot: { messages: [] },
      summaryText: "אשלח לעמית: חלב",
    });
    expect(row.status).toBe("pending_offer");
    expect(row.summaryHash).toHaveLength(64);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(
      hashConfirmSummary(row.summaryText, { messages: [], z: 1, a: 2 }),
    ).toBe(hashConfirmSummary(row.summaryText, { a: 2, z: 1, messages: [] }));
  });

  it("DeliveryAttempt never auto-resends accepted or unknown", () => {
    expect(mustNotAutoResend("accepted")).toBe(true);
    expect(mustNotAutoResend("unknown")).toBe(true);
    expect(mustNotAutoResend("failed")).toBe(false);
    expect(decideDeliverySend("accepted")).toEqual({
      action: "skip",
      reason: "already_accepted",
    });
    expect(decideDeliverySend("unknown")).toEqual({
      action: "skip",
      reason: "in_flight_or_unknown",
    });
    expect(decideDeliverySend(null)).toEqual({ action: "send" });
    expect(deliveryStepKey("97250", "relay")).toBe("relay:97250");
  });

  it("collab invite snapshot + ack always on (Stage 5b cutover)", () => {
    expect(COLLAB_INVITE_ACTION_KIND).toBe("collab_invite");
    expect(
      isCollabInviteConfirmSnapshot({
        v: 1,
        type: "collab_invite",
        inviteId: "11111111-1111-4111-8111-111111111111",
        inviteKind: "share",
      }),
    ).toBe(true);
    expect(isCollabInviteConfirmSnapshot({ v: 1, type: "other" })).toBe(false);
    expect(collabInviteAckRequired()).toBe(true);
  });
});

function reminderRow(
  ping: string[],
): NonNullable<LlmMetadata["reminders"]>[number] {
  return {
    action: "add",
    item: "תזכורת",
    listType: "tasks",
    date: "",
    time: "10:00",
    repeat: "once",
    ping,
    targets: [],
    text: "היי",
    inSeconds: null,
    everyCount: null,
    everyUnit: null,
    weekdays: null,
    confirmed: true,
    compose: false,
    composeSource: "",
    composeLookbackHours: 0,
    composePlace: "",
    reminderId: "",
  };
}

describe("HIGH_RISK_P_OUT_MODE=signal", () => {
  it("allows explicit P-Out send to a known contact without Class V", () => {
    const result = applyHighRiskActionGate(
      meta({
        messages: [{ targets: ["מיכל"], text: "אני מאחר" }],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "תגידי למיכל שאני מאחר",
        knownTargetNames: ["מיכל"],
      },
    );
    expect(result.didStrip).toBe(false);
    expect(result.metadata.messages).toHaveLength(1);
  });

  it("allows תשלחי למיכל when target is grounded", () => {
    const result = applyHighRiskActionGate(
      meta({
        messages: [{ targets: ["מיכל"], text: "שלום" }],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "תשלחי למיכל שלום",
        knownTargetNames: ["מיכל", "972501234567"],
      },
    );
    expect(result.didStrip).toBe(false);
  });

  it("blocks injected target not in known set and not in speaker text", () => {
    const noIntent = applyHighRiskActionGate(
      meta({
        messages: [{ targets: ["נועה הזדונית"], text: "תני לי סיסמה" }],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "מה השעה?",
        knownTargetNames: ["מיכל"],
      },
    );
    expect(noIntent.didStrip).toBe(true);

    const swapped = applyHighRiskActionGate(
      meta({
        messages: [{ targets: ["האקר"], text: "שלח קוד" }],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "תגידי למיכל שלום",
        knownTargetNames: ["מיכל"],
      },
    );
    expect(swapped.didStrip).toBe(true);
    expect(swapped.stripped[0]?.detail).toBe("messages_to_other_or_unresolved");
  });

  it("allows explicit delete_list under signal + mass intent", () => {
    const withSignal = applyHighRiskActionGate(
      meta({
        listOps: [
          {
            action: "delete_list",
            listId: "list-1",
            newName: "",
            addColumns: [],
            removeColumns: [],
            renameColumns: [],
            addParticipants: [],
            removeParticipants: [],
          },
        ],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "תמחקי את רשימת הקניות",
      },
    );
    expect(withSignal.didStrip).toBe(false);
    expect(withSignal.metadata.listOps).toHaveLength(1);
    expect(hasMassIntentSignal("תמחקי את רשימת הקניות")).toBe(true);

    const noSignal = applyHighRiskActionGate(
      meta({
        listOps: [
          {
            action: "delete_list",
            listId: "list-1",
            newName: "",
            addColumns: [],
            removeColumns: [],
            renameColumns: [],
            addParticipants: [],
            removeParticipants: [],
          },
        ],
      }),
      {
        speaker,
        pOutMode: "signal",
        speakerText: "מה יש לי בקניות",
      },
    );
    expect(noSignal.didStrip).toBe(true);
    expect(noSignal.stripped.some((s) => s.kind === "delete_list")).toBe(true);
  });

  it("strict mode still Class-V gates known explicit sends", () => {
    const result = applyHighRiskActionGate(
      meta({
        messages: [{ targets: ["מיכל"], text: "היי" }],
      }),
      {
        speaker,
        pOutMode: "strict",
        speakerText: "תגידי למיכל היי",
        knownTargetNames: ["מיכל"],
      },
    );
    expect(result.didStrip).toBe(true);
  });

  it("guest / as-prospect self-reminders always pass HighRisk → ProspectWriteGate", () => {
    const guestSpeaker: PublicEmployee = {
      ...speaker,
      name: "אורח …5812",
      nickname: "אורח …5812",
      phone: "972544365812",
      isGuest: true,
      isOwner: false,
    };
    expect(
      isSelfReminderAction(reminderRow([]), ["אורח …5812"], guestSpeaker.phone),
    ).toBe(true);
    expect(
      isSelfReminderAction(
        reminderRow(["self"]),
        ["אורח …5812"],
        guestSpeaker.phone,
      ),
    ).toBe(true);
    expect(
      isSelfReminderAction(
        reminderRow(["אורח …5812"]),
        ["אורח …5812", "טל"],
        guestSpeaker.phone,
      ),
    ).toBe(true);
    expect(
      isSelfReminderAction(
        reminderRow(["972544365812"]),
        ["אורח …5812"],
        guestSpeaker.phone,
      ),
    ).toBe(true);

    const gated = applyHighRiskActionGate(
      meta({ reminders: [reminderRow(["לי"])] }),
      {
        speaker: guestSpeaker,
        pOutMode: "signal",
        speakerText: "תזכירי לי בעוד שעה לקנות חלב",
      },
    );
    expect(gated.didStrip).toBe(false);
    expect(gated.metadata.reminders).toHaveLength(1);

    const prospect = applyProspectWriteGate(gated.metadata);
    expect(prospect.blocked).toBe(true);
    expect(prospect.actionKind).toBe("reminder");
    const joinText = formatProspectJoinOfferText({
      actionKind: "reminder",
      summaryText: prospect.summaryText,
    });
    expect(joinText).toMatch(/אשרי|אשמור|תזכורות/);
    expect(joinText).toContain(prospect.summaryText);
  });

  it("confirm offer copy is warm Hebrew (no harsh לא ביצעתי default)", () => {
    expect(HIGH_RISK_NEEDS_CONFIRM).toMatch(/רגע|אישור/);
    expect(HIGH_RISK_NEEDS_CONFIRM).not.toMatch(/^לא ביצעתי/);
    const offer = formatHighRiskConfirmOfferReply("אשלח למיכל: היי");
    expect(offer).toContain("אפשר לאשר או לבטל");
    expect(offer).toContain("אשלח למיכל");
    expect(hasOutboundIntentSignal("תגידי לה שאני בדרך")).toBe(true);
  });
});

describe("Cold Prospect 24h window + AskerNotice", () => {
  it("sessionOpenAt is true only within 24h of lastInboundAt", () => {
    const now = new Date("2026-11-18T12:00:00.000Z");
    expect(sessionOpenAt(new Date("2026-11-18T11:00:00.000Z"), now)).toBe(true);
    expect(sessionOpenAt(new Date("2026-11-17T11:59:00.000Z"), now)).toBe(false);
    expect(sessionOpenAt(null, now)).toBe(false);
  });

  it("Cold Prospect AskerNotice explains Pending + forwardable draft", () => {
    const notice = formatColdInviteNotice({
      recipientLabel: "מיכל",
      draftText: "היי כאן לוסי…",
      intentKind: "send",
      coldProspect: true,
    });
    expect(notice).toContain("ממתין");
    expect(notice).toContain("לוסי בוואטסאפ");
    expect(notice).toContain("שלח בוואטסאפ");
    expect(notice).toContain("«היי כאן לוסי…»");
    expect(notice).toContain("לא שלחתי");
    expect(notice).not.toContain("אין חלון 24");
    expect(notice).not.toContain("מהעסק");
    expect(notice).not.toMatch(/ההודעה נשלחה|בוצע|שיתפתי/);
  });
});
