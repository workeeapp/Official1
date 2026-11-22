/**
 * Wave 1 Stage 2 — ExplicitJoinHandler (opaque button only).
 * Join → connect pending Share invites → execute pendingAction.
 * Never auto-accept Assign from a general join.
 */
import {
  digitalEmployees,
  emptyLlmMetadata,
  type LlmMetadata,
  type PublicEmployee,
} from "@workee/shared";
import { prisma } from "../database/prisma.js";
import { acceptExplicitJoin } from "./consent-stage.service.js";
import {
  confirmCollabInvite,
  parseCollabInvitePayload,
} from "./collab-invite.service.js";
import {
  consumePendingProspectAction,
  loadPendingProspectAction,
} from "./pending-prospect-action.service.js";
import { planTargetedActions } from "./employee-targets.service.js";
import { listEmployeesForUser } from "./employee.service.js";
import { applyEmployeeRecords } from "./employee-records.service.js";
import { applyListOps } from "./list-ops.service.js";
import { applyReminders } from "./reminder.service.js";
import { applyDirectoryActions } from "./contact.service.js";
import { findPendingCollabInvites } from "./whatsapp-invite.service.js";
import {
  applyHighRiskActionGate,
  digitalWorkerGateNames,
} from "./high-risk-action-gate.js";

export type ExplicitJoinResult = {
  ok: boolean;
  joined: boolean;
  spoken: string;
  /** When Assign was gated: re-present Accept/Decline after join (do not auto-accept). */
  rePresentAssignInviteId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function handleExplicitJoinAccept(input: {
  userId: string;
  employeeId: string;
  digitalEmployeeId: string;
  joinCommand: string;
  recipientPhone?: string | null;
}): Promise<ExplicitJoinResult> {
  const join = await acceptExplicitJoin({
    userId: input.userId,
    actorEmployeeId: input.employeeId,
  });
  if (join === "missing") {
    return { ok: false, joined: false, spoken: "לא מצאתי את החשבון." };
  }
  const joined = join === "joined";

  const pending = await loadPendingProspectAction({
    joinCommand: input.joinCommand,
    userId: input.userId,
  });

  // Connect pending Share invites for this phone (Member path). Assign stays separate.
  const shareConnected = await connectPendingShareInvites({
    userId: input.userId,
    recipientEmployeeId: input.employeeId,
    recipientPhone: input.recipientPhone,
  });

  if (!pending) {
    return {
      ok: true,
      joined,
      spoken: joined
        ? shareConnected > 0
          ? "ברוך הבא! חיברתי את השיתופים שהמתינו אליך."
          : "ברוך הבא! עכשיו אפשר לשמור אצלך תזכורות ורשימות."
        : "כבר מחובר/ת — אפשר להמשיך כרגיל.",
    };
  }

  if (pending.actionKind === "assign_accept") {
    await consumePendingProspectAction(pending.id);
    const inviteId =
      isRecord(pending.snapshot) && typeof pending.snapshot.inviteId === "string"
        ? pending.snapshot.inviteId
        : null;
    // Do not auto-accept Assign — re-present Accept/Decline now that Member.
    return {
      ok: true,
      joined: true,
      spoken:
        "הצטרפת בהצלחה. עכשיו אפשר לאשר או לדחות את האחריות עם הכפתורים למטה.",
      ...(inviteId ? { rePresentAssignInviteId: inviteId } : {}),
    };
  }

  if (pending.actionKind === "circuit_breaker") {
    await consumePendingProspectAction(pending.id);
    return {
      ok: true,
      joined: true,
      spoken: "מעולה — אפשר להמשיך לדבר איתי בחופשיות.",
    };
  }

  // Execute captured personal writes.
  const employees = await listEmployeesForUser(input.userId);
  const actor = employees.find((row) => row.id === input.employeeId);
  if (!actor) {
    await consumePendingProspectAction(pending.id);
    return {
      ok: true,
      joined: true,
      spoken: "הצטרפת, אבל לא הצלחתי לשחזר את הפעולה — נסו שוב.",
    };
  }
  const metadata = metadataFromSnapshot(pending.snapshot);
  // F30: Join accept is consent-to-join only — never Class V authorize.
  // Re-run HighRisk Gate with empty EIS and no button/snapshot bypass.
  const gated = applyHighRiskActionGate(metadata, {
    speaker: actor,
    digitalWorkerNames: digitalWorkerGateNames(digitalEmployees(employees)),
    allowAuthorizedSnapshot: false,
    isButtonCommand: false,
    instructionText: "",
    speakerText: "",
    knownTargetNames: [],
    clarifyBind: null,
  });
  const safeMetadata = gated.metadata;
  const summary = pending.summaryText.trim() || "את זה";
  if (!prospectReplayHasWork(safeMetadata)) {
    await consumePendingProspectAction(pending.id);
    return {
      ok: true,
      joined: true,
      spoken:
        "הצטרפת בהצלחה. הפעולה שדורשת אישור נוסף לא בוצעה אוטומטית — נסחו אותה שוב ואאשר כרגיל.",
    };
  }
  try {
    await replayProspectPendingWrites({
      userId: input.userId,
      actor,
      employees,
      digitalEmployeeId: input.digitalEmployeeId,
      metadata: safeMetadata,
    });
    await consumePendingProspectAction(pending.id);
    if (gated.didStrip) {
      return {
        ok: true,
        joined: true,
        spoken: `הצטרפת וביצעתי את החלקים האישיים של «${summary}». חלקים שדורשים אישור נוסף לא בוצעו — נסחו אותם שוב ואאשר כרגיל.`,
      };
    }
    return {
      ok: true,
      joined: true,
      spoken: `בוצע! שמרתי לך את «${summary}».`,
    };
  } catch {
    await consumePendingProspectAction(pending.id);
    return {
      ok: true,
      joined: true,
      spoken: "הצטרפת בהצלחה, אבל השמירה לא הושלמה — נסו שוב ואשמור.",
    };
  }
}

/** True when replay would persist something (messages never staged — F28). */
function prospectReplayHasWork(metadata: LlmMetadata): boolean {
  return (
    (metadata.lists?.length ?? 0) > 0 ||
    (metadata.listOps?.length ?? 0) > 0 ||
    (metadata.filing?.length ?? 0) > 0 ||
    (metadata.reminders?.length ?? 0) > 0 ||
    (metadata.directory?.length ?? 0) > 0
  );
}

async function connectPendingShareInvites(input: {
  userId: string;
  recipientEmployeeId: string;
  recipientPhone?: string | null;
}): Promise<number> {
  if (!input.recipientPhone?.trim()) {
    return 0;
  }
  const employees = await listEmployeesForUser(input.userId);
  const recipient = employees.find((row) => row.id === input.recipientEmployeeId);
  if (!recipient?.phone) {
    return 0;
  }
  const rows = await findPendingCollabInvites(recipient.phone);
  let connected = 0;
  for (const row of rows) {
    const payload = parseCollabInvitePayload(row.payload);
    if (!payload || payload.kind !== "share") {
      continue;
    }
    const result = await confirmCollabInvite({
      inviteId: row.id,
      recipient,
      sharedLists: [],
      recipientIsProspect: false,
    });
    if (result === "consumed") {
      connected += 1;
    }
  }
  return connected;
}

function metadataFromSnapshot(snapshot: unknown): LlmMetadata {
  if (!isRecord(snapshot)) {
    return emptyLlmMetadata();
  }
  const meta = isRecord(snapshot.metadata) ? snapshot.metadata : snapshot;
  return {
    ...emptyLlmMetadata(),
    lists: Array.isArray(meta.lists) ? (meta.lists as LlmMetadata["lists"]) : [],
    listOps: Array.isArray(meta.listOps)
      ? (meta.listOps as LlmMetadata["listOps"])
      : [],
    filing: Array.isArray(meta.filing)
      ? (meta.filing as LlmMetadata["filing"])
      : [],
    reminders: Array.isArray(meta.reminders)
      ? (meta.reminders as LlmMetadata["reminders"])
      : [],
    directory: Array.isArray(meta.directory)
      ? (meta.directory as LlmMetadata["directory"])
      : [],
    jobs: Array.isArray(meta.jobs) ? (meta.jobs as LlmMetadata["jobs"]) : [],
    missions: Array.isArray(meta.missions)
      ? (meta.missions as LlmMetadata["missions"])
      : [],
  };
}

async function replayProspectPendingWrites(input: {
  userId: string;
  actor: PublicEmployee;
  employees: PublicEmployee[];
  digitalEmployeeId: string;
  metadata: LlmMetadata;
}): Promise<void> {
  const humans = input.employees.filter((row) => row.kind === "human");
  if ((input.metadata.listOps?.length ?? 0) > 0) {
    await applyListOps({
      userId: input.userId,
      actor: input.actor,
      employees: humans,
      ops: input.metadata.listOps ?? [],
    });
  }
  const plan = planTargetedActions({
    actor: input.actor,
    employees: humans,
    workers: digitalEmployees(input.employees),
    externalPartners: [],
    metadata: input.metadata,
    sharedLists: [],
  });
  for (const application of plan.applications) {
    await applyEmployeeRecords(
      application.employeeId,
      application.metadata,
      application.visibility,
      input.actor.id,
    );
  }
  if ((input.metadata.reminders?.length ?? 0) > 0) {
    await applyReminders({
      userId: input.userId,
      actor: input.actor,
      reminders: input.metadata.reminders ?? [],
      employees: input.employees,
    });
  }
  if ((input.metadata.directory?.length ?? 0) > 0) {
    await applyDirectoryActions({
      userId: input.userId,
      ownerEmployeeId: input.actor.id,
      actions: input.metadata.directory ?? [],
      employees: humans,
      // F30 already re-Gated; surviving phone rows are authorized.
      authorizePhoneFields: true,
    });
  }
}
