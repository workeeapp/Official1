import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Built Vite SPA (`frontend/dist`). Optional FRONTEND_DIST override for tests/ops.
 * Returns null when the build is missing — API still runs; public UI is unavailable.
 */
export function resolveFrontendDist(): string | null {
  const fromEnv = process.env.FRONTEND_DIST?.trim();
  if (fromEnv) {
    const absolute = path.resolve(fromEnv);
    return existsSync(path.join(absolute, "index.html")) ? absolute : null;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "frontend", "dist"),
    path.resolve(process.cwd(), "..", "frontend", "dist"),
    // tsx: backend/src/utils → repo root
    path.resolve(here, "..", "..", "..", "frontend", "dist"),
    // compiled: backend/dist/utils → repo root
    path.resolve(here, "..", "..", "..", "..", "frontend", "dist"),
  ];

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}
