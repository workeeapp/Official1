import { storeSecret, useSecret, type VaultKind } from "../mission-vault.js";
import {
  browserClick,
  browserExtract,
  browserNavigate,
  browserObserve,
  browserPress,
  browserScreenshot,
  browserScroll,
  browserSelect,
  browserSubmit,
  browserType,
  browserWait,
} from "./browser.js";
import { paymentCharge, paymentPrepare } from "./payment.js";
import {
  toolRequiresApproval,
  type MissionToolContext,
  type MissionToolHandler,
  type MissionToolResult,
} from "./types.js";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search.js";

export { toolRequiresApproval, CRITICAL_TOOLS } from "./types.js";
export type { MissionToolResult, MissionToolContext } from "./types.js";
export { WEB_SEARCH_TOOL } from "./web-search.js";

async function vaultAskAndStore(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const kindRaw = typeof args.kind === "string" ? args.kind.trim() : "login";
  const kind: VaultKind = kindRaw === "payment" ? "payment" : "login";
  const label =
    typeof args.label === "string" && args.label.trim()
      ? args.label.trim()
      : kind === "payment"
        ? "כרטיס שמור"
        : "לוגין";
  const site = typeof args.site === "string" ? args.site.trim() : "";
  const username =
    typeof args.username === "string" ? args.username : undefined;
  const password =
    typeof args.password === "string" ? args.password : undefined;
  const token = typeof args.token === "string" ? args.token : undefined;

  if (kind === "login" && (!username || !password)) {
    return {
      ok: false,
      summary: "vault.ask_and_store login needs username+password from user reply",
      needsUser: true,
      blockedReason: "needs_user",
    };
  }
  if (kind === "payment" && !token && !password) {
    return {
      ok: false,
      summary: "vault.ask_and_store payment needs token (or placeholder) from user",
      needsUser: true,
      blockedReason: "needs_user",
    };
  }

  const stored = await storeSecret({
    userId: ctx.userId,
    speakerId: ctx.speakerId,
    kind,
    label,
    site,
    payload:
      kind === "login"
        ? { username, password }
        : { token: token || password },
    actorEmployeeId: ctx.executorId,
  });
  return {
    ok: true,
    summary: `Stored ${kind} secret «${stored.label}»`,
    data: { secret_id: stored.secretId, label: stored.label, site: stored.site },
  };
}

async function vaultUseTool(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const secretId =
    typeof args.secret_id === "string"
      ? args.secret_id.trim()
      : typeof args.secretId === "string"
        ? args.secretId.trim()
        : "";
  if (!secretId) {
    return { ok: false, summary: "vault.use requires secret_id" };
  }
  const used = await useSecret({
    userId: ctx.userId,
    speakerId: ctx.speakerId,
    secretId,
    actorEmployeeId: ctx.executorId,
  });
  // Never return payload to the model — only meta.
  return {
    ok: true,
    summary: `Unlocked ${used.kind} «${used.label}» for site use (secret not shown)`,
    data: {
      secret_id: secretId,
      kind: used.kind,
      label: used.label,
      site: used.site,
    },
  };
}

async function askUserTool(
  args: Record<string, unknown>,
  _ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const prompt =
    typeof args.prompt === "string"
      ? args.prompt.trim()
      : typeof args.text === "string"
        ? args.text.trim()
        : "";
  if (!prompt) {
    return { ok: false, summary: "ask_user requires prompt" };
  }
  return {
    ok: true,
    summary: prompt,
    needsUser: true,
    data: {
      prompt,
      choices: Array.isArray(args.choices) ? args.choices : [],
    },
  };
}

const HANDLERS: Record<string, MissionToolHandler> = {
  "browser.navigate": browserNavigate,
  "browser.click": browserClick,
  "browser.type": browserType,
  "browser.type_secret": browserType,
  "browser.extract": browserExtract,
  "browser.observe": browserObserve,
  "browser.wait": browserWait,
  "browser.scroll": browserScroll,
  "browser.select": browserSelect,
  "browser.press": browserPress,
  "browser.screenshot": browserScreenshot,
  "browser.submit": browserSubmit,
  [WEB_SEARCH_TOOL]: webSearchTool,
  "vault.ask_and_store": vaultAskAndStore,
  "vault.use": vaultUseTool,
  "payment.prepare": paymentPrepare,
  "payment.charge": paymentCharge,
  ask_user: askUserTool,
};

export async function runMissionTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const handler = HANDLERS[tool];
  if (!handler) {
    return { ok: false, summary: `Unknown tool: ${tool}` };
  }
  return handler(args, ctx);
}

export function listKnownMissionTools(): string[] {
  return Object.keys(HANDLERS);
}
