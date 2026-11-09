export type MissionToolResult = {
  ok: boolean;
  summary: string;
  evidenceAttachmentIds?: string[];
  /** Opaque data for the next MISSION_TURN (no secrets). */
  data?: Record<string, unknown>;
  /** Pause for OTP / choice — runner sets waiting_user. */
  needsUser?: boolean;
  blockedReason?: "automation_blocked" | "needs_otp" | "needs_approval" | string;
};

export type MissionToolContext = {
  userId: string;
  speakerId: string;
  orchestratorId: string;
  executorId: string;
  missionId: string;
};

export type MissionToolHandler = (
  args: Record<string, unknown>,
  ctx: MissionToolContext,
) => Promise<MissionToolResult>;

export const CRITICAL_TOOLS = new Set([
  "vault.use",
  "payment.prepare",
  "payment.charge",
  "browser.submit",
  "browser.type_secret",
]);

export function toolRequiresApproval(
  tool: string,
  explicit?: boolean,
): boolean {
  if (explicit === true) {
    return true;
  }
  return CRITICAL_TOOLS.has(tool);
}
