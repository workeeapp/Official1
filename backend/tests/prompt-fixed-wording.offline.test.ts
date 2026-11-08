/**
 * Prompt alignment P1+P3 guard (offline, no model / DB).
 *
 * The prompt states WHAT Lucy must say or ask (content, structure, when), not
 * the exact Hebrew sentence. These fixed sentences were removed from the
 * instructions (claude/prompt-alignment-p1-p3.md) and must not come back;
 * the behavioral requirements they carried must still be present.
 * Exact outbound quotes, button commands and user-utterance examples are
 * functional and are not covered here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDefaultEvalFixtures } from "../src/eval/eval-prompt-source.js";
import { buildLucyInstructions } from "../src/services/chat.service.js";
import { formatSpeakerAddressContext } from "../src/services/speaker-address.js";

const root = resolve(import.meta.dirname, "../..");
const speaker = "טל";
const { employees, worker } = buildDefaultEvalFixtures(speaker, { includeMichal: false });
const instructions = buildLucyInstructions({
  digital: worker,
  employees,
  speaker,
  speakerIsOwner: true,
  guestSpeaker: false,
  pendingInvite: null,
  consultFrom: "",
});
// Dynamic headers (OPEN_JOBS, EMPLOYEE_SAVED_DATA, SPEAKER_ADDRESS) render only
// with data, so their rule text is checked at the source.
const dynamicSources = [
  "backend/src/services/jobs.service.ts",
  "backend/src/services/employee-records.service.ts",
].map((path) => readFileSync(resolve(root, path), "utf8"));
const speakerAddressUnknown = formatSpeakerAddressContext(null);
const everything = [instructions, ...dynamicSources, speakerAddressUnknown].join("\n");

describe("P1+P3: no prescribed Lucy sentences", () => {
  const removed = [
    // P1 — greetings / open-job raises / confirmations / offers
    "הי, איך אפשר לעזור?",
    "opened naturally (e.g. «אגב,»)",
    "אגב, ביקשת שאבדוק",
    "עמית ביקש לתאם איתך פגישה ביום ראשון ב-12:00",
    "בסדר — קנית שוקו?",
    "עמית ביקש בדחיפות",
    "אזכיר לך בעוד חצי שעה?",
    "ואמשיך לנדנד",
    "מחקתי את «title»",
    "אשאל את עמית ואעדכן אותך",
    "«אעדכן את עמית.»",
    "short ack only («אעדכן",
    "בסדר, ביטלתי — אעדכן את עמית.",
    "ביטלתי את התזכורת — עמית יקבל עדכון",
    "רוצה שאשלח לך תזכורת בוואטסאפ",
    "אם כבר יודע באיזו שעה",
    // P3 — clarification questions
    "לשמור בכל זאת?",
    "מתי תרצה שאשלח?",
    "לעדכן גם את תזכורת הוואטסאפ בהתאם?",
    "או רק להפסיק את התזכורות?",
    "לסמן שסיימת להפעם",
    "או בכל <weekday>?",
    "לפנות אליך בלשון זכר או נקבה?",
    "«לאיזו שנת לימודים?»",
    "לאיזו רשימה התכוונת?",
  ];
  it.each(removed)("instructions do not prescribe «%s»", (sentence) => {
    expect(everything).not.toContain(sentence);
  });
});

describe("P1+P3: the requirements behind them are kept", () => {
  it("open-job raise: own entry after the answer, one raise, urgent first", () => {
    expect(instructions).toMatch(/A raise is ALWAYS its own entry in responses/);
    expect(instructions).toMatch(/FORBIDDEN a second raise entry or any other yes\/no/);
    expect(instructions).toMatch(/meeting raise entry is the question: it states who asked and the proposed slot and asks yes\/no/);
    expect(instructions).toMatch(/urgency=urgent → the raise entry comes FIRST/);
  });

  it("deletes confirm in past tense, naming what was deleted; never empty", () => {
    expect(instructions).toMatch(/non-empty past-tense confirmation naming what was deleted/);
    expect(instructions).toMatch(/FORBIDDEN empty responses/);
  });

  it("clarifications keep the question, its purpose and the empty-actions contract", () => {
    expect(instructions).toMatch(/lists=\[\] and ask once whether to save anyway, naming the overlapping item/);
    expect(instructions).toMatch(/response ONLY asks when to send it; messages=\[\], no reminders clock, lists=\[\]/);
    expect(instructions).toMatch(/ASK whether to move the linked WhatsApp reminder too, with lists\/reminders empty/);
    expect(instructions).toMatch(/ASK once whether to delete the standing task \(with its WhatsApp reminders\) or only stop the reminders/);
    expect(instructions).toMatch(/ask ONLY for the school year \(one question; mashov=null/);
    expect(instructions).toMatch(/list the candidates as NUMBERED 1\. 2\. 3\./);
  });

  it("address-gender ask: once, after every action, as the last entry", () => {
    expect(speakerAddressUnknown).toMatch(/Do what this turn asks FIRST/);
    expect(speakerAddressUnknown).toMatch(/ask once how they would like to be addressed \(male or female\) as a separate LAST responses entry/);
  });

  it("exact outbound quotes stay required (functional, not a script)", () => {
    expect(instructions).toContain("את ההודעה «…»");
    expect(instructions).toMatch(/EXACT OUTBOUND QUOTE/);
  });

  it("the post-save reminder offer is untouched in this phase", () => {
    expect(instructions).toContain("רוצה שאוסיף גם תזכורת למשימה הזו?");
    expect(instructions).toContain("FORBIDDEN a single responses entry with no offer");
  });
});
