import type {
  AdminCodeChangesResponse,
  AdminMonitoringResponse,
  AdminSetAdminResponse,
  AdminUserRow,
  AdminUsersResponse,
} from "@workee/shared";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import {
  countRecentOpsFailures,
  listRecentOpsFailures,
} from "./ops-monitor.service.js";
import {
  formatGitChangelogForCompose,
  readGitChangelog,
} from "./git-changelog.js";

function toAdminUserRow(row: {
  id: string;
  username: string;
  isAdmin: boolean;
}): AdminUserRow {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin === true,
  };
}

export async function getAdminMonitoring(): Promise<AdminMonitoringResponse> {
  const env = getEnv();
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const recentFailures = await listRecentOpsFailures(20);
  const failuresLastHour = await countRecentOpsFailures(60 * 60 * 1000);

  return {
    health: {
      status: db ? "ok" : "degraded",
      db,
      openaiConfigured: Boolean(env.OPENAI_API_KEY?.trim()),
      whatsappConfigured: Boolean(env.WHATSAPP_ACCESS_TOKEN?.trim()),
      opsAlertConfigured: Boolean(env.OPS_ALERT_PHONES?.trim()),
      opsAlertMode: env.OPS_ALERT_MODE,
    },
    failuresLastHour,
    recentFailures: recentFailures.map((row) => ({
      at: row.at,
      step: row.step,
      detail: row.detail,
      alertKey: row.alertKey,
    })),
  };
}

export async function getAdminCodeChanges(
  lookbackHours = 24,
): Promise<AdminCodeChangesResponse> {
  const hours = Math.min(Math.max(lookbackHours, 1), 720);
  const sinceDate = new Date(Date.now() - hours * 60 * 60 * 1000);
  const { headSha, commits } = await readGitChangelog({
    sinceDate,
    maxCount: 80,
  });
  return {
    headSha,
    lookbackHours: hours,
    commits,
    summaryText: formatGitChangelogForCompose(commits),
  };
}

export async function listAdminUsers(): Promise<AdminUsersResponse> {
  const rows = await prisma.user.findMany({
    orderBy: { username: "asc" },
    select: { id: true, username: true, isAdmin: true },
  });
  return { users: rows.map(toAdminUserRow) };
}

export async function setAdminUserFlag(
  targetUserId: string,
  isAdmin: boolean,
): Promise<AdminSetAdminResponse> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, isAdmin: true },
  });
  if (!target) {
    throw new NotFoundError("User not found.");
  }

  if (target.isAdmin === isAdmin) {
    return { user: toAdminUserRow(target) };
  }

  if (!isAdmin) {
    const adminCount = await prisma.user.count({
      where: { isAdmin: true },
    });
    if (adminCount <= 1) {
      throw new ValidationError("Cannot revoke the last admin.");
    }
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { isAdmin },
    select: { id: true, username: true, isAdmin: true },
  });
  return { user: toAdminUserRow(updated) };
}
