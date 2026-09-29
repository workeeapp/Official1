import { describe, expect, it } from "vitest";
import { formatTurnApplySummary } from "../src/services/apply-summary.js";

describe("formatTurnApplySummary", () => {
  const speakerId = "tal-1";
  const workerId = "lucy-1";

  it("reports shopping, worker task, and reminder for a self-nudge", () => {
    const text = formatTurnApplySummary({
      listMutations: [
        {
          action: "add",
          itemId: "i1",
          employeeId: speakerId,
          listType: "shopping",
          itemKey: "חלב",
          itemLabel: "חלב",
        },
        {
          action: "add",
          itemId: "i2",
          employeeId: workerId,
          listType: "tasks",
          itemKey: "להזכיר לטל לקנות חלב",
          itemLabel: "להזכיר לטל לקנות חלב",
        },
      ],
      filingMutations: [],
      reminders: {
        removed: [],
        missed: [],
        saved: [
          {
            item: "לקנות חלב",
            fireAt: "2026-09-29 18:00",
            ping: "טל",
          },
        ],
        skipped: [],
      },
      directory: { saved: [], removed: [] },
      messagesSent: [],
      speakerId,
      workerId,
      workerName: "לוסי",
    });

    expect(text).toContain("הוספתי «חלב» לרשימת הקניות");
    expect(text).toContain("הוספתי לעצמי מטלה «להזכיר לטל לקנות חלב»");
    expect(text).toContain("נשמרה התזכורת «לקנות חלב»");
    expect(text).toContain("אל טל");
  });

  it("reports filings, directory, and sent messages", () => {
    const text = formatTurnApplySummary({
      listMutations: [],
      filingMutations: [
        { action: "add", itemName: "מספר רכב", itemInfo: "12-345" },
      ],
      reminders: { removed: [], missed: [] },
      directory: {
        saved: [
          {
            id: "c1",
            name: "יואב",
            phone: "972515520802",
            kind: "person",
          },
        ],
        removed: [],
      },
      messagesSent: ["יואב"],
      speakerId,
      workerId,
      workerName: "לוסי",
    });

    expect(text).toContain("שמרתי תיוק «מספר רכב»: 12-345");
    expect(text).toContain("שמרתי את «יואב» בספר הטלפונים שלך");
    expect(text).toContain("שלחתי הודעה ל«יואב»");
  });

  it("reports custom list name and removals", () => {
    const text = formatTurnApplySummary({
      listMutations: [
        {
          action: "remove",
          itemId: "i1",
          employeeId: speakerId,
          listType: "custom",
          itemKey: "אדידס",
          itemLabel: "אדידס",
          listName: "חנויות",
        },
      ],
      speakerId,
      workerId,
      workerName: "לוסי",
    });

    expect(text).toContain("הסרתי «אדידס» מהרשימה «חנויות»");
  });

  it("reports opening a named custom list shell", () => {
    const text = formatTurnApplySummary({
      listMutations: [
        {
          action: "add",
          itemId: "list-1",
          employeeId: speakerId,
          listType: "custom",
          itemKey: "המטרות",
          itemLabel: "המטרות",
          listName: "המטרות",
          listShell: true,
        },
      ],
      speakerId,
      workerId,
      workerName: "לוסי",
    });

    expect(text).toBe("פתחתי את הרשימה «המטרות».");
  });

  it("reports cascade reminder cancel and worker task remove on buy", () => {
    const text = formatTurnApplySummary({
      listMutations: [
        {
          action: "remove",
          itemId: "i1",
          employeeId: speakerId,
          listType: "shopping",
          itemKey: "מגהץ",
          itemLabel: "מגהץ",
        },
        {
          action: "remove",
          itemId: "i2",
          employeeId: workerId,
          listType: "tasks",
          itemKey: "להזכיר לטל לקנות מגהץ",
          itemLabel: "להזכיר לטל לקנות מגהץ",
        },
      ],
      reminders: {
        removed: ["לקנות מגהץ"],
        missed: [],
      },
      speakerId,
      workerId,
      workerName: "לוסי",
    });

    expect(text).toContain("הסרתי «מגהץ» מרשימת הקניות");
    expect(text).toContain("הסרתי מעצמי את המטלה «להזכיר לטל לקנות מגהץ»");
    expect(text).toContain("ביטלתי את התזכורת «לקנות מגהץ»");
  });
});
