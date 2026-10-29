import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLlmConfig, loadLlmResponseFormat } from "../src/config/llm.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("LLM action schema", () => {
  it("omits emoji from the lists[] skeleton so models do not echo null clears", () => {
    const action = JSON.parse(
      readFileSync(resolve(repoRoot, "LLM.action.json"), "utf8"),
    ) as { systemMessage: string[] };
    const system = action.systemMessage.join("\n");
    // Skeleton field form (would be copied into alter_list and clear overrides).
    expect(system).not.toMatch(/"emoji":\s*null/);
    // Clear remains documented; omit = no change.
    expect(system).toContain("emoji:null");
    expect(system).toMatch(/OMIT emoji/i);
    // Schema still allows string|null for intentional clear.
    const format = loadLlmResponseFormat(repoRoot);
    const emojiProp = (
      format?.schema.properties as {
        metadata?: {
          properties?: {
            lists?: {
              items?: { properties?: { emoji?: { type?: unknown } } };
            };
          };
        };
      }
    )?.metadata?.properties?.lists?.items?.properties?.emoji;
    expect(emojiProp?.type).toEqual(["string", "null"]);
  });

  it("loads Lucy json_schema from LLM.action.json", () => {
    const format = loadLlmResponseFormat(repoRoot);

    expect(format).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
      strict: false,
    });
    expect(format?.schema.required).toEqual(["responses", "metadata"]);
    expect(format?.schema.properties).toMatchObject({
      responses: {
        type: "array",
        minItems: 1,
        items: { type: "object" },
      },
      metadata: { type: "object" },
    });
    const responseItems = (
      format?.schema.properties as {
        responses?: { items?: { properties?: Record<string, unknown> } };
      }
    )?.responses?.items;
    expect(responseItems?.properties).toMatchObject({
      text: { type: "string" },
    });

    const jobsItems = (
      format?.schema.properties as {
        metadata?: {
          properties?: {
            jobs?: {
              items?: {
                properties?: Record<string, unknown>;
                required?: string[];
              };
            };
          };
        };
      }
    )?.metadata?.properties?.jobs?.items;
    expect(jobsItems?.required).toEqual(
      expect.arrayContaining(["action", "job_id"]),
    );
    expect(jobsItems?.properties).toMatchObject({
      action: { type: "string" },
      job_id: { type: "string" },
      answer_text: { type: "string" },
      report_text: { type: "string" },
    });
  });

  /**
   * File prompt only (`loadLlmConfig` → LLM.config.json).
   * Runtime extras (SHAREABLE STATUS ASK, FULL DUMP DETAIL, LIVE DATA listing forbid, …)
   * → chat.test «wires … Lucy runtime instructions».
   * SESSION_CLOCK / RECURRING WHEN → relative-date.test + recurrence.test.
   */
  it("attaches the schema when loading Lucy config", () => {
    const config = loadLlmConfig(repoRoot);

    expect(config.responseFormat?.name).toBe("lucy_metadata_response");
    expect(config.systemMessage).toContain("metadata");
    expect(config.systemMessage).toContain("FORBIDDEN: metadata.query");
    expect(config.systemMessage).toContain("SHOW / LIVE DATA ONLY");
    expect(config.systemMessage).toContain("Status/inventory");
    expect(config.systemMessage).toContain("LIVE DATA ONLY");
    expect(config.systemMessage).toContain("באחריות X · מאת Y");
    expect(config.systemMessage).toContain(
      "show_dump=tasks + show_dump_about=YOUR display name",
    );
    expect(config.systemMessage).toContain("אין לי מטלות");
    expect(config.systemMessage).toContain("FORBIDDEN model-written");
    expect(config.systemMessage).toContain("show_dump_about");
    expect(config.systemMessage).toContain("show_dump_assignee");
    expect(config.systemMessage).toContain("show_dump_from");
    expect(config.systemMessage).toContain("show_dump_urgency");
    expect(config.systemMessage).toContain("LIST NAME MATCH");
    expect(config.systemMessage).toContain("WORKER_SAVED_DATA");
    expect(config.systemMessage).toContain("compose_source");
    expect(config.systemMessage).toContain("RECENT_OUTBOUND");
    expect(config.systemMessage).toContain(
      "FORBIDDEN past-tense success for an action absent from this turn's metadata",
    );
    expect(config.systemMessage).toContain("היום/מחר/אתמול");
    expect(config.systemMessage).toContain("RETRIEVAL CONTRACT");
    expect(config.systemMessage).toContain("FULL INVENTORY / date-window agenda");
    expect(config.systemMessage).toContain("show_dump_from/to");
    expect(config.systemMessage).toContain(
      "FORBIDDEN model-written agenda for this path",
    );
    expect(config.systemMessage).toContain("SAME-KIND SEMANTIC");
    expect(config.systemMessage).toContain("no free-built inventory/agenda");
    expect(config.systemMessage).not.toContain("confirm_share");
    expect(config.systemMessage).not.toContain("PENDING_ACTION_STATE");
    expect(config.systemMessage).toContain("תגידי לטל לקנות");
    expect(config.systemMessage).toContain("APPOINTMENT VS PING");
    expect(config.systemMessage).toContain("PERSONAL TASK DEFAULT");
    expect(config.systemMessage).toContain("BY LINE NUMBER (critical)");
    expect(config.systemMessage).toContain("שתף 1,2 עם מיכל");
    expect(config.systemMessage).toContain("item-level wins per row");
    expect(config.systemMessage).toContain("לא מופיע פריט N");
    expect(config.systemMessage).toContain("Never copy a different dump line's id");
    expect(config.systemMessage).toContain(
      "Past-tense «שיתפתי» ONLY when this turn emits those updates",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN show_dump on any line-index turn",
    );
    expect(config.systemMessage).toContain("item_id");
    expect(config.systemMessage).toContain("filing_id");
    expect(config.systemMessage).toContain("reminder_id");
    expect(config.systemMessage).toContain("share_book");
    expect(config.systemMessage).toContain("URGENCY FOLLOW-UP");
    expect(config.systemMessage).toContain("intentional PRODUCT CONTRACT");
    expect(config.systemMessage).toContain("COMPLEX EVENT TOPIC vs ORGANIZE INTENT");
    expect(config.systemMessage).toContain("DYNAMIC AXES");
    expect(config.systemMessage).not.toContain("DELETE CONFIRM (critical —");
  });

  it("encodes multi-shell clear ASK and same-turn custom list_name alignment", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("SAME-TURN CREATE+LINK");
    expect(config.systemMessage).toContain(
      "lists.add.list_name AND linked_lists[].list_name MUST both be the same non-empty",
    );
    expect(config.systemMessage).toContain(
      "A name only on the link side does NOT substitute for lists.add.list_name",
    );
    expect(config.systemMessage).toContain("MULTI-SHELL CLEAR");
    expect(config.systemMessage).toContain("נקה את הקניות");
    expect(config.systemMessage).toContain(
      "FORBIDDEN removing items from more than one shell",
    );
  });

  it("FILING address example must not be blocked by unknown SPEAKER_ADDRESS gender", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain(
      "תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב",
    );
    expect(config.systemMessage).toMatch(
      /SPEAKER_ADDRESS gender:\s*unknown must NOT block/i,
    );
  });

  it("teaches model-owned LIST/collab nav with engine validation", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("LIST BUTTON / COLLAB NAV — MODEL");
    expect(config.systemMessage).toContain("Engine validates against applied save");
    expect(config.systemMessage).toContain("«הצג קניות»");
    expect(config.systemMessage).toContain("«הצג מטלות»");
    expect(config.systemMessage).toContain("«הצג אנשי קשר»");
    expect(config.systemMessage).toContain("«הצג תיוקים»");
    expect(config.systemMessage).toContain('label «הצג רשימה»');
    expect(config.systemMessage).toContain(
      "After remove → list button only",
    );
    expect(config.systemMessage).toContain(
      "never invents collab or item-open",
    );
  });

  it("reminder confirm buttons: omit אצלך twin for same-day appointment/תור", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("יום ג׳ אצלך");
    expect(config.systemMessage).toContain("מה יש לך ביום שלישי");
    expect(config.systemMessage).toContain(
      "Omit (1) when the nudged item is a speaker meeting/appointment/תור",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN two buttons that only rename the same weekday",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN pairing it with «יום ד׳ אצלך»",
    );
    expect(config.systemMessage).toContain('label «התור»');
  });

  it("requires item-open POST-MUTATE when title uniquely opens the row", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("ITEM OPEN");
    expect(config.systemMessage).toContain(
      "UNIQUELY identifies that row",
    );
    expect(config.systemMessage).toContain(
      "הציגי את המטלה <exact שם מטלה>",
    );
    expect(config.systemMessage).toContain(
      "הציגי את התיוק <exact item_name>",
    );
    expect(config.systemMessage).toContain("להצגת המטלה");
    expect(config.systemMessage).toContain("להצגת התיוק");
    expect(config.systemMessage).toContain(
      "Shopping / contacts / custom → LIST nav only (no item-open)",
    );
    expect(config.systemMessage).toContain(
      "Duplicate/ambiguous title → no item-open",
    );
    expect(config.systemMessage).toContain("ITEM DUMP");
    expect(config.systemMessage).toContain("show_dump_ids");
  });

  it("teaches filing inventory show_dump vs unique filing ITEM DUMP", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("FILING SHOW");
    expect(config.systemMessage).toContain("show_dump=filings");
    expect(config.systemMessage).toContain(
      "FORBIDDEN model-written numbered filing inventory",
    );
    expect(config.systemMessage).toContain("Unique filing lookup");
    expect(config.systemMessage).toContain("SAME as ITEM DUMP");
    expect(config.systemMessage).toContain("show_dump_ids=[that filing_id]");
    expect(config.systemMessage).toContain(
      "FORBIDDEN model prose that restates item_info",
    );
    expect(config.systemMessage).toContain(
      "bold only the item title with a single WhatsApp pair *title*",
    );
  });

  it("T7: teaches RETRIEVAL CONTRACT — full vs same-kind semantic vs cross-kind vs time-of-day", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("RETRIEVAL CONTRACT");
    expect(config.systemMessage).toContain("FULL INVENTORY / date-window agenda");
    expect(config.systemMessage).toContain("SAME-KIND SEMANTIC");
    expect(config.systemMessage).toContain("INTENT→ACTION");
    expect(config.systemMessage).toContain("focused single-record lookup");
    expect(config.systemMessage).toContain(
      "show_dump=<kind> + show_dump_ids=[all matching ids]",
    );
    expect(config.systemMessage).toContain("FORBIDDEN parallel prose inventory");
    expect(config.systemMessage).toContain(
      "does NOT rewrite the dump with a computed next fire",
    );
    expect(config.systemMessage).toContain(
      "inventing a concrete next occurrence in responses",
    );
    expect(config.systemMessage).toContain("no free-built inventory/agenda");
    expect(config.systemMessage).toContain("CROSS-KIND SEMANTIC");
    expect(config.systemMessage).toContain("existing rows only");
    expect(config.systemMessage).toContain("TIME-OF-DAY");
    expect(config.systemMessage).toContain("PARTIAL CONTEXT");
    expect(config.systemMessage).toContain(
      "does NOT guarantee every relevant candidate",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN bare show_dump without ids for a semantic/focused ask",
    );
    expect(config.systemMessage).not.toContain("show_dump_ids (required)");
    // Phone book parity: path 2 uses phone_book + SPEAKER_CONTACTS; path 3 includes contacts.
    expect(config.systemMessage).toContain("phone_book|filings|reminders");
    expect(config.systemMessage).toContain(
      "copy contact_id from SPEAKER_CONTACTS",
    );
    expect(config.systemMessage).toContain(
      "AND SPEAKER_CONTACTS: pick opaque row ids",
    );
    expect(config.systemMessage).toContain(
      "directory.update with those contact_ids",
    );
  });

  it("requires two-entry soft reminder offer after tasks add without explicit ping", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain(
      "POST-SAVE REMINDER OFFER vs EXPLICIT REMINDER",
    );
    expect(config.systemMessage).toContain("Branch B — TASK ONLY");
    expect(config.systemMessage).toContain(
      "TWO separate WhatsApp messages",
    );
    expect(config.systemMessage).toContain(
      "NEVER choose between navigation and כן/לא",
    );
    expect(config.systemMessage).toContain(
      "רוצה שאוסיף גם תזכורת למטלה הזו?",
    );
    expect(config.systemMessage).toContain(
      "כן without a complete reminder schedule → ask schedule only",
    );
  });

  it("teaches explicit same-turn reminder skips soft offer", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain(
      "Branch A — EXPLICIT REMINDER SAME TURN",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN soft-offer bubble",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN כן/לא for a reminder they already requested",
    );
    expect(config.systemMessage).toContain(
      "NEVER claim a תזכורת was created",
    );
    expect(config.systemMessage).toContain(
      "Branch A: create the clock now; FORBIDDEN soft-offer כן/לא",
    );
    expect(config.systemMessage).toContain(
      "Same-turn explicit path = POST-SAVE Branch A",
    );
  });

  it("teaches סמן כבוצע button as same finished-chore path", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("סמן כבוצע: <title>");
    expect(config.systemMessage).toContain("SAME path as spoken finished-chore");
    expect(config.systemMessage).toContain("ITEM DUMP");
    expect(config.systemMessage).toContain("סמן כבוצע");
  });

  it("teaches item dump with server-attached task reminder buttons", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("ITEM DUMP");
    expect(config.systemMessage).toContain("show_dump_ids");
    expect(config.systemMessage).toContain("הוסף/עדכן תזכורת");
    expect(config.systemMessage).toContain(
      "LAST_NUMBERED_DUMP for line numbers",
    );
    expect(config.systemMessage).toContain(
      "never the full list",
    );
    expect(config.systemMessage).toContain(
      "Add-reminder button «הוסף תזכורת: <title>»",
    );
    expect(config.systemMessage).toContain(
      "Update-reminder button «עדכן תזכורת: <title>»",
    );
  });

  it("ITEM DUMP ambiguity → ASK with null ids (prompt contract; not live model)", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("ITEM DUMP");
    expect(config.systemMessage).toContain(
      "Ambiguous / ids not in THIS turn's JSON → ASK, show_dump/ids null",
    );
    expect(config.systemMessage).toContain("Forbidden inventing ids");
    expect(config.systemMessage).toContain(
      "ids must match that kind (FORBIDDEN cross-kind ids)",
    );
    expect(config.systemMessage).toContain(
      "Cross-kind topic → show_dump=full + semantically matching row ids",
    );
    expect(config.systemMessage).toContain(
      "not every sibling on a topic-named list",
    );
    // Offline MODEL_APPLY stubs author the ACTION; they cannot prove a live model
    // asks instead of picking one of two similar tasks. No LIVE run here.
  });
});
