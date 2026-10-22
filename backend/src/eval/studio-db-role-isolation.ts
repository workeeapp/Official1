/**
 * LIVE_FULL database-role isolation probe.
 *
 * Env URL gates alone cannot prove the connected Postgres role is unable to
 * open the product database. This module runs a read-only privilege check on
 * the already-approved connection (no writes, no product connection attempt).
 *
 * Pure interpretation is unit-tested offline with injected snapshots; the
 * default querier uses Prisma only when LIVE_FULL actually runs.
 */
import { prisma } from "../database/prisma.js";
import {
  LIVE_FULL_REQUIRED_DATABASE_NAME,
  UnapprovedEvalDatabaseError,
} from "./studio-db-guard.js";

/** Product DB identity that LIVE_FULL must not be able to CONNECT to. */
export const LIVE_FULL_PRODUCT_DATABASE_NAME = "workee";

export type LiveFullDbRoleIsolationSnapshot = {
  /** current_database() on the open connection. */
  currentDatabase: string;
  /** Whether a database named like the product identity exists on this cluster. */
  productDatabaseExists: boolean;
  /** has_database_privilege(current_user, product, 'CONNECT') when product exists. */
  canConnectProduct: boolean;
};

export type LiveFullDbRoleIsolationVerdict =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

/**
 * Interpret a privilege snapshot. Pure — never connects.
 * Isolation is PROVEN only when the product DB exists and CONNECT is false,
 * or when the product DB is absent on this cluster (nothing to reach).
 */
export function interpretLiveFullDbRoleIsolation(
  snap: LiveFullDbRoleIsolationSnapshot,
  options?: {
    requiredDatabaseName?: string;
    productDatabaseName?: string;
  },
): LiveFullDbRoleIsolationVerdict {
  const required =
    options?.requiredDatabaseName ?? LIVE_FULL_REQUIRED_DATABASE_NAME;
  const product =
    options?.productDatabaseName ?? LIVE_FULL_PRODUCT_DATABASE_NAME;
  const current = String(snap.currentDatabase ?? "").trim();

  if (!current) {
    return {
      ok: false,
      detail: "current_database() returned empty; refusing LIVE_FULL",
    };
  }
  if (current.toLowerCase() === product.toLowerCase()) {
    return {
      ok: false,
      detail: `connected database is product identity '${product}'; refusing LIVE_FULL`,
    };
  }
  if (current !== required) {
    return {
      ok: false,
      detail: `LIVE_FULL requires connected database '${required}' (got '${current}'); refusing`,
    };
  }
  if (snap.productDatabaseExists && snap.canConnectProduct) {
    return {
      ok: false,
      detail:
        `current Postgres role can CONNECT to product database '${product}' — ` +
        "DB role isolation NOT PROVEN; LIVE_FULL requires a dedicated test role " +
        "with no CONNECT (or write) on the product database",
    };
  }
  if (snap.productDatabaseExists) {
    return {
      ok: true,
      detail: `role cannot CONNECT to product database '${product}' while on '${required}'`,
    };
  }
  return {
    ok: true,
    detail: `product database '${product}' absent on this cluster; connected to '${required}'`,
  };
}

export type LiveFullDbRoleIsolationQuerier =
  () => Promise<LiveFullDbRoleIsolationSnapshot>;

/**
 * Read-only privilege probe against the current Prisma connection.
 * Does not CONNECT to the product database — only asks the catalog.
 */
export async function queryLiveFullDbRoleIsolationViaPrisma(): Promise<LiveFullDbRoleIsolationSnapshot> {
  const product = LIVE_FULL_PRODUCT_DATABASE_NAME;
  const rows = await prisma.$queryRaw<
    Array<{
      current_database: string;
      product_exists: boolean;
      can_connect_product: boolean | null;
    }>
  >`
    SELECT
      current_database() AS current_database,
      EXISTS (
        SELECT 1 FROM pg_database WHERE datname = ${product}
      ) AS product_exists,
      CASE
        WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = ${product})
        THEN has_database_privilege(current_user, ${product}, 'CONNECT')
        ELSE FALSE
      END AS can_connect_product
  `;
  const row = rows[0];
  if (!row) {
    throw new UnapprovedEvalDatabaseError(
      "LIVE_FULL DB role isolation probe returned no rows; refusing",
    );
  }
  return {
    currentDatabase: String(row.current_database ?? ""),
    productDatabaseExists: Boolean(row.product_exists),
    canConnectProduct: Boolean(row.can_connect_product),
  };
}

/**
 * Fail closed unless the connected role is isolated from the product DB.
 * Inject `query` in offline tests — default uses Prisma (LIVE_FULL only).
 */
export async function assertLiveFullDbRoleIsolation(
  query: LiveFullDbRoleIsolationQuerier = queryLiveFullDbRoleIsolationViaPrisma,
): Promise<void> {
  const snap = await query();
  const verdict = interpretLiveFullDbRoleIsolation(snap);
  if (!verdict.ok) {
    throw new UnapprovedEvalDatabaseError(
      `LIVE_FULL DB role isolation blocked: ${verdict.detail}`,
    );
  }
}
