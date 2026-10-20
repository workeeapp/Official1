import "dotenv/config";
import {
  defaultGtfsPaths,
  isGtfsDbFresh,
  resolveRepoRoot,
  syncMotGtfs,
} from "../services/gtfs-store.js";

const paths = defaultGtfsPaths(resolveRepoRoot());
const reuse = process.argv.includes("--reuse-zip");
console.log(
  reuse
    ? "Re-importing MOT GTFS from existing zip/raw…"
    : "Downloading MOT GTFS…",
  paths.rootDir,
);
await syncMotGtfs(paths, { skipDownloadIfPresent: reuse });
console.log(
  "GTFS ready at",
  paths.dbPath,
  "fresh=",
  isGtfsDbFresh(paths.dbPath),
);
