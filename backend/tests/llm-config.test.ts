import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadLlmConfig, loadLlmResponseFormat } from "../src/config/llm.js";

const repoRoot = resolve(import.meta.dirname, "../..");

type JsonSchemaNode = {
  type?: unknown;
  enum?: unknown;
  minimum?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  additionalProperties?: unknown;
};

function listsItemSchema(): JsonSchemaNode {
  const format = loadLlmResponseFormat(repoRoot);
  const lists = (
    format?.schema.properties as {
      metadata?: { properties?: { lists?: JsonSchemaNode } };
    }
  )?.metadata?.properties?.lists;
  const listEntry = lists?.items;
  const itemProps = listEntry?.properties?.items?.items;
  if (!itemProps?.properties) {
    throw new Error("lists[].items[] schema missing");
  }
  return itemProps;
}

function listsEntrySchema(): JsonSchemaNode {
  const format = loadLlmResponseFormat(repoRoot);
  const lists = (
    format?.schema.properties as {
      metadata?: { properties?: { lists?: JsonSchemaNode } };
    }
  )?.metadata?.properties?.lists;
  const listEntry = lists?.items;
  if (!listEntry?.properties) {
    throw new Error("lists[] entry schema missing");
  }
  return listEntry;
}

/** Mirrors stage-1 optional intent fields (schema contract; not engine behavior). */
const intentItemFields = z.object({
  mutate_source: z.enum(["dump_line", "saved_data"]).optional(),
  dump_line: z.number().min(1).optional(),
  dump_section: z.union([z.string(), z.null()]).optional(),
  item_id: z.string().optional(),
});

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
    expect(config.systemMessage).toContain("אין לי משימות");
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
    expect(config.systemMessage).toContain("SPEAKER TASKS / date-window agenda");
    expect(config.systemMessage).toContain("show_dump_from/to");
    expect(config.systemMessage).toContain(
      "FORBIDDEN model-written agenda.",
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
    expect(config.systemMessage).toContain("«הצג משימות»");
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

  it("reminder confirm buttons: the reminder + the speaker's content — never Lucy's book (owner 2026-11-10)", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("FORBIDDEN any button to YOUR book");
    expect(config.systemMessage).not.toContain('{label:"יום ג׳ אצלך", command:"מה יש לך ביום שלישי"}');
    expect(config.systemMessage).toContain('label «התור»');
  });

  it("requires item-open POST-MUTATE when title uniquely opens the row", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("ITEM OPEN");
    expect(config.systemMessage).toContain(
      "UNIQUELY identifies that row",
    );
    expect(config.systemMessage).toContain(
      "הציגי את המשימה <exact שם משימה>",
    );
    expect(config.systemMessage).toContain(
      "הציגי את התיוק <exact item_name>",
    );
    expect(config.systemMessage).toContain("להצגת המשימה");
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
    expect(config.systemMessage).toContain("SPEAKER TASKS / date-window agenda");
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
    // Meetings-this-week must be path-2 dump+ids (server REPLACE), not prose.
    expect(config.systemMessage).toContain("אילו פגישות יש לי השבוע");
    expect(config.systemMessage).toContain(
      "FORBIDDEN model-written meeting inventory",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN prose meeting list",
    );
    expect(config.systemMessage).toContain("MEETING ≠ NUDGE");
    expect(config.systemMessage).toContain(
      "dated message ≠ meeting",
    );
    expect(config.systemMessage).toContain("לשלוח נדנוד");
    expect(config.systemMessage).toContain("ברכת בוקר");
    // List-shell post-mutate overview button (not item mutates).
    expect(config.systemMessage).toContain("LIST SHELL SHOW");
    expect(config.systemMessage).toContain('label «הצג רשימות»');
    expect(config.systemMessage).toContain(
      "FORBIDDEN this button after item-level lists.add|update|remove alone",
    );
    // 2026-11-05: share/alter/create → THAT list (header proves the share);
    // overview only after delete_list.
    expect(config.systemMessage).toContain(
      "FORBIDDEN «הצג רשימות» after create/alter_list",
    );
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
      "רוצה שאוסיף גם תזכורת למשימה הזו?",
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

  it("teaches interval habit Done as ack-only and snooze Option B one-shot", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("INTERVAL HABIT OCCURRENCE DONE");
    expect(config.systemMessage).toContain("שתיתי");
    expect(config.systemMessage).toContain(
      "FORBIDDEN lists.remove / reminders.remove (series stays",
    );
    expect(config.systemMessage).toContain("Option B — separate one-shot");
    expect(config.systemMessage).toContain(
      "NEVER reminders.update / change fireAt or recurrence on the source interval",
    );
    expect(config.systemMessage).toContain("reschedule in place");
    expect(config.systemMessage).toContain("within 2 minutes of the next fireAt");
  });

  it("teaches STOP SERIES CLOCK CANCEL vs Done vs blanket stop-all", () => {
    const config = loadLlmConfig(repoRoot);
    expect(config.systemMessage).toContain("STOP SERIES CLOCK CANCEL");
    expect(config.systemMessage).toContain("תפסיקי להזכיר לי");
    expect(config.systemMessage).toContain("אל תזכירי לי יותר");
    expect(config.systemMessage).toContain("תבטלי את התזכורת");
    expect(config.systemMessage).toContain(
      "אל תשלחי לי יותר הודעות תזכורת",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN reminders.remove of even one clock",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN treating Done as STOP SERIES",
    );
    expect(config.systemMessage).toContain("MUST EMIT ACTION");
    expect(config.systemMessage).toContain("אל תזכירי לי יותר לשתות מים");
    expect(config.systemMessage).toContain("RIGHT AFTER A REMINDER PING");
    expect(config.systemMessage).toContain("RECENT_OUTBOUND.reminder_id");
    expect(config.systemMessage).toContain("תפסיקי להזכיר לי את זה");
    expect(config.systemMessage).toContain(
      "FORBIDDEN inventing an id",
    );
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

describe("LLM action schema — stage-1 intent source fields (optional)", () => {
  it("declares mutate_source / dump_line / dump_section on lists[].items[] without requiring them", () => {
    const item = listsItemSchema();
    const props = item.properties!;
    for (const key of ["mutate_source", "dump_line", "dump_section"] as const) {
      expect(item.required ?? []).not.toContain(key);
    }
    expect(props.mutate_source).toMatchObject({
      type: "string",
      enum: ["dump_line", "saved_data"],
    });
    expect(String(props.mutate_source?.description ?? "")).toContain(
      "Absence is NOT saved_data",
    );
    expect(props.dump_line).toMatchObject({
      type: "number",
      minimum: 1,
    });
    expect(props.dump_section?.type).toEqual(["string", "null"]);
  });

  it("keeps list_id optional on lists[] and documents row-mutate use", () => {
    const entry = listsEntrySchema();
    expect(entry.required ?? []).not.toContain("list_id");
    expect(entry.properties?.list_id?.type).toBe("string");
    const desc = String(entry.properties?.list_id?.description ?? "");
    expect(desc).toMatch(/alter_list/);
    expect(desc).toMatch(/saved_data/);
    expect(desc).toMatch(/backward compatible/i);
  });

  it("accepts legacy items without intent fields and valid stage-1 combinations", () => {
    expect(intentItemFields.safeParse({ item_id: "legacy-uuid" }).success).toBe(
      true,
    );
    expect(
      intentItemFields.safeParse({
        mutate_source: "dump_line",
        dump_line: 3,
        dump_section: null,
      }).success,
    ).toBe(true);
    expect(
      intentItemFields.safeParse({
        mutate_source: "dump_line",
        dump_line: 1,
        dump_section: "2026-11-01",
      }).success,
    ).toBe(true);
    expect(
      intentItemFields.safeParse({
        mutate_source: "saved_data",
        item_id: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid mutate_source / dump_line / dump_section types", () => {
    expect(
      intentItemFields.safeParse({ mutate_source: "esd" }).success,
    ).toBe(false);
    expect(
      intentItemFields.safeParse({ mutate_source: "DUMP_LINE" }).success,
    ).toBe(false);
    expect(
      intentItemFields.safeParse({
        mutate_source: "dump_line",
        dump_line: 0,
      }).success,
    ).toBe(false);
    expect(
      intentItemFields.safeParse({
        mutate_source: "dump_line",
        dump_line: "3",
      }).success,
    ).toBe(false);
    expect(
      intentItemFields.safeParse({
        mutate_source: "dump_line",
        dump_line: 2,
        dump_section: 1,
      }).success,
    ).toBe(false);
  });

  it("does not teach mutate_source in systemMessage (prompt unchanged this stage)", () => {
    const action = JSON.parse(
      readFileSync(resolve(repoRoot, "LLM.action.json"), "utf8"),
    ) as { systemMessage: string[] };
    const system = action.systemMessage.join("\n");
    // systemMessage may mention show_dump_section; assert the new intent keys are absent.
    expect(system).not.toContain("mutate_source");
    expect(system).not.toContain('"dump_line"');
    expect(system).not.toContain('"dump_section"');
    expect(system).not.toContain("Absence is NOT saved_data");
  });
});
