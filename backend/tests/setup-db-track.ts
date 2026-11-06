/**
 * db track guard (vitest.db.config.ts): fail closed before any test when the
 * database is not the approved test DB. A missing approval is a FAIL, not a skip.
 */
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";

assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
