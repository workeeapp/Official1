/**
 * Filing intent + destination — prompt contract (offline, no model / DB).
 * Behavior is measured by filing-destination.live-sendchat.eval-db.test.ts;
 * this pins that both the system rules and the runtime ATTACHMENTS rule carry
 * the CONTENT-FIRST requirements.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = (JSON.parse(readFileSync(resolve(process.cwd(), "..", "LLM.config.json"), "utf8")) as {
  systemMessage: string[];
}).systemMessage.join("\n");
const chat = readFileSync(resolve(process.cwd(), "src/services/chat.service.ts"), "utf8");

describe("CONTENT-FIRST filing destination", () => {
  it("system ATTACHMENTS: understand file + instruction; the instruction is never saved as a row", () => {
    expect(config).toContain("CONTENT-FIRST DESTINATION");
    expect(config).toContain("The instruction is not content: FORBIDDEN saving the instruction sentence");
  });

  it("system ATTACHMENTS: an existing home wins; new only when nothing fits; ask when several fit or nothing identifies it", () => {
    expect(config).toContain("EXISTING HOME FIRST");
    expect(config).toContain("FORBIDDEN creating a new row next to it");
    expect(config).toContain("Several plausible → ask which (numbered)");
    expect(config).toContain("NEW only when nothing fits");
    expect(config).toContain("Neither the file's content nor the instruction identifies a destination → ask");
  });

  it("system ATTACHMENTS: a task is a home only when the file is material for that task", () => {
    expect(config).toContain("A task is a home only when the file is material for THAT task");
    expect(config).toContain("FORBIDDEN attaching files to an existing task by default");
  });

  it("system ATTACHMENTS: no duplicates", () => {
    expect(config).toContain("a file already attached to a saved row is not filed again");
    expect(config).toContain("FORBIDDEN a second row with the same content or name as an existing one");
  });

  it("FILING document rule: existing filing first; new name = what the document is", () => {
    expect(config).toContain("an existing filing for it → update that filing + attachment_ids");
    expect(config).toContain("naming what the document is (never the instruction sentence)");
  });

  it("runtime ATTACHMENTS_RULE and FILING rule carry the same requirements", () => {
    expect(chat).toContain("CONTENT-FIRST (system ATTACHMENTS)");
    expect(chat).toContain("the instruction sentence is never saved as a row");
    expect(chat).toContain("a task only when the file is material for THAT task");
    expect(chat).toContain("never re-file a file already attached");
    expect(chat).toContain("filings per CONTENT-FIRST (an existing filing first; a new one only when nothing fits)");
  });

  it("the old keyword-only filing gate is gone", () => {
    expect(config).not.toContain("(A) filings — לתיוקים / «תחת…» / «כ…» new title, OR");
    expect(chat).not.toContain("(A) filings — only לתיוקים");
    expect(chat).not.toContain("filings only when «לתיוקים»");
  });
});
