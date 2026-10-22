import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLlmConfig, loadLlmResponseFormat } from "../src/config/llm.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("LLM action schema", () => {
  it("loads Lucy json_schema from LLM.action.json", () => {
    const format = loadLlmResponseFormat(repoRoot);

    expect(format).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
      strict: false,
    });
    expect(format?.schema.required).toEqual(["responses", "metadata"]);
    expect(format?.schema.properties).toMatchObject({
      responses: { type: "array", minItems: 1, items: { type: "string" } },
      metadata: { type: "object" },
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

  it("attaches the schema when loading Lucy config", () => {
    const config = loadLlmConfig(repoRoot);

    expect(config.responseFormat?.name).toBe("lucy_metadata_response");
    expect(config.systemMessage).toContain("metadata");
    expect(config.systemMessage).toContain("Do not emit metadata.query");
    expect(config.systemMessage).toContain("STATUS QUESTIONS");
    expect(config.systemMessage).toContain("LIVE DATA ONLY");
    expect(config.systemMessage).toContain(
      "FORBIDDEN: listing or naming items from earlier assistant/user messages",
    );
    expect(config.systemMessage).toContain("SHAREABLE STATUS ASK");
    expect(config.systemMessage).toContain("SHAREABLE STATUS ASK ABOUT X");
    expect(config.systemMessage).toContain("one flat list dump");
    expect(config.systemMessage).toContain("באחריות X · מאת Y");
    expect(config.systemMessage).toContain("ONE header per list");
    expect(config.systemMessage).toContain("No אישיות/משותפות list headers");
    expect(config.systemMessage).toContain("NUMBERED 1. 2. 3.");
    expect(config.systemMessage).toContain(
      "Numbering restarts at 1 for EVERY distinct list block",
    );
    expect(config.systemMessage).toContain("one flat dump + row marks");
    expect(config.systemMessage).toContain(
      "ONLY active_reminders NOT already shown via LINKED REMINDER",
    );
    expect(config.systemMessage).toContain("(קבוע + תזכורת)");
    expect(config.systemMessage).toContain(
      "FORBIDDEN a second «(תזכורת: …)» paren on that line",
    );
    expect(config.systemMessage).toContain("INVENTORY (critical)");
    expect(config.systemMessage).toContain(
      "show_dump=tasks + show_dump_about=YOUR display name",
    );
    expect(config.systemMessage).toContain(
      "show_dump=tasks WITHOUT show_dump_about",
    );
    expect(config.systemMessage).toContain("אין לי מטלות");
    expect(config.systemMessage).toContain(
      "NEVER show_dump=tasks without about",
    );
    expect(config.systemMessage).toContain("Set metadata.show_dump to that category");
    expect(config.systemMessage).toContain(
      "FULL DUMP / מה יש לי / הציגי הכל",
    );
    expect(config.systemMessage).toContain('show_dump = "full"');
    expect(config.systemMessage).toContain("FORBIDDEN model-written");
    expect(config.systemMessage).toContain("FULL DUMP DETAIL RULE");
    expect(config.systemMessage).toContain("COUNTS ONLY");
    expect(config.systemMessage).toContain("ONLY מטלות enumerate");
    expect(config.systemMessage).toContain("SHOW MY LISTS / הציגי את הרשימות שלי");
    expect(config.systemMessage).toContain('show_dump="full"');
    expect(config.systemMessage).toContain("לפירוט רשימה: הצג רשימת");
    expect(config.systemMessage).toContain("assigned_by");
    expect(config.systemMessage).toContain("show_dump_about");
    expect(config.systemMessage).toContain("show_dump_assignee");
    expect(config.systemMessage).toContain("show_dump_from");
    expect(config.systemMessage).toContain("OR WITHIN FIELD");
    expect(config.systemMessage).toContain("SAVE VERB ROUTING");
    expect(config.systemMessage).toContain(
      "DELETE WHEN CLEAR (rows / items / filings / contacts)",
    );
    expect(config.systemMessage).toContain("emit remove NOW with that id");
    expect(config.systemMessage).toContain(
      "FORBIDDEN «האם מאשר?» for a unique clear target",
    );
    expect(config.systemMessage).toContain("ASK WHEN UNCLEAR:");
    expect(config.systemMessage).toContain(
      "DELETE WHEN CLEAR / ASK WHEN UNCLEAR (lists)",
    );
    expect(config.systemMessage).toContain("ASK once naming options");
    expect(config.systemMessage).toContain(
      "FORBIDDEN empty responses",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN alter_list/delete_list for a single item",
    );
    expect(config.systemMessage).toContain(
      "metadata.lists as an ARRAY of actions",
    );
    expect(config.systemMessage).toContain(
      'FORBIDDEN lists as object buckets',
    );
    expect(config.systemMessage).toContain("FORBIDDEN metadata.show_dump on ANY line-index");
    expect(config.systemMessage).toContain("משותפות עם X");
    expect(config.systemMessage).toContain("SHOW_DUMP (critical)");
    expect(config.systemMessage).toContain("NOT bare «מה יש לי»");
    expect(config.systemMessage).toContain("מה המטלות שלי");
    expect(config.systemMessage).toContain(
      "ALWAYS name the object and its list",
    );
    expect(config.systemMessage).toContain("FORBIDDEN: bare «בסדר, מחקתי!»");
    expect(config.systemMessage).toContain("LIST NAME MATCH");
    expect(config.systemMessage).toContain("VERY SIMILAR");
    expect(config.systemMessage).toContain(
      "FORBIDDEN: inventing a list_name or picking by topic/meaning alone",
    );
    expect(config.systemMessage).toContain("TWO OR MORE list_name titles");
    expect(config.systemMessage).toContain("הוסיפי באג");
    expect(config.systemMessage).toContain("TOPIC-ONLY / NO LIST NAMED");
    expect(config.systemMessage).toContain("never pick the first / shared");
    expect(config.systemMessage).toContain("NUMBERED block");
    expect(config.systemMessage).toContain("לאיזו רשימה התכוונת");
    expect(config.systemMessage).toContain("LAST list-pick ask");
    expect(config.systemMessage).toContain(
      "FORBIDDEN inventing numbers that were not candidates",
    );
    expect(config.systemMessage).toContain("NUMBERED which-list ask");
    expect(config.systemMessage).toContain("רשימת «name»:");
    expect(config.systemMessage).toContain("אנשי קשר:");
    expect(config.systemMessage).toContain("YEARLY OFFER");
    expect(config.systemMessage).toContain("FORBIDDEN reminders-only yearly birthday");
    expect(config.systemMessage).toContain("about=[that person]");
    expect(config.systemMessage).toContain("WORKER_SAVED_DATA");
    expect(config.systemMessage).toContain("USER-FACING LANGUAGE");
    expect(config.systemMessage).toContain("compose_source");
    expect(config.systemMessage).toContain("git_log");
    expect(config.systemMessage).toContain("PLATFORM INTERNAL");
    expect(config.systemMessage).toContain("since the last report");
    expect(config.systemMessage).toContain("compose_lookback_hours");
    expect(config.systemMessage).toContain("last_report_sha");
    expect(config.systemMessage).toContain("RECENT_OUTBOUND");
    expect(config.systemMessage).toContain("AFTER A CODE DIGEST");
    expect(config.systemMessage).toContain("GIT DIGEST CLOCK REQUIRED");
    expect(config.systemMessage).toContain("SCHEDULED SAVED-DATA STATUS");
    expect(config.systemMessage).toContain("saved_data");
    expect(config.systemMessage).toContain("תוסיפי לי בעוד שעה מטלה");
    expect(config.systemMessage).toContain("SEND BY MEANING");
    expect(config.systemMessage).toContain("SEND-ME STATUS vs SEND-TO-PERSON");
    expect(config.systemMessage).toContain("SEND-ME FREE TEXT");
    expect(config.systemMessage).toContain("מתי תרצה שאשלח?");
    expect(config.systemMessage).toContain("את ההודעה «…»");
    expect(config.systemMessage).toContain("תמסרי למיכל שאני אוהב אותה");
    expect(config.systemMessage).toContain("רשימת הקניות המשותפת");
    expect(config.systemMessage).toContain("facts plugin");
    expect(config.systemMessage).toContain("כל יום ב־9 שלחי למיכל ברכת בוקר");
    expect(config.systemMessage).toContain("Do NOT add a tasks row on the speaker");
    expect(config.systemMessage).toContain("EXAMPLE NAMES ARE NOT REAL");
    expect(config.systemMessage).toContain("SNOOZE / REMIND AGAIN");
    expect(config.systemMessage).toContain("REUSE EXISTING WRAPPER");
    expect(config.systemMessage).toContain(
      "FORBIDDEN lists.add of a second copy",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN second shopping חלב",
    );
    expect(config.systemMessage).toContain("REMINDER CONTENT DETAIL");
    expect(config.systemMessage).toContain("לטפל בשני הבאגים");
    expect(config.systemMessage).toContain("REMINDER-ON-ITEM");
    expect(config.systemMessage).toContain("הוסף תזכורת ל־X");
    expect(config.systemMessage).toContain(
      "FORBIDDEN lists.add (or inventing) any shopping/tasks product wrapper",
    );
    expect(config.systemMessage).toContain(
      "meetings with partners in title → no extra mark",
    );
    expect(config.systemMessage).toContain("FULL DUMP");
    expect(config.systemMessage).toContain("כל מה ששמור");
    expect(config.systemMessage).toContain("רשימת קניות משותפת");
    expect(config.systemMessage).toContain("מה יש לי משותף עם X");
    expect(config.systemMessage).toContain("מה יש לי עם X");
    expect(config.systemMessage).toContain("מה אנחנו חולקים עם X");
    expect(config.systemMessage).toContain("show_dump_section=shared");
    expect(config.systemMessage).toContain("show_dump_partner=X");
    expect(config.systemMessage).toContain("SHOW DUMP SECTION");
    expect(config.systemMessage).toContain("show_dump_section=personal");
    expect(config.systemMessage).toContain("show_dump_partner=");
    expect(config.systemMessage).toContain("show_dump_urgency");
    expect(config.systemMessage).toContain('show_dump="phone_book"');
    expect(config.systemMessage).toContain("לפירוט רשימה: הצג רשימת …");
    expect(config.systemMessage).toContain("FORBIDDEN model-written with-X overview");
    expect(config.systemMessage).toContain("NEVER ask for quantity");
    expect(config.systemMessage).toContain("NEVER ask for unit");
    expect(config.systemMessage).toContain("From a recipe / ingredient list");
    expect(config.systemMessage).toContain("MUST copy into כמות + יחידת מידה");
    expect(config.systemMessage).toContain("FOLLOW-UP TO YOUR QUESTION");
    expect(config.systemMessage).toContain("MULTI-INTENT CONFIRM");
    expect(config.systemMessage).toContain(
      "re-emit EVERY mutation you offered",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN past-tense success for an action absent from this turn's metadata",
    );
    expect(config.systemMessage).toContain("היום/מחר/אתמול");
    expect(config.systemMessage).toContain("bare מחר");
    expect(config.systemMessage).toContain("WHEN/TODAY");
    expect(config.systemMessage).toContain("next_occurrences");
    expect(config.systemMessage).toContain("show_dump_from + show_dump_to");
    expect(config.systemMessage).toContain("FORBIDDEN model-written day agenda");
    expect(config.systemMessage).toContain("RECURRING IN A DATE ANSWER");
    expect(config.systemMessage).toContain("FORBIDDEN model-written DAY AGENDA");
    expect(config.systemMessage).toContain("קבוע כל יום");
    expect(config.systemMessage).toContain("קבוע + תזכורת ב־HH:mm");
    expect(config.systemMessage).toContain("RECURRENCE START (critical)");
    expect(config.systemMessage).toContain('start:"2026-10-20"');
    expect(config.systemMessage).not.toContain("confirm_share");
    expect(config.systemMessage).not.toContain("PENDING_ACTION_STATE");
    expect(config.systemMessage).toContain("FORBIDDEN: «לרשימת הקניות שלך»");
    expect(config.systemMessage).toContain("TELL vs ASSIGN");
    expect(config.systemMessage).toContain("תגידי לטל לקנות");
    expect(config.systemMessage).toContain("TIMED TASK WITHOUT CLOCK");
    expect(config.systemMessage).toContain("APPOINTMENT VS PING");
    expect(config.systemMessage).toContain("TASK + REMINDER ≠ נדנוד (critical)");
    expect(config.systemMessage).toContain("WORKER TASK TIME (critical)");
    expect(config.systemMessage).toContain(
      "שעה לביצוע (= that remind-at clock) — never leave time only on reminders",
    );
    expect(config.systemMessage).toContain("SHARE WHOLE PHONE BOOK");
    expect(config.systemMessage).toContain('action:"share_book"');
    expect(config.systemMessage).toContain(
      "ASK «לשמור את «name» (phone) בספר הטלפונים שלך?»",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN: lists.add / lists.update that changes the speaker row's date/time/recurrence to the ping time",
    );
    expect(config.systemMessage).toContain("REMINDER OFFER follow-up");
    expect(config.systemMessage).toContain("רוצה שאשלח לך תזכורת");
    expect(config.systemMessage).toContain("PERSONAL TASK DEFAULT");
    expect(config.systemMessage).toContain("PERSONAL TASK vs SHARED CUSTOM");
    expect(config.systemMessage).toContain("משימות לעבודה");
    expect(config.systemMessage).toContain("AFTER ASSIGN");
    expect(config.systemMessage).toContain("גם אליך");
    expect(config.systemMessage).toContain("ping Michal only");
    expect(config.systemMessage).toContain("REMIND CLOCK vs APPOINTMENT CONTEXT");
    expect(config.systemMessage).toContain("NO META / BUG / CHAT CRITIQUE ON LISTS");
    expect(config.systemMessage).toContain("EVERY metadata.jobs entry MUST copy job_id");
    expect(config.systemMessage).toContain("נזיז ל־21:00");
    expect(config.systemMessage).toContain("A different clock time is COUNTER only");
    expect(config.systemMessage).toContain(
      "MUST end with all human participants in parentheses",
    );
    expect(config.systemMessage).toContain("פגישה נוספת בנושא פורים (עמית, טל)");
    expect(config.systemMessage).toContain("DELETE BY DAY");
    expect(config.systemMessage).toContain("BY LINE NUMBER (critical)");
    expect(config.systemMessage).toContain(
      "whatever ACTION they asked for on THAT entity",
    );
    expect(config.systemMessage).toContain("תשלחי את 3 ל…");
    expect(config.systemMessage).toContain(
      "FORBIDDEN metadata.show_dump on ANY line-index turn",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN: treating spoken N as EMPLOYEE_SAVED_DATA array index",
    );
    expect(config.systemMessage).toContain(
      "personal then co-share then assign",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN binding לא to AFTER ASSIGN / date+reminder / older offers",
    );
    expect(config.systemMessage).toContain(
      "cancel ONLY that delete ask (ack the options you named)",
    );
    expect(config.systemMessage).toContain(
      "Unambiguous deletes never wait for כן",
    );
    expect(config.systemMessage).not.toContain(
      "DELETE CONFIRM (critical —",
    );
    expect(config.systemMessage).toContain("STANDING TASK WITH TIME — CLOCK OFFER");
    expect(config.systemMessage).toContain(
      "רוצה שאשלח לך תזכורת בוואטסאפ כל 3 ימים ב־12:00?",
    );
    expect(config.systemMessage).toContain("CLOCK-ONLY");
    expect(config.systemMessage).toContain(
      "FORBIDDEN lists.update on the speaker standing chore",
    );
    expect(config.systemMessage).toContain("STANDING + LINKED CLOCK MOVE ASK");
    expect(config.systemMessage).toContain(
      "לעדכן גם את תזכורת הוואטסאפ בהתאם?",
    );
    expect(config.systemMessage).toContain("STANDING + LINKED CLOCK DELETE ASK");
    expect(config.systemMessage).toContain(
      "למחוק את המטלה הקבועה «<title>» (וגם את תזכורות הוואטסאפ), או רק להפסיק את התזכורות?",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN: answering «ביטלתי את המטלה לנדנד / להזכיר ל…»",
    );
    expect(config.systemMessage).toContain(
      "FORBIDDEN: lists.remove of your להזכיר / לשלוח נדנוד worker alone",
    );
    expect(config.systemMessage).toContain("תמחקי את הפגישה / המטלה ביום חמישי");
    expect(config.systemMessage).toContain("MUTATE BY ID");
    expect(config.systemMessage).toContain("item_id");
    expect(config.systemMessage).toContain("filing_id");
    expect(config.systemMessage).toContain(
      "Product Hebrew תיאור = this field",
    );
    expect(config.systemMessage).toContain(
      "item_description (optional) — מידע כללי",
    );
    expect(config.systemMessage).toContain("FIND-HELPER");
    expect(config.systemMessage).toContain(
      "by filing KIND",
    );
    expect(config.systemMessage).toContain("מספר הרכב 70332729");
    expect(config.systemMessage).toContain(
      "Find filings by item_name + item_info + item_description",
    );
    expect(config.systemMessage).not.toContain(
      "Prefer item_description = item_name",
    );
    expect(config.systemMessage).not.toContain(
      "Never save add_filing without item_description",
    );
    expect(config.systemMessage).toContain("reminder_id");
    expect(config.systemMessage).toContain("A raise is ALWAYS its own entry in responses");
    expect(config.systemMessage).toContain("אגב, ביקשת שאבדוק אם קנית חלב?");
    expect(config.systemMessage).toContain("URGENCY FOLLOW-UP (critical)");
    expect(config.systemMessage).toContain("never a second check");
    expect(config.systemMessage).toContain("תבדקי איתי בעוד 10 דקות אם הלכתי לישון");
    expect(config.systemMessage).toContain("CAPABILITIES (זהה לכל עובד)");
    expect(config.systemMessage).toContain("תיאום מול המשתתפים");
    expect(config.systemMessage).toContain("בירורים ונדנודים");
    expect(config.systemMessage).toContain("שליחה מתוזמנת וסיכומים חיים");
    expect(config.systemMessage).toContain("ספר טלפונים אישי");
    expect(config.systemMessage).toContain("מעבר לשיחה עם עובד דיגיטלי אחר");
    expect(config.systemMessage).toContain("Do NOT list platform-owner-only git digests");
    expect(config.systemMessage).toContain("COMPLEX EVENT TOPIC vs ORGANIZE INTENT");
    expect(config.systemMessage).toContain("intentional PRODUCT CONTRACT");
    expect(config.systemMessage).toContain("DYNAMIC AXES");
    expect(config.systemMessage).toContain(
      "FORBIDDEN always offering the same trio",
    );
    expect(config.systemMessage).toContain("מפגש קולנוע → איזה סרט");
    expect(config.systemMessage).toContain("collision-safe custom list_name");
    expect(config.systemMessage).toContain("כיבוד · ערב פוקר · 12.12.2026");
    expect(config.systemMessage).toContain(
      "FORBIDDEN silently sharing one list across two hosts",
    );
  });
});
