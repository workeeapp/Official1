import {
  formatGitChangelogForCompose,
  readGitChangelog,
  resolveGitDigestWindow,
} from "./git-changelog.js";
import {
  formatEmployeeContext,
  getEmployeeRecordSnapshot,
} from "./employee-records.service.js";
import {
  formatSpeakerContacts,
  listContactsForEmployee,
} from "./contact.service.js";
import { formatSessionClockContext } from "../utils/relative-date.js";

export type ComposeSourceKind = "" | "git_log" | "saved_data";

/**
 * Fire-time facts for compose clocks. Sources differ only in how facts are
 * loaded; the outbound LLM call is shared.
 */
export type ComposeFactsBundle = {
  kind: "git_log" | "saved_data" | "creative";
  /** Internal facts block (git commits, EMPLOYEE_SAVED_DATA, …). */
  facts: string;
  /** Short label shown above facts in the compose message. */
  factsLabel: string;
  sessionClock?: string;
  windowLabel?: string;
  /** Skip the LLM and send this body (e.g. empty git window). */
  fixedBody?: string;
  headSha?: string;
  advanceLastReportSha?: boolean;
};

export async function loadComposeFacts(input: {
  composeSource: string;
  subjectEmployeeId: string;
  repeat: string;
  lastReportSha?: string | null;
  lookbackHours?: number | null;
  now?: Date;
}): Promise<ComposeFactsBundle> {
  const source = input.composeSource.trim();
  if (source === "git_log") {
    const lookbackHours =
      typeof input.lookbackHours === "number" ? input.lookbackHours : 0;
    const window = resolveGitDigestWindow({
      repeat: input.repeat,
      lastReportSha: input.lastReportSha,
      lookbackHours,
      now: input.now,
    });
    const log = await readGitChangelog({
      sinceSha: window.sinceSha,
      sinceDate: window.sinceDate,
    });
    const facts = formatGitChangelogForCompose(log.commits);
    if (!facts) {
      return {
        kind: "git_log",
        facts: "",
        factsLabel: "Commit notes",
        windowLabel: window.windowLabel,
        fixedBody: "No new product changes in that window.",
        headSha: log.headSha,
        advanceLastReportSha: window.advanceLastReportSha,
      };
    }
    return {
      kind: "git_log",
      facts,
      factsLabel: "Commit notes (internal source — do not paste verbatim as a log)",
      windowLabel: window.windowLabel,
      headSha: log.headSha,
      advanceLastReportSha: window.advanceLastReportSha,
    };
  }

  if (source === "saved_data") {
    const snapshot = await getEmployeeRecordSnapshot(input.subjectEmployeeId);
    const contacts = await listContactsForEmployee(input.subjectEmployeeId);
    const facts = [
      formatEmployeeContext(snapshot),
      formatSpeakerContacts(contacts),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "saved_data",
      facts,
      factsLabel: "Saved facts (internal — answer from these only)",
      sessionClock: formatSessionClockContext(),
    };
  }

  return {
    kind: "creative",
    facts: "",
    factsLabel: "",
  };
}
