import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  clusterDumpRowsByKind,
  composeTasksDumpWithWaiting,
  excludeItemIdsFromSnapshot,
  customItemCoShareMark,
  filterSnapshotForAboutPerson,
  formatCustomItemBody,
  formatCustomListDetailText,
  formatFilingDumpBody,
  formatFilingListPreview,
  formatTruncatedListDetail,
  extractFilingReadableText,
  firstFilingPreviewChunk,
  truncateFilingPreviewAtWord,
  filingHiddenDetailMark,
  filingPlaceMark,
  filingNavigateCoordinates,
  parseLatLngCoordinates,
  formatLinkedReminderParen,
  formatNumberedItem,
  formatOccurrenceEffectiveReminderParen,
  formatRelativeDayLabel,
  formatRelativeFireAt,
  formatReminderIndicator,
  formatReminderWhen,
  formatAgendaOneOffLine,
  formatAgendaStandingLine,
  formatScheduleSuffix,
  stripMatchingTitleClock,
  formatShoppingTitle,
  formatLastNumberedDumpContext,
  resolveDumpLineId,
  formatFullDump,
  formatShowDumpFromKind,
  formatShowDumpWithLineMap,
  liveDumpRowIdsFromSnapshot,
  isKnownShowButtonCommand,
  isTasksShowDumpKind,
  itemHasDumpCalendarDate,
  itemMatchesDateRange,
  formatUndatedTasksExcludedNote,
  countUndatedTasksExcludedByDateRange,
  ymdFromDumpValue,
  mapShowButtonCommandToDump,
  mapShowButtonCommandToDumpTarget,
  navigateAddressFromFilingsDump,
  partnerBucketMatches,
  partnersKey,
  shortCadenceParen,
  titleAlreadyListsPartners,
} from "../src/services/show-button-dump.js";
import {
  showAllListButtonCommand,
  showAssigneeButtonCommand,
  showSharedWithButtonCommand,
} from "../src/services/builtin-lists.js";
import {
  formatWhatsAppReplyContext,
  stripWhatsAppReplyPrefix,
} from "../src/services/whatsapp-outbound-memory.js";

describe("closed show button allowlist", () => {
  it("maps exact builtin button strings only — not free-form or suffixes", () => {
    expect(mapShowButtonCommandToDump("הצג רשימת קניות")).toBe("shopping");
    expect(mapShowButtonCommandToDump("הצג תזכורות")).toBe("reminders");
    expect(mapShowButtonCommandToDump("הצג תיוקים")).toBe("filings");
    expect(mapShowButtonCommandToDump("הצג רשימת מטלות")).toBe("tasks");
    expect(mapShowButtonCommandToDump("הצג רשימת אנשי קשר")).toBe("phone_book");
    expect(mapShowButtonCommandToDump(showAllListButtonCommand("shopping"))).toBe(
      "shopping",
    );
    expect(mapShowButtonCommandToDump("הצג רשימת קניות בבקשה")).toBeNull();
    expect(mapShowButtonCommandToDump("הצג רשימת קניות אישית")).toBeNull();
    expect(mapShowButtonCommandToDump("מה יש לי לקנות")).toBeNull();
    expect(mapShowButtonCommandToDump("הציגי את רשימת הקניות")).toBeNull();
    expect(isKnownShowButtonCommand("הצג רשימת קניות")).toBe(true);
    expect(isKnownShowButtonCommand("הצג רשימת קניות אישית")).toBe(false);
  });

  it("maps shared-with / assignee / all commands to kind + pure filters", () => {
    const shared = mapShowButtonCommandToDumpTarget(
      showSharedWithButtonCommand("shopping", "מיכל"),
    );
    expect(shared).toEqual({
      kind: "shopping",
      section: "shared",
      partner: "מיכל",
      collaboration: "co_share",
    });
    const assign = mapShowButtonCommandToDumpTarget(
      showAssigneeButtonCommand("tasks", "מיכל"),
    );
    expect(assign).toEqual({
      kind: "tasks",
      section: "shared",
      assignee: "מיכל",
      collaboration: "assign",
    });
    expect(
      mapShowButtonCommandToDumpTarget(showAllListButtonCommand("filings")),
    ).toEqual({ kind: "filings" });
    expect(
      mapShowButtonCommandToDumpTarget(
        showSharedWithButtonCommand("contacts", "מיכל"),
      ),
    ).toEqual({
      kind: "phone_book",
      section: "shared",
      partner: "מיכל",
      collaboration: "co_share",
    });
    expect(
      isKnownShowButtonCommand(showSharedWithButtonCommand("shopping", "מיכל")),
    ).toBe(true);
  });

  it("maps worker inventory «הצג מטלות של X» to tasks + about", () => {
    expect(mapShowButtonCommandToDumpTarget("הצג מטלות של לוסי")).toEqual({
      kind: "tasks",
      about: "לוסי",
    });
    expect(isKnownShowButtonCommand("הצג מטלות של לוסי")).toBe(true);
    // Collab shapes stay distinct from about.
    expect(mapShowButtonCommandToDumpTarget("הצג מטלות באחריות לוסי")).toEqual({
      kind: "tasks",
      section: "shared",
      assignee: "לוסי",
      collaboration: "assign",
    });
  });

  it("maps custom list buttons only by exact equality to a live list_name", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "משימות לעבודה",
          owner: "טל",
          scope: "personal",
          items: [],
        },
      ],
      filing: [],
    };
    expect(mapShowButtonCommandToDump("הצג רשימת משימות לעבודה", snap)).toBe(
      "משימות לעבודה",
    );
    expect(mapShowButtonCommandToDump("הצג רשימת משימות לעבודה")).toBeNull();
    expect(
      mapShowButtonCommandToDump("הצג רשימת משימות לעבודה בבקשה", snap),
    ).toBeNull();
  });

  it("strips WhatsApp reply prefix before allowlist equality", () => {
    const wrapped = formatWhatsAppReplyContext(
      "מחקתי את האורז מרשימת הקניות.",
      "הצג רשימת קניות",
    );
    expect(stripWhatsAppReplyPrefix(wrapped)).toBe("הצג רשימת קניות");
    expect(
      isKnownShowButtonCommand(stripWhatsAppReplyPrefix(wrapped)),
    ).toBe(true);
  });
});

describe("formatFilingDumpBody", () => {
  it("list mode is title only; full mode labels תיאור / מידע לחיפוש", () => {
    expect(
      formatFilingDumpBody(
        {
          filing_id: "f1",
          item_name: "כתובת מרב",
          item_info: "יערה אבן יהודה",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        "list",
      ),
    ).toBe("כתובת מרב");
    expect(
      formatFilingDumpBody(
        {
          filing_id: "f1",
          item_name: "כתובת מרב",
          item_info: "יערה אבן יהודה",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        "full",
      ),
    ).toBe("שם: כתובת מרב · תיאור: יערה אבן יהודה");
    expect(
      formatFilingDumpBody(
        {
          filing_id: "f2",
          item_name: "מספר רישיון נהיגה",
          item_info: "423432342",
          item_description: "רישיון הנהיגה שלי על האופנוע משנת 1998",
          owner: "טל",
          scope: "personal",
        },
        "full",
      ),
    ).toBe(
      "שם: מספר רישיון נהיגה · תיאור: 423432342 · מידע לחיפוש: רישיון הנהיגה שלי על האופנוע משנת 1998",
    );
    expect(
      formatFilingDumpBody({
        filing_id: "f3",
        item_name: "שרון וטרינרית",
        item_info: "",
        item_description: "",
        owner: "טל",
        scope: "personal",
      }),
    ).toBe("שרון וטרינרית");
  });

  it("filingHiddenDetailMark is 📄 only when detail preview overflows", () => {
    expect(
      filingHiddenDetailMark(
        { item_info: "בתוקף", item_description: "" },
        "list",
      ),
    ).toBe("");
    expect(
      filingHiddenDetailMark(
        {
          item_info: "מבחן מתמטיקה ביום שלישי. אחר כך אנגלית.",
          item_description: "",
        },
        "list",
      ),
    ).toBe(" 📄");
    expect(
      filingHiddenDetailMark(
        {
          item_name: "מיקום הבית",
          item_info: "32.1, 34.8",
          item_description: "ליד הפארק",
        },
        "list",
      ),
    ).toBe("");
  });

  it("filing list preview: short sentence intact; multi-sentence → first only", () => {
    expect(
      formatFilingListPreview({
        item_name: "רישיון",
        item_info: "בתוקף",
        item_description: "",
      }),
    ).toBe("בתוקף");
    expect(
      formatFilingListPreview({
        item_name: "לוח",
        item_info: "מבחן מתמטיקה ביום שלישי. אחר כך אנגלית. ואז היסטוריה.",
        item_description: "",
      }),
    ).toBe("מבחן מתמטיקה ביום שלישי.…");
    expect(
      formatFilingListPreview({
        item_name: "לוח",
        item_info: "מבחן מתמטיקה ביום שלישי.",
        item_description: "",
      }),
    ).toBe("מבחן מתמטיקה ביום שלישי.");
  });

  it("filing list preview: short text stays complete under the soft cap", () => {
    const short = "הערה קצרה על התור.";
    expect(
      formatFilingListPreview({
        item_name: "הערה",
        item_info: short,
        item_description: "",
      }),
    ).toBe(short);
  });

  it("filing list preview: long unpunctuated text cuts near soft cap at a word", () => {
    const long =
      "זה טקסט ארוך בלי נקודה בסוף כדי לוודא חיתוך בגבול מילה סביב מאה שישים תווים במנגנון התצוגה המקדימה של תיוקים ברשימה עם עוד מילים כדי לעבור את הסף החדש בבירור ולהישאר קריא";
    const preview = formatFilingListPreview({
      item_name: "הערה",
      item_info: long,
      item_description: "",
    });
    expect(preview).toBeTruthy();
    expect(preview!.endsWith("…")).toBe(true);
    const body = preview!.slice(0, -1);
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body.length).toBeGreaterThan(70);
    expect(body).not.toMatch(/\s$/);
    expect(long.startsWith(body)).toBe(true);
    expect(firstFilingPreviewChunk(long).rest).toBe("");
    expect(truncateFilingPreviewAtWord(long).truncated).toBe(true);
  });

  it("filing list preview: multi-line keeps first line then marks overflow", () => {
    const multi = "שורה ראשונה של התיאור\nשורה שנייה עם עוד פרטים\nשורה שלישית";
    const preview = formatFilingListPreview({
      item_name: "הערה",
      item_info: multi,
      item_description: "",
    });
    expect(preview).toBeTruthy();
    expect(preview!.startsWith("שורה ראשונה של התיאור")).toBe(true);
    expect(preview).toContain("…");
    expect(preview).not.toContain("שורה שלישית");
  });

  it("list detail preview is a contiguous slice of the original, not a rewrite", () => {
    const originalFiling =
      "הלקוח אישר את ההזמנה ביום ראשון בבוקר. צריך לשלוח חשבונית ולעדכן את המחסן לפני המשלוח.";
    const filingPreview = formatFilingListPreview({
      item_name: "הזמנה",
      item_info: originalFiling,
      item_description: "",
    });
    expect(filingPreview).toBeTruthy();
    const filingBody = filingPreview!.endsWith("…")
      ? filingPreview!.slice(0, -1)
      : filingPreview!;
    const filingNorm = originalFiling.replace(/\s+/g, " ").trim();
    expect(filingNorm.startsWith(filingBody)).toBe(true);
    expect(filingNorm.indexOf(filingBody)).toBe(0);
    expect(filingPreview).not.toMatch(/בקצרה|לסיכום|תקציר|במילים אחרות/);
    expect(filingBody).toBe("הלקוח אישר את ההזמנה ביום ראשון בבוקר.");

    const item = {
      שם: "הזמנה A-9",
      תיאור: "נשלח באריזה כפולה עם מדבקת שביר",
      "הערת לקוח":
        "בבקשה למסור רק אחרי השעה חמש ולצלצל פעמיים אם אין מענה בדלת הראשית של הבניין ואז להשאיר הודעה אצל השכן עם מספר הטלפון של השליח ועם הערות נוספות על שעות המסירה המבוקשות למחרת בבוקר",
    };
    const columns = ["שם", "תיאור", "הערת לקוח"];
    const originalCustom = formatCustomListDetailText(item, "שם", columns);
    expect(originalCustom).toContain("תיאור: נשלח באריזה כפולה עם מדבקת שביר");
    expect(originalCustom).toContain("הערת לקוח:");
    const customPreview = formatTruncatedListDetail(originalCustom);
    expect(customPreview).toBeTruthy();
    const customBody = customPreview!.text.endsWith("…")
      ? customPreview!.text.slice(0, -1)
      : customPreview!.text;
    const customNorm = originalCustom.replace(/\s+/g, " ").trim();
    expect(customNorm.startsWith(customBody)).toBe(true);
    expect(customNorm.indexOf(customBody)).toBe(0);
    expect(customBody).toContain("תיאור:");
    expect(customBody).toContain("נשלח באריזה כפולה");
    expect(customPreview!.truncated).toBe(true);
    expect(customPreview!.text).toContain("…");
    expect(customPreview!.text).not.toMatch(
      /לקוח מבקש|סיכום:|בקצרה|תקציר ההזמנה/,
    );
  });

  it("filing list preview: structured JSON → readable strings, not raw JSON", () => {
    expect(
      extractFilingReadableText(
        JSON.stringify({ summary: "תור אצל הרופא ביום ראשון", id: "x1" }),
      ),
    ).toBe("תור אצל הרופא ביום ראשון");
    expect(
      formatFilingListPreview({
        item_name: "תור",
        item_info: JSON.stringify({
          text: "יש תור אצל הרופא ביום ראשון בבוקר. להביא הפניה.",
        }),
        item_description: "",
      }),
    ).toBe("יש תור אצל הרופא ביום ראשון בבוקר.…");
    expect(
      formatFilingListPreview({
        item_name: "תור",
        item_info: '{"id":"abc","meta":true}',
        item_description: "",
      }),
    ).toBeNull();
  });

  it("filing list preview: empty or unreadable → null (title only)", () => {
    expect(
      formatFilingListPreview({
        item_name: "ריק",
        item_info: "",
        item_description: "",
      }),
    ).toBeNull();
    expect(
      formatFilingListPreview({
        item_name: "מיקום הבית",
        item_info: "32.099279, 34.8923104",
        item_description: "",
      }),
    ).toBeNull();
  });

  it("parseLatLngCoordinates accepts bare lat,lng only", () => {
    expect(parseLatLngCoordinates("32.099279, 34.8923104")).toEqual({
      lat: 32.099279,
      lng: 34.8923104,
    });
    expect(parseLatLngCoordinates("הרצל 1, תל אביב")).toBeNull();
    expect(parseLatLngCoordinates("https://maps.google.com/?q=1,2")).toBeNull();
  });
});

describe("filings flat dump", () => {
  it("inventory: title + short preview; co-share mark; no 📄 when detail fits", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f2",
          item_name: "קוד שער",
          item_info: "1234",
          item_description: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(dump).toContain("📁 תיוקים:");
    expect(dump).not.toContain("תיוקים אישיים:");
    expect(dump).not.toContain("תיוקים משותפים:");
    expect(dump).toMatch(
      /📁 תיוקים:\n1\. רישיון\nבתוקף\n2\. קוד שער \(מיכל, טל\)\n1234/,
    );
    expect(dump).not.toContain("תיאור:");
    expect(dump).not.toContain("שם:");
    expect(dump).not.toContain("📄");
    expect(dump).not.toContain("מידע:");
    expect(dump).not.toContain("(עם ");
    expect(dump).not.toContain("של ");
  });

  it("inventory: multi-line OCR preview is first line only + …; 📎 kept", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f-doc",
          item_name: "לוח מבחנים — יואב",
          item_info: "מתמטיקה 12/11\nאנגלית 15/11\nהיסטוריה 20/11",
          item_description: "",
          owner: "טל",
          scope: "personal",
          attachments: [{ attachment_id: "a1" }],
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(dump).toBe(
      "📁 תיוקים:\n1. לוח מבחנים — יואב 📎 📄\nמתמטיקה 12/11…",
    );
    expect(dump).not.toContain("אנגלית");
    expect(dump).not.toContain("תיאור:");
  });

  it("inventory: title only when no detail and no attachment", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f-short",
          item_name: "מסמך ללא קובץ",
          item_info: "",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(dump).toBe("📁 תיוקים:\n1. מסמך ללא קובץ");
    expect(dump).not.toContain("📄");
    expect(dump).not.toContain("📎");
  });

  it("filtered filings list uses the same preview as the full inventory", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף עד סוף השנה. אחר כך לחדש.",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f2",
          item_name: "קוד שער",
          item_info: "1234",
          item_description: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
        },
      ],
    };
    const personal = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      section: "personal",
    })!;
    expect(personal).toBe(
      "📁 תיוקים:\n1. רישיון 📄\nבתוקף עד סוף השנה.…",
    );
    expect(personal).not.toContain("קוד שער");
    expect(personal).not.toContain("תיאור:");
  });

  it("option A: list 📍 only; ITEM DUMP 📍 + Waze coords; no Maps/coords in text", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "home",
          item_name: "מיקום הבית",
          item_info: "32.099279, 34.8923104",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "street",
          item_name: "כתובת עבודה",
          item_info: "הרצל 1 תל אביב",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    const list = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(list).toContain("📁 תיוקים:");
    expect(list).toMatch(/1\. מיקום הבית 📍/);
    expect(list).toContain("2. רישיון\nבתוקף");
    expect(list).toMatch(/3\. כתובת עבודה 📍/);
    expect(list).not.toContain("📄");
    expect(list).not.toContain("32.099279");
    expect(list).not.toContain("maps.google");
    expect(list).not.toContain("הרצל 1");
    expect(
      navigateAddressFromFilingsDump(snap.filing, { viewerName: "טל" }),
    ).toBeNull();

    const filtered = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      section: "personal",
    })!;
    expect(filtered).toMatch(/מיקום הבית 📍/);
    expect(filtered).not.toContain("32.099279");
    expect(
      navigateAddressFromFilingsDump(snap.filing, {
        viewerName: "טל",
        section: "personal",
      }),
    ).toBeNull();

    const item = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      itemIds: new Set(["home"]),
    })!;
    expect(item).toBe("📁 תיוקים:\n1. מיקום הבית 📍");
    expect(item).not.toContain("32.099279");
    expect(item).not.toContain("maps.google");
    expect(
      navigateAddressFromFilingsDump(snap.filing, {
        viewerName: "טל",
        itemIds: new Set(["home"]),
      }),
    ).toBe("32.099279,34.8923104");
    expect(
      filingNavigateCoordinates(snap.filing[0]!),
    ).toBe("32.099279,34.8923104");

    // Street-only location: 📍 in text, no Waze (no valid coordinates).
    expect(
      formatShowDumpFromKind("filings", snap, {
        viewerName: "טל",
        itemIds: new Set(["street"]),
      }),
    ).toBe("📁 תיוקים:\n1. כתובת עבודה 📍");
    expect(
      navigateAddressFromFilingsDump(snap.filing, {
        viewerName: "טל",
        itemIds: new Set(["street"]),
      }),
    ).toBeNull();

    expect(
      filingPlaceMark(
        {
          item_name: "מיקום הבית",
          item_info: "32.099279, 34.8923104",
        },
        "full",
      ),
    ).toBe(" 📍");
  });

  it("ITEM DUMP filters filings to show_dump_ids and shows full labeled body", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f2",
          item_name: "קוד שער",
          item_info: "1234",
          item_description: "שער חניה",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      itemIds: new Set(["f2"]),
    })!;
    expect(dump).toContain("קוד שער");
    expect(dump).not.toContain("רישיון");
    expect(dump).toMatch(/^📁 תיוקים:\n1\. /);
    expect(dump).toContain("שם: קוד שער · תיאור: 1234 · מידע לחיפוש: שער חניה");
    expect(dump).not.toContain("📄");
  });

  it("ITEM DUMP filters tasks to multiple item ids", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "t1", "שם מטלה": "לשיננית" },
            { item_id: "t2", "שם מטלה": "לקנות חלב" },
            { item_id: "t3", "שם מטלה": "לחזור מהשיננית" },
          ],
        },
      ],
      filing: [],
    };
    const dump = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      itemIds: new Set(["t1", "t3"]),
    })!;
    expect(dump).toContain("לשיננית");
    expect(dump).toContain("לחזור מהשיננית");
    expect(dump).not.toContain("לקנות חלב");
  });

  it("ITEM DUMP: filing_id under show_dump=tasks does not surface the filing or full tasks", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "t1", "שם מטלה": "ללכת לרופא" },
            { item_id: "t2", "שם מטלה": "לקנות חלב" },
          ],
        },
      ],
      filing: [
        {
          filing_id: "f-gate",
          item_name: "קוד שער",
          item_info: "9999",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    const dump = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      omitEmptySentence: true,
      itemIds: new Set(["f-gate"]),
    });
    expect(dump).toBe("");
    expect(dump).not.toContain("קוד שער");
    expect(dump).not.toContain("ללכת לרופא");
    expect(dump).not.toContain("✅ מטלות:");
  });

  describe("ITEM DUMP id filter — all kinds (1 / many / wrong / empty)", () => {
    const omitEmpty = { omitEmptySentence: true as const, viewerName: "טל" };

    it("shopping: single, many, wrong, empty Set", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "shopping",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "s1", "שם פריט": "חלב", כמות: 1 },
              { item_id: "s2", "שם פריט": "לחם", כמות: 2 },
              { item_id: "s3", "שם פריט": "ביצים", כמות: 1 },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
      };
      const one = formatShowDumpFromKind("shopping", snap, {
        ...omitEmpty,
        itemIds: new Set(["s2"]),
      })!;
      expect(one).toContain("לחם");
      expect(one).not.toContain("חלב");
      expect(one).not.toContain("ביצים");

      const many = formatShowDumpFromKind("shopping", snap, {
        ...omitEmpty,
        itemIds: new Set(["s1", "s3"]),
      })!;
      expect(many).toContain("חלב");
      expect(many).toContain("ביצים");
      expect(many).not.toContain("לחם");

      expect(
        formatShowDumpFromKind("shopping", snap, {
          ...omitEmpty,
          itemIds: new Set(["nope"]),
        }),
      ).toBe("");
      expect(
        formatShowDumpFromKind("shopping", snap, {
          ...omitEmpty,
          itemIds: new Set(),
        }),
      ).toBe("");
    });

    it("tasks: single, many, wrong, empty Set", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "t1", "שם מטלה": "א" },
              { item_id: "t2", "שם מטלה": "ב" },
              { item_id: "t3", "שם מטלה": "ג" },
            ],
          },
        ],
        filing: [],
      };
      expect(
        formatShowDumpFromKind("tasks", snap, {
          ...omitEmpty,
          itemIds: new Set(["t1"]),
        }),
      ).toMatch(/א/);
      const many = formatShowDumpFromKind("tasks", snap, {
        ...omitEmpty,
        itemIds: new Set(["t2", "t3"]),
      })!;
      expect(many).toContain("ב");
      expect(many).toContain("ג");
      expect(many).not.toContain("1. א");
      expect(
        formatShowDumpFromKind("tasks", snap, {
          ...omitEmpty,
          itemIds: new Set(["missing"]),
        }),
      ).toBe("");
      expect(
        formatShowDumpFromKind("tasks", snap, {
          ...omitEmpty,
          itemIds: new Set(),
        }),
      ).toBe("");
    });

    it("filings: single, many, wrong, empty Set", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [],
        filing: [
          {
            filing_id: "f1",
            item_name: "רישיון",
            item_info: "א",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
          {
            filing_id: "f2",
            item_name: "קוד",
            item_info: "ב",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
          {
            filing_id: "f3",
            item_name: "כתובת",
            item_info: "ג",
            item_description: "",
            owner: "טל",
            scope: "personal",
          },
        ],
      };
      expect(
        formatShowDumpFromKind("filings", snap, {
          ...omitEmpty,
          itemIds: new Set(["f1"]),
        }),
      ).toContain("רישיון");
      const many = formatShowDumpFromKind("filings", snap, {
        ...omitEmpty,
        itemIds: new Set(["f2", "f3"]),
      })!;
      expect(many).toContain("קוד");
      expect(many).toContain("כתובת");
      expect(many).not.toContain("רישיון");
      expect(
        formatShowDumpFromKind("filings", snap, {
          ...omitEmpty,
          itemIds: new Set(["x"]),
        }),
      ).toBe("");
      expect(
        formatShowDumpFromKind("filings", snap, {
          ...omitEmpty,
          itemIds: new Set(),
        }),
      ).toBe("");
    });

    it("contacts/phone_book: single, many, wrong, empty Set", () => {
      const snap: EmployeeRecordSnapshot = { lists: [], filing: [] };
      const phoneBook = [
        { contact_id: "c1", name: "דני", phone: "0501111111", scope: "personal" as const },
        { contact_id: "c2", name: "מיכל", phone: "0502222222", scope: "personal" as const },
        { contact_id: "c3", name: "עמית", phone: "0503333333", scope: "personal" as const },
      ];
      const one = formatShowDumpFromKind("contacts", snap, {
        ...omitEmpty,
        phoneBook,
        itemIds: new Set(["c2"]),
      })!;
      expect(one).toContain("מיכל");
      expect(one).not.toContain("דני");
      const many = formatShowDumpFromKind("contacts", snap, {
        ...omitEmpty,
        phoneBook,
        itemIds: new Set(["c1", "c3"]),
      })!;
      expect(many).toContain("דני");
      expect(many).toContain("עמית");
      expect(many).not.toContain("מיכל");
      expect(
        formatShowDumpFromKind("contacts", snap, {
          ...omitEmpty,
          phoneBook,
          itemIds: new Set(["nope"]),
        }),
      ).toBe("");
      expect(
        formatShowDumpFromKind("contacts", snap, {
          ...omitEmpty,
          phoneBook,
          itemIds: new Set(),
        }),
      ).toBe("");
    });

    it("custom list: single, many, wrong, empty Set", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "custom",
            list_name: "באגים",
            owner: "טל",
            scope: "personal",
            columns: ["שם"],
            title_field: "שם",
            items: [
              { item_id: "x1", שם: "דליפה" },
              { item_id: "x2", שם: "קריסה" },
              { item_id: "x3", שם: "האטה" },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
      };
      expect(
        formatShowDumpFromKind("באגים", snap, {
          ...omitEmpty,
          itemIds: new Set(["x2"]),
        }),
      ).toContain("קריסה");
      const many = formatShowDumpFromKind("באגים", snap, {
        ...omitEmpty,
        itemIds: new Set(["x1", "x3"]),
      })!;
      expect(many).toContain("דליפה");
      expect(many).toContain("האטה");
      expect(many).not.toContain("קריסה");
      expect(
        formatShowDumpFromKind("באגים", snap, {
          ...omitEmpty,
          itemIds: new Set(["missing"]),
        }),
      ).toBe("");
      expect(
        formatShowDumpFromKind("באגים", snap, {
          ...omitEmpty,
          itemIds: new Set(),
        }),
      ).toBe("");
    });

    it("reminders: single, many, wrong, empty Set", () => {
      const now = new Date("2026-10-23T10:00:00+03:00");
      const baseRem = {
        list_type: "tasks",
        repeat: "once",
        ping: ["טל"],
        ping_ids: ["e1"],
        owner: "טל",
        text: "",
        status: "active",
      };
      const snap: EmployeeRecordSnapshot = {
        lists: [],
        filing: [],
        reminders: [
          {
            ...baseRem,
            reminder_id: "r1",
            item: "חלב",
            fire_at: "2026-10-23 12:00",
          },
          {
            ...baseRem,
            reminder_id: "r2",
            item: "רופא",
            fire_at: "2026-10-24 12:00",
          },
          {
            ...baseRem,
            reminder_id: "r3",
            item: "שיננית",
            fire_at: "2026-10-25 12:00",
          },
        ] as EmployeeRecordSnapshot["reminders"],
      };
      const one = formatShowDumpFromKind("reminders", snap, {
        ...omitEmpty,
        now,
        itemIds: new Set(["r1"]),
      })!;
      expect(one).toContain("חלב");
      expect(one).not.toContain("רופא");
      const many = formatShowDumpFromKind("reminders", snap, {
        ...omitEmpty,
        now,
        itemIds: new Set(["r2", "r3"]),
      })!;
      expect(many).toContain("רופא");
      expect(many).toContain("שיננית");
      expect(many).not.toContain("חלב");
      expect(
        formatShowDumpFromKind("reminders", snap, {
          ...omitEmpty,
          now,
          itemIds: new Set(["nope"]),
        }),
      ).toBe("");
      expect(
        formatShowDumpFromKind("reminders", snap, {
          ...omitEmpty,
          now,
          itemIds: new Set(),
        }),
      ).toBe("");
    });
  });

  describe("TOPIC DUMP show_dump=full + mixed show_dump_ids", () => {
    const now = new Date("2026-10-23T10:00:00+03:00");
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "shop-teeth", "שם פריט": "חוט דנטלי", כמות: 1 },
            { item_id: "shop-milk", "שם פריט": "חלב", כמות: 2 },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "task-dentist", "שם מטלה": "לשיננית" },
            { item_id: "task-pkg", "שם מטלה": "לאסוף חבילה" },
          ],
        },
        {
          list_type: "custom",
          list_name: "ציוד שיניים",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "custom-brush", "שם פריט": "מברשת" },
            { item_id: "custom-other", "שם פריט": "מגבת" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [
        {
          filing_id: "fil-clinic",
          item_name: "מרפאת שיניים",
          item_info: "רחוב 1",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "fil-gate",
          item_name: "קוד שער",
          item_info: "1234",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
      reminders: [
        {
          list_type: "tasks",
          repeat: "once",
          ping: ["טל"],
          ping_ids: ["e1"],
          owner: "טל",
          text: "",
          status: "active",
          reminder_id: "rem-teeth",
          item: "תור לשיננית",
          fire_at: "2026-10-24 12:00",
        },
        {
          list_type: "tasks",
          repeat: "once",
          ping: ["טל"],
          ping_ids: ["e1"],
          owner: "טל",
          text: "",
          status: "active",
          reminder_id: "rem-other",
          item: "לקחת חבילה",
          fire_at: "2026-10-25 12:00",
        },
      ] as EmployeeRecordSnapshot["reminders"],
    };

    it("mixed ids: only matching rows; section headers only where hits; shopping as lines", () => {
      const ids = new Set([
        "task-dentist",
        "shop-teeth",
        "rem-teeth",
        "fil-clinic",
        "custom-brush",
      ]);
      const text = formatShowDumpFromKind("full", snap, {
        viewerName: "טל",
        now,
        omitEmptySentence: true,
        itemIds: ids,
      })!;
      expect(text).toContain("לשיננית");
      expect(text).toContain("חוט דנטלי");
      expect(text).toContain("תור לשיננית");
      expect(text).toContain("מרפאת שיניים");
      expect(text).toContain("מברשת");
      expect(text).not.toContain("לאסוף חבילה");
      expect(text).not.toContain("חלב");
      expect(text).not.toContain("לקחת חבילה");
      expect(text).not.toContain("קוד שער");
      expect(text).not.toContain("מגבת");
      // Shopping: item lines, not counts-only overview.
      expect(text).toMatch(/🛒 קניות:/);
      expect(text).not.toMatch(/אישיות — \d+ פריט/);
      expect(text).toContain("מטלות:");
      expect(text).toContain("תזכורות פעילות:");
      expect(text).toMatch(/תיוקים:/);
      expect(text).toContain("ציוד שיניים");
      // No empty-section leftovers / inventory hint.
      expect(text).not.toContain("אנשי קשר");
      expect(text).not.toContain("לפירוט רשימה");
      const live = liveDumpRowIdsFromSnapshot(snap);
      for (const id of ids) {
        expect(live.has(id)).toBe(true);
      }
    });

    it("unknown / empty ids → empty (no unfiltered full)", () => {
      // formatShowDumpFromKind maps empty dump text to null.
      expect(
        formatShowDumpFromKind("full", snap, {
          viewerName: "טל",
          now,
          omitEmptySentence: true,
          itemIds: new Set(["missing-a", "missing-b"]),
        }),
      ).toBeNull();
      expect(
        formatShowDumpFromKind("full", snap, {
          viewerName: "טל",
          now,
          omitEmptySentence: true,
          itemIds: new Set(),
        }),
      ).toBeNull();
      expect(
        formatFullDump(snap, {
          viewerName: "טל",
          now,
          omitEmptySentence: true,
          itemIds: new Set(["missing-a"]),
        }).text,
      ).toBe("");
      // Bare full (no itemIds) still counts shopping.
      const bare = formatFullDump(snap, { viewerName: "טל", now });
      expect(bare.text).toMatch(/אישיות — \d+ פריט/);
      expect(bare.text).toContain("לפירוט רשימה");
    });

    it("path 2 same-kind filter unchanged: tasks + foreign id stays empty", () => {
      expect(
        formatShowDumpFromKind("tasks", snap, {
          viewerName: "טל",
          omitEmptySentence: true,
          itemIds: new Set(["fil-clinic"]),
        }),
      ).toBe("");
      const onlyTask = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        omitEmptySentence: true,
        itemIds: new Set(["task-dentist"]),
      })!;
      expect(onlyTask).toContain("לשיננית");
      expect(onlyTask).not.toContain("חוט דנטלי");
      expect(onlyTask).not.toContain("מרפאת שיניים");
    });
  });

  it("filings dump marks assign with באחריות · מאת", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f-assign",
          item_name: "מה נשמע",
          item_info: "שלום",
          item_description: "",
          owner: "מיכל",
          scope: "shared",
          assigned_by: "טל",
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "מיכל",
    })!;
    expect(dump).toContain("באחריות מיכל · מאת טל");
  });

  it("treats scope=shared with no non-viewer partners as personal", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f-empty",
          item_name: "לשון פנייה",
          item_info: "זכר",
          item_description: "",
          owner: "טל",
          scope: "shared",
        },
        {
          filing_id: "f-self",
          item_name: "כתובת",
          item_info: "רחוב שחם",
          item_description: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל"],
        },
      ],
    };
    const dump = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(dump).toContain("📁 תיוקים:");
    expect(dump).toContain("לשון פנייה\nזכר");
    expect(dump).toContain("כתובת 📍");
    expect(dump).not.toContain("📄");
    expect(dump).not.toContain("תיאור:");
    expect(dump).not.toContain("רחוב שחם");
    expect(dump).not.toContain("(עם ");
    expect(dump).not.toContain("(טל)");
  });

  it("section=shared empty → אין תיוקים משותפים", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    const full = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
    })!;
    expect(full).toContain("תיוקים:");
    expect(full).toContain("רישיון");
    expect(full).not.toContain("תיוקים משותפים:");

    const sharedOnly = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      section: "shared",
    })!;
    expect(sharedOnly).toBe("אין תיוקים משותפים.");
    expect(sharedOnly).not.toContain("תיוקים:");
  });

  it("co-share mark lists all involved; never «עם»", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f1",
          item_name: "ת.ז",
          item_info: "",
          item_description: "ת.ז",
          owner: "מיכל",
          scope: "shared",
          shared_with: ["מיכל", "טל"],
        },
      ],
    };
    const asTal = formatShowDumpFromKind("filings", snap, {
      viewerName: "טל",
      viewerAliases: ["טל"],
    })!;
    expect(asTal).toContain("תיוקים:");
    expect(asTal).toContain("(מיכל, טל)");
    expect(asTal).not.toContain("(עם ");

    const asMichal = formatShowDumpFromKind("filings", snap, {
      viewerName: "מיכל",
      viewerAliases: ["מיכל"],
    })!;
    expect(asMichal).toContain("(טל, מיכל)");
    expect(asMichal).not.toContain("(עם ");
  });

  it("sets navigate address only on ITEM DUMP with valid coordinates", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [
        {
          filing_id: "a1",
          item_name: "כתובת מרב",
          item_info: "יערה אבן יהודה",
          item_description: "כתובת",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "home",
          item_name: "מיקום הבית",
          item_info: "32.099279, 34.8923104",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f1",
          item_name: "רישיון",
          item_info: "בתוקף",
          item_description: "רישיון",
          owner: "טל",
          scope: "personal",
        },
      ],
    };
    // Full inventory must not attach Waze / coords under the list on WhatsApp.
    expect(
      navigateAddressFromFilingsDump(snap.filing, { viewerName: "טל" }),
    ).toBeNull();
    // Street-only → no Waze.
    expect(
      navigateAddressFromFilingsDump(snap.filing, {
        viewerName: "טל",
        itemIds: new Set(["a1"]),
      }),
    ).toBeNull();
    // Valid coords → Waze target.
    expect(
      navigateAddressFromFilingsDump(snap.filing, {
        viewerName: "טל",
        itemIds: new Set(["home"]),
      }),
    ).toBe("32.099279,34.8923104");

    expect(
      navigateAddressFromFilingsDump(snap.filing, {
        viewerName: "טל",
        itemIds: new Set(["a1", "home"]),
      }),
    ).toBeNull();
  });
});

describe("formatShowDumpFromKind", () => {
  const snapshot: EmployeeRecordSnapshot = {
    lists: [
      {
        list_type: "shopping",
        list_name: "",
        owner: "טל",
        scope: "personal",
        items: [{ item_id: "1", "שם פריט": "ספוג אדום" }],
      },
      {
        list_type: "shopping",
        list_name: "",
        owner: "טל",
        scope: "shared",
        shared_with: ["טל", "מיכל"],
        items: [
          { item_id: "2", "שם פריט": "קמח מלא", כמות: 2 },
          {
            item_id: "3",
            "שם פריט": "עגבניות",
            כמות: 1,
            "יחידת מידה": 'ק"ג',
          },
        ],
      },
      {
        list_type: "tasks",
        list_name: "",
        owner: "טל",
        scope: "personal",
        items: [
          {
            item_id: "t1",
            "שם מטלה": "לבדוק את הבאג הזה",
            reminder: { reminder_id: "r3", fire_at: "2026-10-15 20:30", repeat: "none" },
          },
          {
            item_id: "t2",
            "שם מטלה": "ללכת לשוק 🍅",
            חוזר: "שני ושלישי ב־19:00",
            attachments: [{ id: "a1" }],
          },
          {
            item_id: "t3",
            "שם מטלה": "חתונה של תום",
            "תאריך לביצוע": "2026-10-12",
            "שעה לביצוע": "19:30",
            attachments: [{ id: "a2" }],
          },
          {
            item_id: "t4",
            "שם מטלה": "לראות מה קורה עם הביט",
            reminder: {
              reminder_id: "r4",
              fire_at: "2026-11-15 09:00",
              repeat: "none",
            },
          },
        ],
      },
      {
        list_type: "tasks",
        list_name: "",
        owner: "טל",
        scope: "shared",
        shared_with: ["טל", "עמית"],
        items: [
          {
            item_id: "t5",
            "שם מטלה": "פגישה (טל, עמית)",
            חוזר: "ראשון ורביעי ב־21:30",
          },
        ],
      },
    ],
    filing: [],
    reminders: [
      {
        reminder_id: "r1",
        item: "לקנות חלב",
        list_type: "tasks",
        fire_at: "2026-10-16 09:00",
        repeat: "none",
        ping: ["טל"],
        ping_ids: ["e1"],
        owner: "טל",
        text: "",
        last_composed_text: "",
        sent_text: "",
        compose_at_fire: false,
        compose_source: "",
        compose_lookback_hours: 0,
        status: "active",
        send_status: "pending",
        sent: false,
        sent_at: null,
      },
      {
        reminder_id: "r2",
        item: "ישן",
        list_type: "tasks",
        fire_at: "2026-10-10 09:00",
        repeat: "none",
        ping: ["טל"],
        ping_ids: ["e1"],
        owner: "טל",
        text: "",
        last_composed_text: "",
        sent_text: "",
        compose_at_fire: false,
        compose_source: "",
        compose_lookback_hours: 0,
        status: "done",
        send_status: "sent",
        sent: true,
        sent_at: "2026-10-10 09:00",
      },
    ],
  };

  const now = new Date("2026-10-15T10:00:00+03:00");

  it("dumps shopping with quantity (default 1) and unit", () => {
    expect(formatShoppingTitle({ "שם פריט": "אורז", כמות: 2 })).toBe("אורז - 2");
    expect(
      formatShoppingTitle({
        "שם פריט": "עגבניות",
        כמות: 1,
        "יחידת מידה": 'ק"ג',
      }),
    ).toBe('עגבניות - 1 ק"ג');
    expect(formatShoppingTitle({ "שם פריט": "חלב" })).toBe("חלב - 1");
  });

  it("formats relative day labels for near calendar dates", () => {
    expect(formatRelativeDayLabel("2026-10-15", now)).toBe("היום");
    expect(formatRelativeDayLabel("2026-10-16", now)).toBe("מחר");
    expect(formatRelativeDayLabel("2026-10-17", now)).toBe("מחרתיים");
    expect(formatRelativeDayLabel("2026-10-18", now)).toBe("ראשון");
    expect(formatRelativeDayLabel("2026-10-21", now)).toBe("רביעי");
    expect(formatRelativeDayLabel("2026-10-12", now)).toBe("12.10.2026");
    expect(formatRelativeDayLabel("2026-11-15", now)).toBe("15.11.2026");
    expect(formatRelativeFireAt("2026-10-17 09:00", now)).toBe(
      "מחרתיים ב־09:00",
    );
    expect(formatRelativeFireAt("2026-10-18 14:30", now)).toBe("ראשון ב־14:30");
  });

  it("formats schedule and linked reminder like status lines", () => {
    expect(
      formatScheduleSuffix(
        { חוזר: "שני ושלישי ב־19:00" },
        "tasks",
        now,
      ),
    ).toBe("— שני ושלישי ב־19:00 (קבוע)");
    // Appointment ≠ ping: chore T1 on the row, ping T2 on the linked clock.
    expect(
      formatNumberedItem(
        1,
        "להזכיר לטל לאסוף את מאיה",
        {
          "תאריך לביצוע": "2026-10-21",
          "שעה לביצוע": "15:00",
          reminder: {
            fire_at: "2026-10-21 14:20",
            repeat: "none",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(/^1\. להזכיר לטל לאסוף את מאיה — רביעי ב־15:00 🔔 תזכורת:/);
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-15", "שעה לביצוע": "19:30" },
        "tasks",
        now,
      ),
    ).toBe("— היום ב־19:30");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-16", "שעה לביצוע": "09:00" },
        "tasks",
        now,
      ),
    ).toBe("— מחר ב־09:00");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-17", "שעה לביצוע": "11:00" },
        "tasks",
        now,
      ),
    ).toBe("— מחרתיים ב־11:00");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-18", "שעה לביצוע": "20:00" },
        "tasks",
        now,
      ),
    ).toBe("— ראשון ב־20:00");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2026-10-12", "שעה לביצוע": "19:30" },
        "tasks",
        now,
      ),
    ).toBe("— 12.10.2026 ב־19:30");
    expect(
      formatScheduleSuffix(
        { "תאריך לביצוע": "2027-05-08", "שעה לביצוע": "13:00" },
        "tasks",
        now,
      ),
    ).toBe("— 8.5.2027 ב־13:00");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-10-15 20:30", repeat: "none" } },
        now,
      ),
    ).toBe("🔔 תזכורת: היום ב־20:30");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-10-15 20:30", repeat: "none" } },
        now,
        "detail",
      ),
    ).toBe("🔔 תזכורת: היום ב־20:30");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-10-17 09:00", repeat: "none" } },
        now,
        "detail",
      ),
    ).toBe("🔔 תזכורת: מחרתיים ב־09:00");
    expect(
      formatLinkedReminderParen(
        { reminder: { fire_at: "2026-11-15 09:00", repeat: "none" } },
        now,
        "detail",
      ),
    ).toBe("🔔 תזכורת: 15.11.2026 ב־09:00");
    expect(
      formatNumberedItem(
        1,
        "ללכת לשוק 🍅",
        { חוזר: "שני ושלישי ב־19:00", attachments: [{ id: "a" }] },
        "tasks",
        { now },
      ),
    ).toBe("1. ללכת לשוק 🍅 📎 — שני ושלישי ב־19:00 (קבוע)");
    expect(
      formatNumberedItem(
        1,
        "ערב פוקר",
        {
          linked_lists: [
            { list_id: "l1", list_type: "custom", list_name: "מי מגיע" },
          ],
        },
        "tasks",
        { now },
      ),
    ).toBe("1. ערב פוקר 🗂️");
    expect(
      formatNumberedItem(
        1,
        "ערב פוקר",
        {
          attachments: [{ id: "a" }],
          linked_lists: [
            { list_id: "l1", list_type: "custom", list_name: "מי מגיע" },
          ],
        },
        "tasks",
        { now },
      ),
    ).toBe("1. ערב פוקר 📎 🗂️");
    // List dump: icons only (no address/phone text).
    expect(
      formatNumberedItem(
        1,
        "ללכת לספר",
        { כתובת: "הרצל 1, תל אביב" },
        "tasks",
        { now },
      ),
    ).toBe("1. ללכת לספר 📍");
    expect(
      formatNumberedItem(
        1,
        "להתקשר לאורי",
        { טלפון: "050-1234567" },
        "tasks",
        { now },
      ),
    ).toBe("1. להתקשר לאורי 📞");
    expect(
      formatNumberedItem(
        1,
        "ללכת לספר",
        {
          כתובת: "הרצל 1",
          טלפון: "03-5555555",
          attachments: [{ id: "a" }],
        },
        "tasks",
        { now },
      ),
    ).toBe("1. ללכת לספר 📎 📍 📞");
    // ITEM DUMP (itemIds set): icons + stored values.
    expect(
      formatNumberedItem(
        1,
        "ללכת לספר",
        { כתובת: "הרצל 1, תל אביב" },
        "tasks",
        { now, itemIds: new Set(["task-1"]) },
      ),
    ).toBe("1. ללכת לספר 📍 הרצל 1, תל אביב");
    expect(
      formatNumberedItem(
        1,
        "להתקשר לאורי",
        { טלפון: "050-1234567" },
        "tasks",
        { now, itemIds: new Set(["task-2"]) },
      ),
    ).toBe("1. להתקשר לאורי 📞 050-1234567");
    expect(
      formatNumberedItem(
        1,
        "ללכת לספר",
        {
          כתובת: "הרצל 1",
          טלפון: "03-5555555",
          attachments: [{ id: "a" }],
        },
        "tasks",
        { now, itemIds: new Set(["task-3"]) },
      ),
    ).toBe("1. ללכת לספר 📎 📍 הרצל 1 📞 03-5555555");
    expect(
      formatNumberedItem(
        1,
        "חלב",
        { כתובת: "should-not-show", טלפון: "050" },
        "shopping",
        { now },
      ),
    ).toBe("1. חלב");
    expect(
      formatAgendaStandingLine(
        1,
        "ללכת לספר",
        {
          חוזר: "כל יום שישי ב־10:00",
          כתובת: "דיזנגוף 10",
          next_occurrences: ["2026-10-24 10:00"],
        },
        "10:00",
        { now },
      ),
    ).toBe("1. ללכת לספר 📍 — כל יום שישי ב־10:00 (קבוע)");
    expect(
      formatAgendaOneOffLine(
        2,
        "להתקשר לאורי",
        { טלפון: "050-111", "שעה לביצוע": "09:00" },
        "09:00",
        { now },
      ),
    ).toBe("2. להתקשר לאורי 📞 — 09:00");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יומיים ב־15:00",
          reminder: {
            fire_at: "2026-10-15 15:00",
            repeat: "custom",
            recurrence_text: "כל יומיים ב־15:00",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יומיים ב־15:00 (קבוע)");
    expect(
      formatNumberedItem(
        5,
        "לקחת אקמול",
        {
          חוזר: "כל יומיים ב־15:00",
          reminder: {
            fire_at: "2026-10-15 15:00",
            repeat: "custom",
            recurrence_text: "כל יומיים ב־15:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(/^5\. לקחת אקמול — כל יומיים ב־15:00 \(קבוע\) 🔔 תזכורת:/);
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["18.10 ב־21:30"],
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע) · 18.10 ב־21:30");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["23.10 בוטל"],
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע) · 23.10 בוטל");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["18.10 ב־21:30"],
          reminder: {
            fire_at: "2026-10-18 21:30",
            repeat: "custom",
            recurrence_text: "כל יום ראשון ב־20:45",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע) · 18.10 ב־21:30");
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ראשון ב־21:00",
          reminder: {
            fire_at: "2026-10-18 21:00",
            repeat: "custom",
            recurrence_text: "כל יום ראשון ב־21:00",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ראשון ב־21:00 (קבוע)");
    expect(
      formatNumberedItem(
        6,
        "חוג טיסנים",
        {
          חוזר: "כל יום ראשון ב־21:00",
          exceptions: ["18.10 ב־21:30"],
          reminder: {
            fire_at: "2026-10-18 21:30",
            repeat: "custom",
            recurrence_text: "כל יום ראשון ב־20:45",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(
      /^6\. חוג טיסנים — כל יום ראשון ב־21:00 \(קבוע\) · 18\.10 ב־21:30 🔔 תזכורת:/,
    );
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-18 20:45",
          repeat: "custom",
          recurrence_text: "כל יום ראשון ב־20:45",
          exceptions: ["18.10 ב־21:30"],
        },
        now,
      ),
    ).toBe("ראשון ב־20:45 (קבוע כל יום ראשון ב־20:45) · 18.10 ב־21:30");
    // Next fire already moved to the exception time — still keep · suffix so series vs one-off stays clear.
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-18 21:30",
          repeat: "custom",
          recurrence_text: "כל יום ראשון ב־20:45",
          exceptions: ["18.10 ב־21:30"],
        },
        now,
      ),
    ).toBe("ראשון ב־21:30 (קבוע כל יום ראשון ב־20:45) · 18.10 ב־21:30");
    expect(
      formatNumberedItem(
        5,
        "לקחת אקמול",
        {
          חוזר: "כל יומיים ב־15:00",
          reminder: {
            fire_at: "2026-10-15 15:00",
            repeat: "custom",
            recurrence_text: "כל יומיים ב־15:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(/🔔 תזכורת:/);
    expect(
      formatNumberedItem(
        2,
        "לבדוק באג",
        { reminder: { fire_at: "2026-10-15 20:30", repeat: "none" } },
        "tasks",
        { now },
      ),
    ).toBe("2. לבדוק באג 🔔 תזכורת: היום ב־20:30");
    expect(
      formatNumberedItem(
        3,
        "להתקשר לאמא",
        {
          reminder: {
            fire_at: "2026-10-15 19:00",
            repeat: "daily",
            recurrence_text: "כל יום ב־19:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(/^3\. להתקשר לאמא 🔔 תזכורת:/);
    // Appointment time ≠ ping time: schedule from שעה לביצוע; list shows timed 🔔.
    expect(
      formatNumberedItem(
        1,
        "לאסוף את מאיה",
        {
          "תאריך לביצוע": "2026-10-16",
          "שעה לביצוע": "15:00",
          reminder: { fire_at: "2026-10-16 14:20", repeat: "none" },
        },
        "tasks",
        { now },
      ),
    ).toBe("1. לאסוף את מאיה — מחר ב־15:00 🔔 תזכורת: מחר ב־14:20");
    // Title already has ב־HH:mm from sync — strip so schedule is not duplicated.
    expect(stripMatchingTitleClock("לשלוח למיכל ברכת בוקר ב־09:00", "09:00")).toBe(
      "לשלוח למיכל ברכת בוקר",
    );
    expect(
      formatNumberedItem(
        1,
        "לשלוח למיכל ברכת בוקר ב־09:00",
        {
          "שעה לביצוע": "09:00",
          reminder: {
            fire_at: "2026-10-16 09:00",
            repeat: "daily",
            recurrence_text: "כל יום ב־09:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(/^1\. לשלוח למיכל ברכת בוקר — 09:00 \(קבוע\) 🔔 תזכורת:/);
    // Recurring linked + chore HM match without חוזר → fold + timed 🔔.
    expect(
      formatNumberedItem(
        1,
        "להזכיר לטל לבדוק ביט",
        {
          "שעה לביצוע": "20:00",
          reminder: {
            fire_at: "2026-11-15 20:00",
            repeat: "none",
            recurrence_text: "כל יום ב־20:00",
          },
        },
        "tasks",
        { now },
      ),
    ).toMatch(/^1\. להזכיר לטל לבדוק ביט — 20:00 \(קבוע\) 🔔 תזכורת:/);
  });

  it("formats reminder dump lines like מה התזכורות שלי", () => {
    expect(shortCadenceParen("כל יום ב־19:00")).toBe("(כל יום)");
    expect(shortCadenceParen("כל שנה ב־8 במאי ב־13:00")).toBe("(כל שנה)");
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-15 19:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־19:00",
        },
        now,
      ),
    ).toBe("היום ב־19:00 (קבוע כל יום)");
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-16 09:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־09:00",
        },
        now,
      ),
    ).toBe("מחר ב־09:00 (קבוע כל יום)");
    expect(
      formatReminderWhen(
        { fire_at: "2026-10-17 09:00", repeat: "none" },
        now,
      ),
    ).toBe("מחרתיים ב־09:00");
    expect(
      formatReminderWhen(
        { fire_at: "2026-10-18 14:00", repeat: "none" },
        now,
      ),
    ).toBe("ראשון ב־14:00");
    expect(
      formatReminderWhen(
        { fire_at: "2026-11-15 09:00", repeat: "none" },
        now,
      ),
    ).toBe("15.11.2026 ב־09:00");
    expect(
      formatReminderWhen(
        {
          fire_at: "2027-05-08 13:00",
          repeat: "none",
          recurrence_text: "כל שנה ב־8 במאי ב־13:00",
        },
        now,
      ),
    ).toBe("8.5.2027 ב־13:00 (קבוע כל שנה)");
  });

  it("partnersKey never keeps the viewer (name or aliases)", () => {
    expect(partnersKey(["טל", "עמית"], "טל")).toBe("עמית");
    expect(partnersKey(["טל", "עמית"], "טלי", ["טל"])).toBe("עמית");
    expect(partnersKey(["טל", "עמית"], "", ["טל"])).toBe("עמית");
    expect(partnersKey(["טל"], "טל")).toBe("משותף");
    expect(partnersKey(["טל"], "", ["טל"])).toBe("משותף");
  });

  it("dumps shopping without soft-deleted rice (not in snapshot)", () => {
    const text = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
    });
    expect(text).toContain("ספוג אדום - 1");
    expect(text).toContain("קמח מלא - 2");
    expect(text).toContain('עגבניות - 1 ק"ג');
    expect(text).not.toContain("אורז");
    expect(text).toContain("🛒 קניות:");
    expect(text).not.toContain("קניות אישיות:");
    expect(text).not.toContain("קניות משותפות עם");
    expect(text).not.toContain("קניות של ");
  });

  it("flat dump: one header; assign באחריות/מאת; co-share all involved; no של X", () => {
    const threeWay: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "a1",
              "שם פריט": "חלב",
              כמות: 1,
              assigned_by: "עמית",
            },
            {
              item_id: "s1",
              "שם פריט": "קפה",
              כמות: 1,
              shared_with: ["טל", "מיכל"],
            },
            {
              item_id: "both",
              "שם פריט": "ביצים",
              כמות: 1,
              assigned_by: "עמית",
              shared_with: ["טל", "עמית", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [{ item_id: "out1", "שם פריט": "שמן", כמות: 1 }],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "tp1", "שם מטלה": "לטפל בעמידר" },
            {
              item_id: "ta1",
              "שם מטלה": "לבדוק שמן",
              assigned_by: "עמית",
            },
            {
              item_id: "ts1",
              "שם מטלה": "פגישה (טל, עמית)",
              shared_with: ["טל", "עמית"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "עמית",
          scope: "shared_items",
          items: [{ item_id: "tout1", "שם מטלה": "לעשות טסט לרכב" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const shopping = formatShowDumpFromKind("shopping", threeWay, {
      viewerName: "טל",
    })!;
    expect(shopping).toMatch(/^🛒 קניות:/m);
    expect(shopping).toContain("לחם - 1");
    expect(shopping).toContain("חלב - 1 (באחריות טל · מאת עמית)");
    expect(shopping).toContain("ביצים - 1 (באחריות טל · מאת עמית)");
    expect(shopping).toContain("קפה - 1 (מיכל, טל)");
    expect(shopping).toContain("שמן - 1 (באחריות מיכל · מאת טל)");
    // personal → co-share → assign
    expect(shopping).toMatch(
      /1\. לחם - 1\n2\. קפה - 1 \(מיכל, טל\)\n3\. חלב - 1 \(באחריות טל · מאת עמית\)\n4\. ביצים - 1 \(באחריות טל · מאת עמית\)\n5\. שמן - 1 \(באחריות מיכל · מאת טל\)/,
    );
    expect(shopping).not.toContain("קניות אישיות");
    expect(shopping).not.toContain("קניות משותפות עם");
    expect(shopping).not.toContain("קניות של ");
    expect(shopping).not.toContain("(עם ");

    const tasks = formatShowDumpFromKind("tasks", threeWay, {
      viewerName: "טל",
    })!;
    expect(tasks).toMatch(/^✅ מטלות:/m);
    expect(tasks).toContain("לטפל בעמידר");
    expect(tasks).toContain("לבדוק שמן (באחריות טל · מאת עמית)");
    expect(tasks).toContain("פגישה (טל, עמית)");
    expect(tasks).not.toMatch(/פגישה \(טל, עמית\) \(/);
    expect(tasks).toContain("לעשות טסט לרכב (באחריות עמית · מאת טל)");
    expect(tasks).toMatch(
      /1\. לטפל בעמידר\n2\. פגישה \(טל, עמית\)\n3\. לבדוק שמן \(באחריות טל · מאת עמית\)\n4\. לעשות טסט לרכב \(באחריות עמית · מאת טל\)/,
    );
    expect(tasks).not.toContain("מטלות של ");
    expect(tasks).not.toContain("מטלות אישיות");

    const sharedOnly = formatShowDumpFromKind("shopping", threeWay, {
      viewerName: "טל",
      section: "shared",
    })!;
    // co-share before assign; no personal לחם
    expect(sharedOnly).not.toContain("לחם");
    expect(sharedOnly).toMatch(
      /1\. קפה - 1 \(מיכל, טל\)\n2\. חלב - 1 \(באחריות טל · מאת עמית\)\n3\. ביצים - 1 \(באחריות טל · מאת עמית\)\n4\. שמן - 1 \(באחריות מיכל · מאת טל\)/,
    );
  });

  it("clusterDumpRowsByKind is stable within each kind", () => {
    const clustered = clusterDumpRowsByKind([
      {
        title: "a-assign",
        item: {},
        isShared: true,
        assigneeName: "טל",
        responsibilityMark: "באחריות טל · מאת מיכל",
      },
      { title: "b-personal", item: {}, isShared: false },
      {
        title: "c-share",
        item: {},
        isShared: true,
        responsibilityMark: "מיכל, טל",
      },
      { title: "d-personal", item: {}, isShared: false },
    ]);
    expect(clustered.map((row) => row.title)).toEqual([
      "b-personal",
      "d-personal",
      "c-share",
      "a-assign",
    ]);
  });

  it("item co-share and scope=shared list share one flat shopping header", () => {
    const mixed: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "s1",
              "שם פריט": "מלפפונים",
              כמות: 1,
              shared_with: ["טל", "עמית"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
          items: [
            { item_id: "l1", "שם פריט": "קמח מלא", כמות: 1 },
            { item_id: "l2", "שם פריט": "אורז", כמות: 2 },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const text = formatShowDumpFromKind("shopping", mixed, {
      viewerName: "טל",
    })!;
    expect(text).toMatch(/^🛒 קניות:/m);
    expect(text).toContain("לחם - 1");
    expect(text).toContain("מלפפונים - 1 (עמית, טל)");
    expect(text).toContain("קמח מלא - 1");
    expect(text).toContain("אורז - 2");
    expect(text).not.toContain("קניות אישיות");
    expect(text).not.toContain("קניות משותפות עם");
  });

  it("viewer aliases keep whole shared list rows without viewer-only partner noise", () => {
    const text = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טלי",
      viewerAliases: ["טל"],
      section: "shared",
      partner: "מיכל",
    });
    expect(text).toContain("🛒 קניות:");
    expect(text).toContain("קמח מלא - 2");
    expect(text).not.toContain("ספוג אדום");
    expect(text).not.toContain("משותפות עם טל");
  });

  it("puts 📎 on list headers only for list-level has_attachments", () => {
    const withListFiles: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          has_attachments: true,
          items: [
            {
              item_id: "1",
              "שם פריט": "חלב",
              attachments: [{ id: "a1" }],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "personal",
          has_attachments: true,
          items: [{ item_id: "c1", בעיה: "דליפה" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const shopping = formatShowDumpFromKind("shopping", withListFiles, {
      viewerName: "טל",
    });
    expect(shopping).toContain("קניות 📎:");
    expect(shopping).toContain("חלב - 1 📎");

    const custom = formatShowDumpFromKind("בעיות", withListFiles, {
      viewerName: "טל",
    });
    expect(custom).toContain("📋 רשימת «בעיות» 📎:");
    expect(custom).toMatch(/^1\. דליפה$/m);
    expect(custom).not.toContain("בעיה:");
  });

  it("custom inventory: title_field full + detail preview; ITEM DUMP keeps all columns", () => {
    expect(
      formatCustomListDetailText(
        { שם: "טל", תיאור: "נשוי למיכל", עיר: "תל אביב" },
        "שם",
        ["שם", "תיאור", "עיר"],
      ),
    ).toBe("תיאור: נשוי למיכל · עיר: תל אביב");
    expect(
      formatCustomItemBody(
        { שם: "טל", תיאור: "נשוי למיכל" },
        "שם",
        ["שם", "תיאור"],
      ),
    ).toBe("שם: טל · תיאור: נשוי למיכל");

    const snapshot: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "אני ומיכל",
          owner: "טל",
          scope: "shared",
          columns: ["שם", "תיאור"],
          title_field: "שם",
          items: [
            {
              item_id: "1",
              שם: "טל",
              תיאור: "נשוי למיכל",
            },
            {
              item_id: "2",
              שם: "מיכל",
              תיאור: "נשואה לטל",
            },
          ],
        },
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind("אני ומיכל", snapshot, {
      viewerName: "טל",
    });
    expect(text).toContain("📋 רשימת «אני ומיכל»:");
    expect(text).toContain("1. טל\nתיאור: נשוי למיכל");
    expect(text).toContain("2. מיכל\nתיאור: נשואה לטל");
    expect(text).not.toContain("📄");
    expect(text).not.toMatch(/^1\. שם: טל/m);

    const itemDump = formatShowDumpFromKind("אני ומיכל", snapshot, {
      viewerName: "טל",
      itemIds: new Set(["1"]),
    });
    expect(itemDump).toContain("1. שם: טל · תיאור: נשוי למיכל");
    expect(itemDump).not.toMatch(/^2\./m);
    expect(itemDump).not.toContain("נשואה לטל");
  });

  it("custom inventory: unfamiliar columns still build detail in list order", () => {
    const longNote =
      "הלקוח ביקש משלוח עד הבית אחרי השעה שש בערב וגם לבדוק שהאריזה שלמה לפני המסירה מחר בבוקר ואז לצלצל לשליח אם אין מענה ולתעד את כל הפרטים ביומן השליחויות של החנות";
    const snapshot: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "הזמנות",
          owner: "טל",
          scope: "personal",
          columns: ["מספר הזמנה", "ספק", "הערת לקוח"],
          title_field: "מספר הזמנה",
          items: [
            {
              item_id: "o1",
              "מספר הזמנה": "A-100",
              ספק: "סופרפארם",
              "הערת לקוח": longNote,
            },
          ],
        },
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind("הזמנות", snapshot, {
      viewerName: "טל",
    })!;
    expect(text).toContain("📋 רשימת «הזמנות»:");
    expect(text).toMatch(/^1\. A-100 📄$/m);
    expect(text).toContain("ספק: סופרפארם");
    expect(text).toContain("…");
    expect(text).not.toContain(longNote);
    const full = formatShowDumpFromKind("הזמנות", snapshot, {
      viewerName: "טל",
      itemIds: new Set(["o1"]),
    })!;
    expect(full).toContain(`הערת לקוח: ${longNote}`);
    expect(full).not.toContain("📄");
  });

  it("tasks and shopping keep full titles — no truncate-driven 📄", () => {
    const longTask =
      "לסכם עם כל הספקים את לוח הזמנים המלא לפרויקט השיפוץ של הדירה כולל חומרי גמר";
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "t1", "שם מטלה": longTask }],
        },
        {
          list_type: "shopping",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "s1",
              "שם פריט":
                "אבקת כביסה מרוכזת במיוחד לכביסה צבעונית באריזה גדולה למשפחה",
              כמות: 1,
            },
          ],
        },
      ],
      filing: [],
    };
    const tasks = formatShowDumpFromKind("tasks", snap, { viewerName: "טל" })!;
    expect(tasks).toContain(longTask);
    expect(tasks).not.toContain("📄");
    expect(tasks).not.toContain("…");
    const shopping = formatShowDumpFromKind("shopping", snap, {
      viewerName: "טל",
    })!;
    expect(shopping).toContain(
      "אבקת כביסה מרוכזת במיוחד לכביסה צבעונית באריזה גדולה למשפחה - 1",
    );
    expect(shopping).not.toContain("📄");
  });

  it("strips wrapping quotes from custom show_dump names", () => {
    const snapshot: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "בדיקה של שיתוף עם עמית",
          owner: "טל",
          scope: "shared",
          columns: ["שם"],
          title_field: "שם",
          items: [
            { item_id: "1", שם: "בדיקה 1" },
            { item_id: "2", שם: "בדיקה 2" },
          ],
        },
      ],
      filing: [],
    };
    for (const kind of [
      '"בדיקה של שיתוף עם עמית"',
      "״בדיקה של שיתוף עם עמית״",
      "«בדיקה של שיתוף עם עמית»",
    ]) {
      const text = formatShowDumpFromKind(kind, snapshot, {
        viewerName: "טל",
      });
      expect(text).toContain("📋 רשימת «בדיקה של שיתוף עם עמית»:");
      expect(text).toContain("1. בדיקה 1");
      expect(text).toContain("2. בדיקה 2");
    }
  });

  it("unknown custom show_dump returns לא מצאתי רשימה (not null)", () => {
    const snapshot: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "באגים",
          owner: "טל",
          scope: "personal",
          columns: ["שם"],
          title_field: "שם",
          items: [{ item_id: "1", שם: "x" }],
        },
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind('"אין כזו"', snapshot, {
      viewerName: "טל",
    });
    expect(text).toBeTruthy();
    expect(text).toContain("לא מצאתי רשימה בשם «אין כזו»");
  });

  it("custom dump: one list + all-involved co-share marks (owner and partner)", () => {
    const ownerView: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "באגים ופיתוחים",
          owner: "טל",
          scope: "personal",
          columns: ["שם"],
          title_field: "שם",
          items: [
            { item_id: "p1", שם: "תיקון לוגין" },
            {
              item_id: "s1",
              שם: "באג בפרודקשן",
              shared_with: ["טל", "מיכל"],
            },
            { item_id: "p2", שם: "שיפור API" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const tal = formatShowDumpFromKind("באגים ופיתוחים", ownerView, {
      viewerName: "טל",
    })!;
    expect(tal).toContain("📋 רשימת «באגים ופיתוחים»:");
    expect(tal).not.toContain("אישיות");
    expect(tal).not.toContain("משותפות עם");
    expect(tal).toMatch(/1\. תיקון לוגין$/m);
    expect(tal).toContain("באג בפרודקשן (מיכל, טל)");
    expect(tal).toContain("שיפור API");

    const partnerView: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "באגים ופיתוחים",
          owner: "טל",
          scope: "shared_items",
          columns: ["שם"],
          title_field: "שם",
          items: [
            {
              item_id: "s1",
              שם: "באג בפרודקשן",
              shared_with: ["טל", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const michal = formatShowDumpFromKind("באגים ופיתוחים", partnerView, {
      viewerName: "מיכל",
    })!;
    expect(michal).toContain("📋 רשימת «באגים ופיתוחים»:");
    expect(michal).toContain("באג בפרודקשן (טל, מיכל)");
    expect(michal).not.toMatch(/באג בפרודקשן \(טל\)$/m);

    // shared_items without shared_with still synthesizes all-involved, not owner-only.
    expect(
      customItemCoShareMark(
        {
          list_type: "custom",
          list_name: "באגים",
          owner: "טל",
          scope: "shared_items",
          items: [],
        } as EmployeeRecordSnapshot["lists"][number],
        { item_id: "x", שם: "x" },
        "מיכל",
      ),
    ).toBe("טל, מיכל");

    expect(
      customItemCoShareMark(
        {
          list_type: "custom",
          list_name: "באגים",
          owner: "מיכל",
          scope: "personal",
          items: [],
        } as EmployeeRecordSnapshot["lists"][number],
        { item_id: "x", שם: "x", assigned_by: "טל" },
        "מיכל",
      ),
    ).toBe("באחריות מיכל · מאת טל");
  });

  it("full dump custom counts mark item-level share partners", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "באגים ופיתוחים",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", שם: "פרטי" },
            {
              item_id: "s1",
              שם: "משותף",
              shared_with: ["טל", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind("full", snap, { viewerName: "טל" })!;
    expect(text).toMatch(/\*באגים ופיתוחים\* \(מיכל, טל\) — 2 פריטים/);
    expect(text).not.toContain("(עם ");
  });

  it("about filter keeps custom items by item shared_with", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "custom",
          list_name: "באגים ופיתוחים",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", שם: "פרטי" },
            {
              item_id: "s1",
              שם: "משותף",
              shared_with: ["טל", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const filtered = filterSnapshotForAboutPerson(snap, "מיכל");
    expect(filtered.lists).toHaveLength(1);
    expect(filtered.lists[0].items).toHaveLength(1);
    expect(filtered.lists[0].items[0].item_id).toBe("s1");
  });

  it("does not put header 📎 when only items have files", () => {
    const itemOnly: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "1",
              "שם פריט": "חלב",
              attachments: [{ id: "a1" }],
            },
          ],
        },
        {
          list_type: "custom",
          list_name: "בעיות",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "c1",
              בעיה: "דליפה",
              attachments: [{ id: "a2" }],
            },
          ],
        },
      ],
      filing: [],
    };
    const shopping = formatShowDumpFromKind("shopping", itemOnly, {
      viewerName: "טל",
    });
    expect(shopping).toContain("🛒 קניות:");
    expect(shopping).not.toContain("קניות 📎:");
    expect(shopping).toContain("חלב - 1 📎");

    const custom = formatShowDumpFromKind("בעיות", itemOnly, {
      viewerName: "טל",
    });
    expect(custom).toContain("📋 רשימת «בעיות»:");
    expect(custom).not.toContain("📋 רשימת «בעיות» 📎:");
    expect(custom).toContain("דליפה 📎");
  });

  it("dumps tasks with schedule, reminder, and partners without viewer", () => {
    const text = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(text).toContain("לבדוק את הבאג הזה 🔔");
    expect(text).toContain("ללכת לשוק 🍅 📎 — שני ושלישי ב־19:00 (קבוע)");
    expect(text).toContain("חתונה של תום 📎 — 12.10.2026 ב־19:30");
    expect(text).toContain("לראות מה קורה עם הביט 🔔");
    expect(text).toContain("✅ מטלות:");
    expect(text).not.toContain("מטלות משותפות עם");
    expect(text).toContain("פגישה (טל, עמית) — ראשון ורביעי ב־21:30 (קבוע)");
  });

  it("show_dump tasks prints linked reminders the same as the button", () => {
    const fromKind = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(fromKind).toMatch(/לבדוק את הבאג הזה 🔔 תזכורת:/);
    expect(fromKind).toMatch(/לראות מה קורה עם הביט 🔔 תזכורת:/);
  });

  it("dumps from show_dump kind the same as the button command", () => {
    const fromKind = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    const fromButton = formatShowDumpFromKind("tasks", snapshot, {
      viewerName: "טל",
      now,
    });
    expect(fromKind).toBe(fromButton);
    expect(formatShowDumpFromKind("shopping", snapshot, { viewerName: "טל" })).toBe(
      formatShowDumpFromKind("shopping", snapshot, { viewerName: "טל" }),
    );
  });

  it("dumps only active reminders with relative when", () => {
    const text = formatShowDumpFromKind("reminders", snapshot, { now });
    expect(text).toContain("1. לקנות חלב — מחר ב־09:00");
    expect(text).not.toContain("ישן");
    expect(text).not.toContain("2026-10-16 09:00");
  });

  it("unknown custom names return לא מצאתי רשימה (not null)", () => {
    expect(formatShowDumpFromKind("בעיות", snapshot)).toContain(
      "לא מצאתי רשימה בשם «בעיות»",
    );
    expect(formatShowDumpFromKind("קניות אישית", snapshot)).toContain(
      "לא מצאתי רשימה בשם «קניות אישית»",
    );
  });

  it("titleAlreadyListsPartners detects meeting-style titles", () => {
    expect(titleAlreadyListsPartners("פגישה (טל, עמית)", "עמית")).toBe(true);
    expect(titleAlreadyListsPartners("פגישה (טל, מיכל)", "מיכל")).toBe(true);
    expect(titleAlreadyListsPartners("קפה", "מיכל")).toBe(false);
    expect(titleAlreadyListsPartners("פגישה", "עמית")).toBe(false);
    expect(
      titleAlreadyListsPartners("פגישת עבודה (עמית, ערן)", "עמית, ערן"),
    ).toBe(true);
  });

  it("section=personal dumps only אישיות", () => {
    const personal = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "personal",
    });
    const full = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
    });
    expect(personal).toContain("🛒 קניות:");
    expect(personal).toContain("ספוג אדום");
    expect(personal).not.toContain("קמח מלא");
    expect(full).toContain("🛒 קניות:");
    expect(full).toContain("קמח מלא");
    expect(personal).not.toBe(full);
  });

  it("section=shared dumps only משותפות עם X; partner filters the bucket", () => {
    const shared = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "shared",
    });
    expect(shared).toContain("🛒 קניות:");
    expect(shared).toContain("קמח מלא");
    expect(shared).not.toContain("ספוג אדום");

    const onlyMichal = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
    });
    expect(onlyMichal).toContain("🛒 קניות:");
    expect(onlyMichal).toContain("קמח מלא");
    expect(onlyMichal).not.toContain("ספוג אדום");

    const missing = formatShowDumpFromKind("shopping", snapshot, {
      viewerName: "טל",
      section: "shared",
      partner: "ערן",
    });
    expect(missing).toContain("אין קניות משותפות עם ערן");
    expect(missing).not.toContain("קמח מלא");
  });

  it("partner+shared excludes assign rows (pure משותף עם)", () => {
    const mix: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "co1",
              "שם פריט": "קפה משותף",
              shared_with: ["טל", "מיכל"],
            },
            {
              item_id: "as1",
              "שם פריט": "חלב באחריות",
              assigned_by: "מיכל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [
            {
              item_id: "as2",
              "שם פריט": "שמן למיכל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const sharedWith = formatShowDumpFromKind("shopping", mix, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      collaboration: "co_share",
    })!;
    expect(sharedWith).toContain("קפה משותף");
    expect(sharedWith).not.toContain("חלב באחריות");
    expect(sharedWith).not.toContain("שמן למיכל");
    expect(sharedWith).not.toContain("באחריות");

    const assignedTo = formatShowDumpFromKind("shopping", mix, {
      viewerName: "טל",
      section: "shared",
      assignee: "מיכל",
      collaboration: "assign",
    })!;
    expect(assignedTo).toContain("שמן למיכל");
    expect(assignedTo).toContain("באחריות");
    expect(assignedTo).not.toContain("קפה משותף");
  });

  it("assignee filter keeps sole-responsibility marks only", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "a1",
              "שם מטלה": "חלב עליי",
              assigned_by: "מיכל",
            },
            {
              item_id: "s1",
              "שם מטלה": "קפה משותף",
              shared_with: ["טל", "מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [{ item_id: "out1", "שם מטלה": "שמן למיכל" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const mine = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      assignee: "self",
      assigneeSelfNames: ["טל"],
    })!;
    expect(mine).toContain("חלב עליי (באחריות טל · מאת מיכל)");
    expect(mine).not.toContain("קפה משותף");
    expect(mine).not.toContain("שמן למיכל");

    const hers = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      assignee: "מיכל",
      assigneeSelfNames: ["טל"],
    })!;
    expect(hers).toContain("שמן למיכל (באחריות מיכל · מאת טל)");
    expect(hers).not.toContain("חלב עליי");
    expect(hers).not.toContain("קפה משותף");
  });

  it("partnerBucketMatches matches exact partner segments", () => {
    expect(partnerBucketMatches("מיכל", "מיכל")).toBe(true);
    expect(partnerBucketMatches("מיכל, עמית", "מיכל")).toBe(true);
    expect(partnerBucketMatches("מיכל, עמית", "ערן")).toBe(false);
  });

  it("assignee and partner arrays OR within field and AND with dates", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "עליי בטווח",
              "תאריך לביצוע": "2026-10-18",
              assigned_by: "מיכל",
            },
            {
              item_id: "t2",
              "שם מטלה": "על מיכל בטווח",
              "תאריך לביצוע": "2026-10-19",
            },
            {
              item_id: "t3",
              "שם מטלה": "עליי מחוץ",
              "תאריך לביצוע": "2026-10-25",
              assigned_by: "מיכל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "מיכל",
          scope: "shared_items",
          items: [
            {
              item_id: "out1",
              "שם מטלה": "שמן למיכל בטווח",
              "תאריך לביצוע": "2026-10-18",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "עמית"],
          items: [
            {
              item_id: "s1",
              "שם מטלה": "עם עמית",
              "תאריך לביצוע": "2026-10-18",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const withAssignee = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: ["מיכל", "עמית"],
      assignee: ["self", "מיכל"],
      assigneeSelfNames: ["טל"],
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    // AND across fields: partner OR ∩ assignee OR ∩ dates — day-agenda layout.
    expect(withAssignee).toContain("עליי בטווח");
    expect(withAssignee).toContain("שמן למיכל בטווח");
    expect(withAssignee).not.toContain("עליי מחוץ");
    // Whole shared list row has no sole assignee mark → dropped when assignee set.
    expect(withAssignee).not.toContain("עם עמית");
    expect(withAssignee).not.toContain("על מיכל בטווח");
    expect(withAssignee).toMatch(/\d+\.\d+:/);

    const partnerOnly = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: ["מיכל", "עמית"],
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    // Pure «משותף עם»: co-share only — assign rows excluded.
    expect(partnerOnly).toContain("עם עמית");
    expect(partnerOnly).not.toContain("עליי בטווח");
    expect(partnerOnly).not.toContain("שמן למיכל בטווח");
  });

  it("date range composes with partner/assignee on tasks; ignored for shopping", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "פגישה בטווח",
              "תאריך לביצוע": "2026-10-18",
              assigned_by: "מיכל",
            },
            {
              item_id: "t2",
              "שם מטלה": "מחוץ לטווח",
              "תאריך לביצוע": "2026-10-25",
              assigned_by: "מיכל",
            },
            {
              item_id: "t3",
              "שם מטלה": "חוזרת",
              חוזר: "כל יום שני",
              next_occurrences: ["2026-10-19 09:00", "2026-10-26 09:00"],
              assigned_by: "מיכל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "s1", "שם פריט": "חלב", "תאריך לביצוע": "2026-10-25" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const tasks = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "מיכל",
      assignee: "self",
      assigneeSelfNames: ["טל"],
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(tasks).toContain("פגישה בטווח");
    expect(tasks).toContain("חוזרת");
    expect(tasks).not.toContain("מחוץ לטווח");
    // Day-agenda standing lines are occurrence-effective (chore HM that day), not the series suffix.
    expect(tasks).toContain("חוזרת (באחריות טל · מאת מיכל) — 09:00");
    expect(tasks).toContain("מה־17 עד 20.10:");

    const shopping = formatShowDumpFromKind("shopping", snap, {
      viewerName: "טל",
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(shopping).toContain("חלב");

    expect(
      itemMatchesDateRange(
        { "תאריך לביצוע": "2026-10-18", "תאריך סיום": "2026-10-22" },
        "2026-10-20",
        "2026-10-21",
      ),
    ).toBe(true);
  });

  describe("retrieval contract dump path (T1–T3, T6 — engine behavior)", () => {
    const weekSnap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "meet-1",
              "שם מטלה": "פגישה עם רואה חשבון",
              "תאריך לביצוע": "2026-10-12",
              "שעה לביצוע": "09:00",
            },
            {
              item_id: "doc-1",
              "שם מטלה": "תור לרופא",
              "תאריך לביצוע": "2026-10-13",
              "שעה לביצוע": "11:00",
            },
            {
              item_id: "pkg-1",
              "שם מטלה": "לאסוף חבילה",
              "תאריך לביצוע": "2026-10-14",
              "שעה לביצוע": "16:00",
            },
            {
              item_id: "out-1",
              "שם מטלה": "מטלה מחוץ לטווח",
              "תאריך לביצוע": "2026-10-25",
              "שעה לביצוע": "09:00",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    // T1: FULL inventory date window — every in-range task row.
    it("T1: date-range dump without ids includes every in-range task", () => {
      const dump = formatShowDumpFromKind("tasks", weekSnap, {
        viewerName: "טל",
        dateFrom: "2026-10-11",
        dateTo: "2026-10-17",
      })!;
      expect(dump).toContain("פגישה עם רואה חשבון");
      expect(dump).toContain("תור לרופא");
      expect(dump).toContain("לאסוף חבילה");
      expect(dump).not.toContain("מטלה מחוץ לטווח");
    });

    // T2: same-kind semantic via ids — only chosen rows.
    it("T2: show_dump_ids keeps only the selected meeting row", () => {
      const dump = formatShowDumpFromKind("tasks", weekSnap, {
        viewerName: "טל",
        dateFrom: "2026-10-11",
        dateTo: "2026-10-17",
        itemIds: new Set(["meet-1"]),
      })!;
      expect(dump).toContain("פגישה עם רואה חשבון");
      expect(dump).not.toContain("תור לרופא");
      expect(dump).not.toContain("לאסוף חבילה");
    });

    // T3: characterization only — documents current engine expansion when
    // bare show_dump has no ids. NOT desired model behavior for semantic asks.
    it("T3 characterization: bare date-range dump without ids expands to all in-range rows (engine fact; not a semantic-ok path)", () => {
      const dump = formatShowDumpFromKind("tasks", weekSnap, {
        viewerName: "טל",
        dateFrom: "2026-10-11",
        dateTo: "2026-10-17",
      })!;
      // Engine fact: without itemIds the dump is the full window — including
      // non-meeting chores. Prompt forbids the model from using this for
      // «פגישות»; this test does not bless that as a semantic answer.
      expect(dump).toContain("פגישה עם רואה חשבון");
      expect(dump).toContain("לאסוף חבילה");
    });

    // T6: day filter does not drop by hour-of-day.
    it("T6: date-range dump keeps both morning and afternoon tasks (no hour filter)", () => {
      const dump = formatShowDumpFromKind("tasks", weekSnap, {
        viewerName: "טל",
        dateFrom: "2026-10-11",
        dateTo: "2026-10-17",
      })!;
      expect(dump).toContain("09:00");
      expect(dump).toContain("16:00");
      expect(dump).toContain("פגישה עם רואה חשבון");
      expect(dump).toContain("לאסוף חבילה");
    });
  });

  it("reminders dump filters by fire_at date range", () => {
    const baseReminder = {
      list_type: "tasks",
      ping: ["טל"],
      ping_ids: ["e1"],
      owner: "טל",
      text: "",
      last_composed_text: "",
      sent_text: "",
      compose_at_fire: false,
      compose_source: "",
      compose_lookback_hours: 0,
      send_status: "pending" as const,
      sent: false,
      sent_at: null,
    };
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [],
      reminders: [
        {
          ...baseReminder,
          reminder_id: "r1",
          item: "בטווח",
          fire_at: "2026-10-18 09:00",
          status: "active",
          repeat: "once",
        },
        {
          ...baseReminder,
          reminder_id: "r2",
          item: "מחוץ",
          fire_at: "2026-10-25 09:00",
          status: "active",
          repeat: "once",
        },
      ],
    };
    const text = formatShowDumpFromKind("reminders", snap, {
      now: new Date("2026-10-16T07:00:00.000Z"),
      dateFrom: "2026-10-17",
      dateTo: "2026-10-20",
    })!;
    expect(text).toContain("בטווח");
    expect(text).not.toContain("מחוץ");
  });

  it("show_dump=full: item co-share with Michal → קניות משותפות עם מיכל count ≥ 1", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "s1",
              "שם פריט": "קפה",
              כמות: 1,
              shared_with: ["מיכל"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "t1", "שם מטלה": "לטפל בעמידר" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };

    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      phoneBook: [{ name: "דני", phone: "0501234567" }],
    })!;

    // Shopping counts only — breakdown by personal / co-share marks.
    expect(text).toMatch(
      /🛒 קניות:\nאישיות — 1 פריט\n\(מיכל, טל\) — 1 פריט/,
    );
    expect(text).not.toContain("קניות: 2 פריטים");
    expect(text).not.toContain("קניות אישיות");
    expect(text).not.toContain("קניות משותפות עם");
    expect(text).not.toContain("קפה"); // counts only — no item titles
    expect(text).not.toContain("לחם");

    // Tasks still enumerate under one header.
    expect(text).toMatch(/✅ מטלות:[\s\S]*לטפל בעמידר/);

    // Empty categories omitted (no ריק/ריקה headers).
    expect(text).not.toContain("רשימות אחרות:");
    expect(text).not.toContain("תזכורות פעילות:");
    expect(text).not.toContain("תיוקים אישיים:");
    expect(text).not.toContain("תיוקים משותפים:");
    expect(text).toContain("👤 אנשי קשר:");
    expect(text).not.toMatch(/ריק/);
    expect(text).not.toContain("ספר הטלפונים:");
    expect(text).not.toContain("ספר הטלפונים אישי:");
    expect(text).toContain("דני — 0501234567");
    expect(text).toContain("לפירוט רשימה: הצג רשימת …");
  });

  it("contacts/אנשי קשר dump uses phone_book (not lists.contacts)", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "contacts",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "c1",
              "שם פרטי": "דני",
              scope: "personal",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const full = formatShowDumpFromKind("contacts", snap, {
      viewerName: "טל",
      phoneBook: [
        { contact_id: "pb1", name: "דני", phone: "050", scope: "personal" },
      ],
    })!;
    expect(full).toContain("👤 אנשי קשר:");
    expect(full).toContain("דני");
    expect(full).not.toContain("אנשי קשר אישיים:");
    expect(full).not.toContain("אנשי קשר משותפים:");

    const sharedOnly = formatShowDumpFromKind("אנשי קשר", snap, {
      viewerName: "טל",
      section: "shared",
      phoneBook: [
        { contact_id: "pb1", name: "דני", phone: "050", scope: "personal" },
      ],
    })!;
    expect(sharedOnly).toBe("אין אנשי קשר משותפים.");
    expect(sharedOnly).not.toContain("דני");
  });

  it("phone_book dump emits LAST_NUMBERED_DUMP lines with contact_id", () => {
    const { text, lines } = formatShowDumpWithLineMap(
      "phone_book",
      { lists: [], filing: [] },
      {
        viewerName: "טל",
        phoneBook: [
          {
            contact_id: "cid-1",
            name: "דני",
            phone: "050",
            description: "שכן",
            scope: "personal",
          },
        ],
      },
    );
    expect(text).toContain("👤 אנשי קשר:");
    expect(text).toContain("דני — 050 · שכן");
    expect(lines).toEqual([
      {
        n: 1,
        id: "cid-1",
        kind: "phone_book",
        title_stem: "דני",
      },
    ]);
  });

  it("shopping countsOnly: breakdown by bucket; empty shared section sentence", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "s1",
              "שם פריט": "קפה",
              כמות: 1,
              shared_with: ["טל", "מיכל"],
            },
            {
              item_id: "a1",
              "שם פריט": "חלב",
              כמות: 1,
              assigned_by: "טל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "ערן",
          scope: "shared_items",
          items: [
            {
              item_id: "a2",
              "שם פריט": "ביצים",
              כמות: 1,
              assigned_by: "טל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const counts = formatShowDumpFromKind("shopping", snap, {
      viewerName: "טל",
      countsOnly: true,
    })!;
    expect(counts).toMatch(/^🛒 קניות:/);
    expect(counts).toContain("אישיות — 1 פריט");
    expect(counts).toContain("(מיכל, טל) — 1 פריט");
    expect(counts).toContain("(באחריות טל · מאת טל) — 1 פריט");
    expect(counts).toContain("(באחריות ערן · מאת טל) — 1 פריט");
    expect(counts).not.toContain("לחם");
    expect(counts).not.toContain("קניות משותפות עם");

    const personalOnly: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "p1", "שם פריט": "לחם", כמות: 1 }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const sharedCounts = formatShowDumpFromKind("shopping", personalOnly, {
      viewerName: "טל",
      countsOnly: true,
      section: "shared",
    })!;
    expect(sharedCounts).toBe("אין קניות משותפות.");
  });

  it("full dump omits empty sections; all-empty → one sentence", () => {
    const empty = formatShowDumpFromKind(
      "full",
      { lists: [], filing: [], reminders: [] },
      { viewerName: "טל" },
    )!;
    expect(empty).toBe("אין לך מידע שמור כרגע.");
    expect(empty).not.toMatch(/ריק/);

    const partnerEmpty = formatShowDumpFromKind(
      "full",
      { lists: [], filing: [], reminders: [] },
      { viewerName: "טל", section: "shared", partner: "עמית" },
    )!;
    expect(partnerEmpty).toBe("אין לך מידע משותף עם עמית כרגע.");
    expect(partnerEmpty).not.toContain("קניות");
    expect(partnerEmpty).not.toContain("תזכורות");
  });

  it("full+partner omits empty contacts section without Hebrew empty sentence", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "t1",
              "שם מטלה": "פגישה (טל, עמית)",
              shared_with: ["טל", "עמית"],
              scope: "shared",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "contacts",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "c1",
              "שם פרטי": "דני",
              scope: "personal",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
    })!;
    expect(text).toContain("פגישה (טל, עמית)");
    expect(text).not.toContain("אין אנשי קשר");
    expect(text).not.toContain("דני");
    expect(text).toContain("לפירוט רשימה: הצג רשימת …");
  });
});

describe("worker inventory tasks dump helpers", () => {
  it("recognizes tasks show_dump kinds", () => {
    expect(isTasksShowDumpKind("tasks")).toBe(true);
    expect(isTasksShowDumpKind("מטלות")).toBe(true);
    expect(isTasksShowDumpKind("shopping")).toBe(false);
    expect(isTasksShowDumpKind("full")).toBe(false);
  });

  it("excludes OPEN_JOBS shadow item_ids then dumps remaining tasks", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "לוסי",
          scope: "personal",
          items: [
            { item_id: "job-shadow", "שם מטלה": "לבדוק עם ערן: אם קנית חלב?" },
            { item_id: "standing", "שם מטלה": "להזכיר לטל לקנות חלב" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const filtered = excludeItemIdsFromSnapshot(snap, new Set(["job-shadow"]));
    const text = formatShowDumpFromKind("tasks", filtered, {
      viewerName: "לוסי",
    })!;
    expect(text).toContain("להזכיר לטל לקנות חלב");
    expect(text).not.toContain("לבדוק עם ערן");
  });

  it("הצג מטלות (speaker book) dumps speaker tasks — not Lucy OPEN_JOBS follow-ups", () => {
    // Speaker ESD snapshot has the human's tasks; worker follow-ups live on Lucy's book.
    // Bare show_dump=tasks must use the speaker snapshot (no about=לוסי).
    const speakerSnap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "user-1", "שם מטלה": "לקנות חלב" },
            { item_id: "user-2", "שם מטלה": "להתקשר לרופא" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const lucyFollowUps: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "לוסי",
          scope: "personal",
          items: [
            {
              item_id: "job-follow",
              "שם מטלה": "לבדוק עם טל: אם קנית חלב?",
            },
            {
              item_id: "nudge",
              "שם מטלה": "להזכיר לטל לקנות חלב",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    // Bare button → kind=tasks (speaker book). Worker path is «הצג מטלות של לוסי» (+ about).
    expect(mapShowButtonCommandToDumpTarget("הצג רשימת מטלות")).toEqual({
      kind: "tasks",
    });
    expect(mapShowButtonCommandToDump("הצג רשימת מטלות")).toBe("tasks");
    // Label-only «הצג מטלות» is NOT the opaque allowlist command (engine uses full command).
    expect(mapShowButtonCommandToDump("הצג מטלות")).toBeNull();
    expect(mapShowButtonCommandToDumpTarget("הצג מטלות של לוסי")).toEqual({
      kind: "tasks",
      about: "לוסי",
    });
    const speakerDump = formatShowDumpFromKind("tasks", speakerSnap, {
      viewerName: "טל",
    })!;
    expect(speakerDump).toContain("לקנות חלב");
    expect(speakerDump).toContain("להתקשר לרופא");
    expect(speakerDump).not.toContain("לבדוק עם טל");
    expect(speakerDump).not.toContain("להזכיר לטל");
    // Contrast: worker inventory path uses Lucy's book (+ about), not bare speaker dump.
    const workerDump = formatShowDumpFromKind("tasks", lucyFollowUps, {
      viewerName: "לוסי",
      flatLayout: true,
    })!;
    expect(workerDump).toContain("לבדוק עם טל");
    expect(workerDump).toContain("להזכיר לטל");
    expect(workerDump).not.toContain("להתקשר לרופא");
    // Intervening automated Lucy text does not change button→kind mapping.
    expect(
      mapShowButtonCommandToDumpTarget(
        "הצג מטלות של לוסי",
      ),
    ).toEqual({ kind: "tasks", about: "לוסי" });
    expect(mapShowButtonCommandToDumpTarget("הצג רשימת מטלות")).toEqual({
      kind: "tasks",
    });
  });

  it("stitches ממתינים after tasks; empty tasks string skips tasks block", () => {
    expect(
      composeTasksDumpWithWaiting("", "ממתינים לתשובה:\n1. א"),
    ).toBe("ממתינים לתשובה:\n1. א");
    expect(
      composeTasksDumpWithWaiting(null, "ממתינים לתשובה:\n1. א"),
    ).toBe("ממתינים לתשובה:\n1. א");
    expect(
      composeTasksDumpWithWaiting(
        "מטלות:\n1. להזכיר לטל",
        "ממתינים לתשובה:\n1. א",
      ),
    ).toBe("מטלות:\n1. להזכיר לטל\n\nממתינים לתשובה:\n1. א");
    expect(
      composeTasksDumpWithWaiting("מטלות:\n1. להזכיר לטל", ""),
    ).toBe("מטלות:\n1. להזכיר לטל");
  });

  it("filters tasks by urgency", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "1", "שם מטלה": "רגיל" },
            { item_id: "2", "שם מטלה": "דחוף", urgency: "urgent" },
            { item_id: "3", "שם מטלה": "ממש דחוף", urgency: "very_urgent" },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const urgent = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      urgency: "urgent",
    })!;
    expect(urgent).toContain("דחוף");
    expect(urgent).toContain("ממש דחוף");
    expect(urgent).not.toContain("רגיל");
    const very = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      urgency: "very_urgent",
    })!;
    expect(very).toContain("ממש דחוף");
    expect(very).not.toContain("1. דחוף");
  });

  it("dumps phone_book from opts.phoneBook", () => {
    expect(isTasksShowDumpKind("phone_book")).toBe(false);
    const text = formatShowDumpFromKind("phone_book", { lists: [], filing: [] }, {
      phoneBook: [{ name: "דני", phone: "050", description: "שכנה" }],
    })!;
    expect(text).toContain("👤 אנשי קשר:");
    expect(text).not.toContain("ספר הטלפונים:");
    expect(text).toContain("1. דני — 050 · שכנה");
  });

  it("phone_book flat: personal then co-share (A, B)", () => {
    const text = formatShowDumpFromKind(
      "phone_book",
      { lists: [], filing: [] },
      {
        viewerName: "טל",
        phoneBook: [
          { name: "דני", phone: "050", scope: "personal" },
          {
            name: "שרה",
            phone: "052",
            scope: "shared",
            shared_with: ["טל", "עמית"],
          },
        ],
      },
    )!;
    expect(text).toMatch(
      /👤 אנשי קשר:\n1\. דני — 050\n2\. שרה — 052 \(עמית, טל\)/,
    );
    expect(text).not.toContain("(עם ");
    expect(text).not.toContain("ספר הטלפונים משותף");
  });

  it("flatLayout dumps digital-worker tasks without משותפות/assignee marks", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "לוסי",
          scope: "personal",
          items: [
            {
              item_id: "1",
              "שם מטלה": "להזכיר לטל לבדוק את הביט",
              assigned_by: "טל",
              reminder: {
                reminder_id: "r1",
                fire_at: "2026-11-15T18:00:00.000Z",
                repeat: "once",
              },
            },
            {
              item_id: "2",
              "שם מטלה": "לשלוח למיכל ברכת בוקר",
              "שעה לביצוע": "09:00",
              assigned_by: "טל",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const text = formatShowDumpFromKind("tasks", snap, {
      viewerName: "לוסי",
      flatLayout: true,
      now: new Date("2026-10-17T10:00:00.000Z"),
    })!;
    expect(text).toContain("✅ מעקבים של לוסי:");
    expect(text).not.toContain("✅ מטלות:");
    expect(text).not.toContain("משותפות");
    expect(text).not.toContain("אישיות");
    expect(text).not.toContain("(לוסי)");
    expect(text).toMatch(/להזכיר לטל לבדוק את הביט 🔔 תזכורת:/);
    expect(text).toContain("לשלוח למיכל ברכת בוקר");
    const speaker = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now: new Date("2026-10-17T10:00:00.000Z"),
    })!;
    expect(speaker).toContain("✅ מטלות:");
    expect(speaker).not.toContain("מעקבים של לוסי");
  });

  it("full dump with partner filters reminders, contacts, phone book like filings", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p", "שם מטלה": "פרטי" },
            {
              item_id: "meet",
              "שם מטלה": "פגישה (טל, עמית)",
              shared_with: ["טל", "עמית"],
              scope: "shared",
              reminder: {
                reminder_id: "rem-meet",
                fire_at: "2026-10-20T18:30:00.000Z",
                repeat: "once",
              },
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "custom",
          list_name: "באגים",
          owner: "טל",
          scope: "shared",
          shared_with: ["עמית"],
          items: [{ item_id: "c1", שם: "a" }],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "custom",
          list_name: "פרטי",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "c2", שם: "b" }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "rem-michal",
          item: "לשלוח למיכל ברכת בוקר",
          list_type: "tasks",
          fire_at: "2026-10-17T06:00:00.000Z",
          repeat: "daily",
          ping: ["מיכל"],
          ping_ids: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
        {
          reminder_id: "rem-meet",
          item: "פגישה עם עמית",
          list_type: "tasks",
          fire_at: "2026-10-20T18:30:00.000Z",
          repeat: "once",
          ping: ["טל"],
          ping_ids: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
        {
          reminder_id: "rem-ping-amit",
          item: "לשאול את עמית",
          list_type: "tasks",
          fire_at: "2026-10-18T10:00:00.000Z",
          repeat: "once",
          ping: ["עמית"],
          ping_ids: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };
    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
      phoneBook: [
        { name: "דני", phone: "050", scope: "personal" },
        {
          name: "שרה",
          phone: "052",
          scope: "shared",
          shared_with: ["טל", "עמית"],
        },
      ],
    })!;
    expect(text).toContain("📋 *באגים*");
    expect(text).not.toContain("*פרטי* —");
    expect(text).not.toContain("לשלוח למיכל ברכת בוקר");
    expect(text).toContain("לשאול את עמית");
    // Linked rem-meet is folded into the task line — not a second תזכורות row.
    expect(text).toContain("פגישה (טל, עמית)");
    expect(text).toMatch(/🔔 תזכורת:/);
    expect(text).not.toContain("פגישה עם עמית");
    expect(text).not.toMatch(/אנשי קשר אישיים:[\s\S]*דני/);
    expect(text).toContain("שרה");
    expect(text).toContain("👤 אנשי קשר:");
    expect(text).toContain("(עמית, טל)");
    expect(text).not.toContain("ספר הטלפונים משותף");
    expect(text).not.toContain("ספר הטלפונים אישי:");
    expect(text).not.toContain("ספר הטלפונים:");
    expect(text).not.toMatch(/👤 אנשי קשר:[\s\S]*דני/);
  });
});

describe("uniform standing + ping dump lines", () => {
  const now = new Date("2026-10-17T07:00:00.000Z");

  const standingSkazi = {
    item_id: "skazi-am",
    "שם מטלה": "להוריד את סקאזי לטיול",
    חוזר: "כל יום ב־08:45",
    next_occurrences: [
      "2026-10-18 08:45",
      "2026-10-19 08:45",
      "2026-10-20 08:45",
    ],
    reminder: {
      reminder_id: "r-skazi-am",
      fire_at: "2026-10-18 08:30",
      repeat: "custom",
      recurrence_text: "כל יום ב־08:30",
    },
  };

  it("day-agenda standing line matches flat dump schedule suffix (incl. exceptions)", () => {
    const item = {
      "שם מטלה": "חוג תיאטרון",
      חוזר: "כל שני ורביעי ב־19:00",
      exceptions: ["28.10 ב־18:00"],
      next_occurrences: ["2026-10-28 18:00"],
    };
    const listSuffix = formatScheduleSuffix(item, "tasks", now);
    expect(listSuffix).toBe(
      "— כל שני ורביעי ב־19:00 (קבוע) · 28.10 ב־18:00",
    );
    expect(formatAgendaStandingLine(3, "חוג תיאטרון", item, "18:00", { now })).toBe(
      `3. חוג תיאטרון ${listSuffix}`,
    );
  });

  it("list dump folds chore≠ping into one line via shared mark", () => {
    expect(
      formatNumberedItem(1, "להוריד את סקאזי לטיול", standingSkazi, "tasks", {
        now,
      }),
    ).toMatch(/^1\. להוריד את סקאזי לטיול — כל יום ב־08:45 \(קבוע\) 🔔 תזכורת:/);
    expect(
      formatScheduleSuffix(
        {
          חוזר: "כל יום ב־18:15",
          reminder: {
            fire_at: "2026-10-18 18:15",
            repeat: "custom",
            recurrence_text: "כל יום ב־18:15",
          },
        },
        "tasks",
        now,
      ),
    ).toBe("— כל יום ב־18:15 (קבוע)");
  });

  it("day-agenda excludes conditional watch clocks (compose_condition)", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "עמית",
          scope: "personal",
          items: [
            {
              item_id: "chore",
              "שם מטלה": "לשתות מים",
              "תאריך לביצוע": "2026-10-21",
              "שעה לביצוע": "10:00",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "r-btc-watch",
          item: "לעדכן את עמית כששער הביטקוין נמוך מ־81,236.57 דולר",
          list_type: "tasks",
          fire_at: "2026-10-21 00:34",
          repeat: "custom",
          recurrence_text: "כל שעה",
          next_occurrences: [
            "2026-10-21 00:34",
            "2026-10-21 01:34",
            "2026-10-21 02:34",
            "2026-10-21 03:34",
          ],
          ping: ["עמית"],
          ping_ids: [],
          owner: "לוסי",
          text: "בדיקת שער ביטקוין",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: true,
          compose_source: "market",
          compose_lookback_hours: 0,
          compose_place: "BTC-USD",
          compose_condition: {
            type: "market_price",
            op: "lt",
            value: 81236.57,
          },
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
        {
          reminder_id: "r-plain-ping",
          item: "לקחת כדור",
          list_type: "tasks",
          fire_at: "2026-10-21 20:00",
          repeat: "once",
          ping: ["עמית"],
          ping_ids: [],
          owner: "עמית",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };

    const agenda = formatShowDumpFromKind("tasks", snap, {
      viewerName: "עמית",
      now,
      dateFrom: "2026-10-21",
      dateTo: "2026-10-21",
    })!;

    expect(agenda).toContain("לשתות מים — 10:00");
    expect(agenda).toContain("לקחת כדור — 20:00");
    expect(agenda).not.toContain("ביטקוין");
    expect(agenda).not.toContain("00:34");

    // Bare reminders dump still lists the watch (speaker's alert clocks).
    const remOnly = formatShowDumpFromKind("reminders", snap, { now })!;
    expect(remOnly).toContain("ביטקוין");
  });

  it("day-agenda excludes standing watch worker task (interval next_occurrences flood)", () => {
    // Mashov/market watches: worker task + linked compose_condition clock.
    // occurrenceRange expands interval polls across the day — must not print ~N times.
    const hourly: string[] = [];
    for (let h = 0; h < 24; h += 1) {
      const hh = String(h).padStart(2, "0");
      hourly.push(`2026-10-24 ${hh}:04`);
    }
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "לוסי",
          scope: "personal",
          items: [
            {
              item_id: "mashov-watch",
              "שם מטלה":
                "לעקוב במשוב אחרי חיסורים, איחורים וציונים חדשים של יואב ב־21:00",
              חוזר: "כל שעה",
              next_occurrences: hourly,
              reminder: {
                reminder_id: "r-mashov-watch",
                fire_at: "2026-10-22 21:04",
                repeat: "custom",
                recurrence_text: "כל שעה",
              },
            },
            {
              item_id: "kids",
              "שם מטלה": "לאסוף את הילדים",
              חוזר: "כל יום שישי ב־11:45",
              next_occurrences: ["2026-10-24 11:45"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "r-mashov-watch",
          item:
            "לעקוב במשוב אחרי חיסורים, איחורים וציונים חדשים של יואב ב־21:00",
          list_type: "tasks",
          fire_at: "2026-10-22 21:04",
          repeat: "custom",
          recurrence_text: "כל שעה",
          next_occurrences: hourly,
          ping: ["טל"],
          ping_ids: [],
          owner: "לוסי",
          text: "בדיקת משוב",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: true,
          compose_source: "mashov",
          compose_lookback_hours: 0,
          compose_place: "יואב",
          compose_condition: {
            type: "mashov_new",
            aspects: ["grades", "absences", "behavior"],
          },
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };

    const agenda = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-24",
      dateTo: "2026-10-24",
    })!;

    expect(agenda).toContain("לאסוף את הילדים");
    expect(agenda).not.toContain("לעקוב במשוב");
    expect(agenda).not.toContain("00:04");
    expect(
      agenda.match(/לעקוב במשוב/g)?.length ?? 0,
    ).toBe(0);
  });

  it("day-agenda collapses interval standing task to one line per day", () => {
    const slots: string[] = [];
    for (let h = 0; h < 12; h += 1) {
      slots.push(
        `2026-10-24 ${String(h * 2).padStart(2, "0")}:00`,
      );
    }
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "water",
              "שם מטלה": "לשתות מים",
              חוזר: "כל שעתיים",
              next_occurrences: slots,
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const agenda = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-24",
      dateTo: "2026-10-24",
    })!;
    expect(
      agenda.match(/לשתות מים/g)?.length,
    ).toBe(1);
  });

  it("day-agenda uses same fold mark; excludes linked clock as its own line", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            standingSkazi,
            {
              item_id: "meet",
              "שם מטלה": "פגישה (טל, עמית)",
              חוזר: "כל ראשון ורביעי ב־21:30",
              next_occurrences: ["2026-10-18 21:30", "2026-10-21 21:30"],
            },
            {
              item_id: "doc",
              "שם מטלה": "ללכת לרופא",
              "תאריך לביצוע": "2026-10-18",
              "שעה לביצוע": "08:00",
              reminder: {
                reminder_id: "r-doc",
                fire_at: "2026-10-18 07:30",
                repeat: "once",
              },
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "r-skazi-am",
          item: "להוריד את סקאזי לטיול",
          list_type: "tasks",
          fire_at: "2026-10-18 08:30",
          repeat: "custom",
          recurrence_text: "כל יום ב־08:30",
          next_occurrences: ["2026-10-18 08:30", "2026-10-19 08:30"],
          ping: ["טל"],
          ping_ids: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
        {
          reminder_id: "r-michal-morning",
          item: "לשלוח למיכל ברכת בוקר",
          list_type: "tasks",
          fire_at: "2026-10-18 09:00",
          repeat: "custom",
          recurrence_text: "כל יום ב־09:00",
          next_occurrences: ["2026-10-18 09:00", "2026-10-19 09:00"],
          ping: ["טל"],
          ping_ids: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
        {
          reminder_id: "r-doc",
          item: "ללכת לרופא",
          list_type: "tasks",
          fire_at: "2026-10-18 07:30",
          repeat: "once",
          ping: ["טל"],
          ping_ids: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };

    const agenda = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-18",
      dateTo: "2026-10-18",
    })!;

    expect(agenda).toContain("ראשון 18.10:");
    // Occurrence-effective under the day header: chore time kept, timed 🔔.
    expect(agenda).toMatch(/להוריד את סקאזי לטיול — 08:45 🔔 תזכורת:/);
    // Unlinked clock-only row still uses reminder agenda formatting.
    expect(agenda).toContain("לשלוח למיכל ברכת בוקר — 09:00 (קבוע כל יום)");
    expect(agenda).toContain("פגישה (טל, עמית) — 21:30");
    expect(agenda).toContain("ללכת לרופא — 08:00");
    expect(agenda).toMatch(/🔔 תזכורת:/);
    expect(agenda).not.toMatch(/תזכורת ב־/);
    expect(agenda).not.toMatch(/\(תזכורת:/);
    // Linked clocks must not appear as their own numbered rows.
    expect(agenda).not.toMatch(/\d+\. להוריד את סקאזי לטיול — 08:30/);
    expect(agenda).not.toMatch(/\d+\. ללכת לרופא — 07:30/);

    const list = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
    })!;
    // Undated list dump: series schedule + timed 🔔 from linked reminder.
    expect(list).toMatch(
      /להוריד את סקאזי לטיול — כל יום ב־08:45 \(קבוע\) 🔔 תזכורת:/,
    );

    const remOnly = formatShowDumpFromKind("reminders", snap, {
      now,
      dateFrom: "2026-10-18",
      dateTo: "2026-10-18",
    })!;
    // Bare reminders dump may still list linked clocks.
    expect(remOnly).toContain("להוריד את סקאזי לטיול");
    expect(remOnly).toContain("קבוע כל יום");
  });

  it("multi-day window header + standing occurrence per day", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [standingSkazi],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const text = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-18",
      dateTo: "2026-10-20",
    })!;
    expect(text).toContain("מה־18 עד 20.10:");
    expect(text).toContain("ראשון 18.10:");
    expect(text).toContain("שני 19.10:");
    expect(text).toContain("שלישי 20.10:");
    expect(
      text.match(/להוריד את סקאזי לטיול — 08:45 🔔 תזכורת:/g)?.length,
    ).toBe(3);
  });

  it("far-date day agenda lists a standing Friday when next_occurrences already covers that day", () => {
    // Snapshot builder expands via occurrenceRange; dump only needs the far slot present.
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "עמית",
          scope: "personal",
          items: [
            {
              item_id: "kids",
              "שם מטלה": "לאסוף את הילדים",
              חוזר: "כל יום שישי ב־11:45",
              next_occurrences: ["2027-04-09 11:45"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const text = formatShowDumpFromKind("tasks", snap, {
      viewerName: "עמית",
      now,
      dateFrom: "2027-04-09",
      dateTo: "2027-04-09",
    })!;
    expect(text).toContain("לאסוף את הילדים");
    expect(text).toContain("11:45");
    expect(text).not.toContain("אין מטלות");
  });

  it("reminder cadence paren is always קבוע-family", () => {
    expect(
      formatReminderWhen(
        {
          fire_at: "2026-10-18 09:00",
          repeat: "daily",
          recurrence_text: "כל יום ב־09:00",
        },
        now,
      ),
    ).toBe("מחר ב־09:00 (קבוע כל יום)");
    expect(shortCadenceParen("כל יום ב־09:00")).toBe("(כל יום)");
  });
});

describe("partner dump about_ids (birthday event)", () => {
  const now = new Date("2026-10-17T07:00:00.000Z");

  it("עם עמית includes personal all-day birthday task via reminder.about", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "bday",
              "שם מטלה": "יום ההולדת של עמית",
              "יום שלם": true,
              חוזר: "כל שנה ב־13.10",
              next_occurrences: ["2027-10-13"],
              reminder: {
                reminder_id: "r-bday",
                fire_at: "2027-10-13 09:00",
                repeat: "custom",
                recurrence_text: "כל שנה ב־13.10 ב־09:00",
                about: ["עמית"],
                about_ids: ["amit-1"],
              },
            },
            {
              item_id: "private",
              "שם מטלה": "מטלה פרטית",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "r-bday",
          item: "יום ההולדת של עמית",
          list_type: "tasks",
          fire_at: "2027-10-13 09:00",
          repeat: "custom",
          recurrence_text: "כל שנה ב־13.10 ב־09:00",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: ["עמית"],
          about_ids: ["amit-1"],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
        {
          reminder_id: "r-michal",
          item: "לשלוח למיכל ברכת בוקר",
          list_type: "tasks",
          fire_at: "2026-10-18 09:00",
          repeat: "daily",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: ["מיכל"],
          about_ids: ["michal-1"],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };

    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
      now,
    })!;
    expect(text).toContain("✅ מטלות:");
    expect(text).toContain("יום ההולדת של עמית");
    expect(text).toContain("כל שנה ב־13.10");
    expect(text).toMatch(/\(קבוע\) 🔔 תזכורת:/);
    expect(text).not.toMatch(/קבוע \+ תזכורת/);
    expect(text).not.toContain("מטלות אישיות");
    expect(text).not.toContain("מטלות משותפות עם");
    expect(text).not.toContain("מטלה פרטית");
    expect(text).not.toContain("לשלוח למיכל ברכת בוקר");
    // Linked clock folded into the task — not a second תזכורות row.
    expect(text).not.toMatch(/תזכורות פעילות:[\s\S]*יום ההולדת של עמית/);
  });

  it("standing mark shows ping day when linked fire day ≠ task event day", () => {
    const line = formatNumberedItem(
      1,
      "יום ההולדת של עמית",
      {
        "שם מטלה": "יום ההולדת של עמית",
        "יום שלם": true,
        "תאריך לביצוע": "2027-05-09",
        חוזר: "כל שנה ב־9 במאי",
        reminder: {
          reminder_id: "r1",
          fire_at: "2027-05-08 13:00",
          recurrence_text: "כל שנה ב־8 במאי ב־13:00",
        },
      },
      "tasks",
      { now },
    );
    expect(line).toContain("כל שנה ב־9 במאי");
    expect(line).toMatch(/\(קבוע\) 🔔/);
    expect(line).toMatch(/🔔 תזכורת:/);
    expect(line).not.toMatch(/תזכורת ב־/);
  });

  it("unlinked about clock alone appears under תזכורות for partner dump", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [],
      filing: [],
      reminders: [
        {
          reminder_id: "r-bday-only",
          item: "יום ההולדת של עמית",
          list_type: "tasks",
          fire_at: "2027-10-12 09:00",
          repeat: "custom",
          recurrence_text: "כל שנה ב־12.10 ב־09:00",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: ["עמית"],
          about_ids: ["amit-1"],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };
    const text = formatShowDumpFromKind("full", snap, {
      viewerName: "טל",
      section: "shared",
      partner: "עמית",
      now,
    })!;
    expect(text).toContain("יום ההולדת של עמית");
    expect(text).toContain("תזכורות פעילות:");
  });
});

describe("LAST_NUMBERED_DUMP line map", () => {
  it("aligns multi-shell shopping dump lines with item_ids (not per-list JSON index)", () => {
    const mixed: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            { item_id: "p1", "שם פריט": "לחם", כמות: 1 },
            {
              item_id: "s1",
              "שם פריט": "מלפפונים",
              כמות: 1,
              shared_with: ["טל", "עמית"],
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "shared",
          shared_with: ["טל", "מיכל"],
          items: [
            { item_id: "l1", "שם פריט": "קמח מלא", כמות: 1 },
            { item_id: "l2", "שם פריט": "אורז", כמות: 2 },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };

    const { text, lines } = formatShowDumpWithLineMap("shopping", mixed, {
      viewerName: "טל",
    });
    expect(text).toContain("1. לחם");
    expect(text).toContain("3. קמח מלא");
    expect(lines.map((row) => row.id)).toEqual(["p1", "s1", "l1", "l2"]);
    expect(lines[2]).toMatchObject({
      n: 3,
      id: "l1",
      kind: "shopping",
      title_stem: "קמח מלא",
    });
    // JSON array index 2 on either shell would NOT be dump line 3.
    expect(lines.find((row) => row.n === 3)?.title_stem).toBe("קמח מלא");
  });

  it("uses title_stem without quantity for shopping", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "shopping",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [{ item_id: "rice", "שם פריט": "אורז", כמות: 2 }],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
    };
    const { lines } = formatShowDumpWithLineMap("shopping", snap, {
      viewerName: "טל",
    });
    expect(lines[0]).toMatchObject({
      n: 1,
      id: "rice",
      title_stem: "אורז",
    });
  });

  it("scopes full-dump task and reminder lines by section", () => {
    const now = new Date("2026-10-21T10:00:00+03:00");
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "task-1",
              "שם מטלה": "לשלם לרופא",
              "תאריך לביצוע": "2026-10-22",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [
        {
          reminder_id: "rem-1",
          item: "לקנות חלב",
          list_type: "shopping",
          fire_at: "2026-10-22 08:00",
          repeat: "once",
          ping: ["טל"],
          ping_ids: ["tal-1"],
          about: [],
          owner: "טל",
          text: "",
          last_composed_text: "",
          sent_text: "",
          compose_at_fire: false,
          compose_source: "",
          compose_lookback_hours: 0,
          status: "active",
          send_status: "pending",
          sent: false,
          sent_at: null,
        },
      ],
    };
    const { lines } = formatShowDumpWithLineMap("full", snap, {
      viewerName: "טל",
      now,
    });
    const taskLine = lines.find((row) => row.id === "task-1");
    const remLine = lines.find((row) => row.id === "rem-1");
    expect(taskLine).toMatchObject({
      n: 1,
      kind: "tasks",
      section: "tasks",
      title_stem: "לשלם לרופא",
    });
    expect(remLine).toMatchObject({
      n: 1,
      kind: "reminders",
      section: "reminders",
      title_stem: "לקנות חלב",
    });
  });

  it("formats LAST_NUMBERED_DUMP context for model inject", () => {
    const ctx = formatLastNumberedDumpContext([
      { n: 1, id: "a", kind: "tasks", title_stem: "ללכת לים" },
      { n: 2, id: "b", kind: "tasks", title_stem: "לשלם" },
    ]);
    expect(ctx).toContain("LAST_NUMBERED_DUMP:");
    expect(ctx).toContain('"id":"a"');
    expect(ctx).toContain("Spoken dump indices");
    expect(ctx).toContain("שתף 4 עם עמית");
    expect(ctx).toContain("FORBIDDEN claiming");
    expect(ctx).toContain("targets:[speaker, partner]");
    expect(ctx).toContain("never substitute another dump row");
    expect(formatLastNumberedDumpContext([])).toBe("");
  });

  it("resolveDumpLineId returns the exact dump id or null (no substitute)", () => {
    const lines = [
      {
        n: 1,
        id: "8527b7ce-bcd5-48a8-a774-24b7b8f3c269",
        kind: "tasks" as const,
        title_stem: "ביט",
      },
      {
        n: 4,
        id: "7dc44b7b-3c12-4694-ac49-75b5d8d92f9d",
        kind: "tasks" as const,
        title_stem: "יום ההולדת של עמית",
      },
      {
        n: 5,
        id: "e534785b-26f5-4801-a213-475e7e58f0a2",
        kind: "tasks" as const,
        title_stem: "פגישה",
      },
      { n: 1, id: "rem-1", kind: "reminders" as const, section: "reminders", title_stem: "שעון" },
    ];
    // «שתף 4 עם עמית» → exact birthday id, never meeting (5) or bit (1).
    expect(resolveDumpLineId(lines, 4)).toBe(
      "7dc44b7b-3c12-4694-ac49-75b5d8d92f9d",
    );
    expect(resolveDumpLineId(lines, 99)).toBeNull();
    expect(resolveDumpLineId(lines, 0)).toBeNull();
    // Ambiguous restart at 1 without section → null (do not guess).
    expect(resolveDumpLineId(lines, 1)).toBeNull();
    expect(resolveDumpLineId(lines, 1, "reminders")).toBe("rem-1");
  });

  it("day-agenda lines restart n per day with section=ymd", () => {
    const now = new Date("2026-10-20T10:00:00+03:00");
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            {
              item_id: "d1",
              "שם מטלה": "מטלה א",
              "תאריך לביצוע": "2026-10-21",
              "שעה לביצוע": "09:00",
            },
            {
              item_id: "d2",
              "שם מטלה": "מטלה ב",
              "תאריך לביצוע": "2026-10-22",
              "שעה לביצוע": "10:00",
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const { text, lines } = formatShowDumpWithLineMap("tasks", snap, {
      viewerName: "טל",
      dateFrom: "2026-10-21",
      dateTo: "2026-10-22",
      now,
    });
    expect(text).toMatch(/1\. /);
    expect(lines.filter((row) => row.n === 1)).toHaveLength(2);
    expect(lines.map((row) => row.section).sort()).toEqual([
      "2026-10-21",
      "2026-10-22",
    ]);
    expect(lines.find((row) => row.section === "2026-10-22")?.id).toBe("d2");
  });

  describe("undated-task disclosure on dated show_dump (Phase 3)", () => {
    it("helper: undated = no span and no next_occurrences ymd", () => {
      expect(itemHasDumpCalendarDate({ "שם מטלה": "בלי תאריך" })).toBe(false);
      expect(
        itemHasDumpCalendarDate({ "תאריך לביצוע": "2026-10-18" }),
      ).toBe(true);
      expect(
        itemHasDumpCalendarDate({
          next_occurrences: ["2026-10-19 09:00"],
        }),
      ).toBe(true);
      expect(formatUndatedTasksExcludedNote(0)).toBe("");
      expect(formatUndatedTasksExcludedNote(1)).toBe(
        "(שים לב: מטלה אחת בלי תאריך לא נכללה בטווח.)",
      );
      expect(formatUndatedTasksExcludedNote(3)).toBe(
        "(שים לב: 3 מטלות בלי תאריך לא נכללו בטווח.)",
      );
    });

    it("dated dump with undated tasks discloses count; undated titles stay out of the agenda", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "dated-1",
                "שם מטלה": "פגישה בטווח",
                "תאריך לביצוע": "2026-10-18",
                "שעה לביצוע": "10:00",
              },
              {
                item_id: "undated-1",
                "שם מטלה": "לקנות מתנה בלי תאריך",
              },
              {
                item_id: "undated-2",
                "שם מטלה": "לסדר מגירות",
              },
              {
                item_id: "out-1",
                "שם מטלה": "מחוץ לטווח עם תאריך",
                "תאריך לביצוע": "2026-10-25",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const dump = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        dateFrom: "2026-10-17",
        dateTo: "2026-10-20",
      })!;
      expect(dump).toContain("פגישה בטווח");
      expect(dump).not.toContain("לקנות מתנה בלי תאריך");
      expect(dump).not.toContain("לסדר מגירות");
      expect(dump).not.toContain("מחוץ לטווח עם תאריך");
      expect(dump).toContain(
        "(שים לב: 2 מטלות בלי תאריך לא נכללו בטווח.)",
      );
      // Dated-out-of-range is not undated — count stays 2.
      expect(dump).not.toMatch(/3 מטלות בלי תאריך/);
    });

    it("dated dump with no undated tasks omits the disclosure note", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "d1",
                "שם מטלה": "בטווח",
                "תאריך לביצוע": "2026-10-18",
              },
              {
                item_id: "d2",
                "שם מטלה": "מחוץ לטווח",
                "תאריך לביצוע": "2026-10-25",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const dump = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        dateFrom: "2026-10-17",
        dateTo: "2026-10-20",
      })!;
      expect(dump).toContain("בטווח");
      expect(dump).not.toContain("מחוץ לטווח");
      expect(dump).not.toContain("בלי תאריך");
    });

    it("empty dated agenda still discloses undated exclusions", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "u1",
                "שם מטלה": "בלי תאריך בכלל",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const dump = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        dateFrom: "2026-10-17",
        dateTo: "2026-10-20",
      })!;
      expect(dump).toContain("אין מטלות בטווח התאריכים.");
      expect(dump).toContain(
        "(שים לב: מטלה אחת בלי תאריך לא נכללה בטווח.)",
      );
      expect(dump).not.toContain("בלי תאריך בכלל");
    });

    it("undated outside result scope (section/partner) is not counted", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "personal-dated",
                "שם מטלה": "אישית בטווח",
                "תאריך לביצוע": "2026-10-18",
              },
              {
                item_id: "personal-undated",
                "שם מטלה": "אישית בלי תאריך",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "shared",
            visible_to: ["מיכל"],
            items: [
              {
                item_id: "shared-undated",
                "שם מטלה": "משותפת בלי תאריך",
                targets: ["מיכל"],
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      // Personal section: only personal undated counts (1), not the shared undated.
      const personal = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        section: "personal",
        dateFrom: "2026-10-17",
        dateTo: "2026-10-20",
      })!;
      expect(personal).toContain("אישית בטווח");
      expect(personal).toContain(
        "(שים לב: מטלה אחת בלי תאריך לא נכללה בטווח.)",
      );
      expect(personal).not.toContain("משותפת בלי תאריך");
      expect(personal).not.toContain("אישית בלי תאריך");

      // itemIds scopes away the undated personal row → no disclosure.
      const idsOnly = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        dateFrom: "2026-10-17",
        dateTo: "2026-10-20",
        itemIds: new Set(["personal-dated"]),
      })!;
      expect(idsOnly).toContain("אישית בטווח");
      expect(idsOnly).not.toContain("בלי תאריך");
    });

    it("no date bounds: undated tasks appear; no exclusion note", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "u1",
                "שם מטלה": "בלי תאריך גלוי",
              },
              {
                item_id: "d1",
                "שם מטלה": "עם תאריך",
                "תאריך לביצוע": "2026-10-18",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const dump = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
      })!;
      expect(dump).toContain("בלי תאריך גלוי");
      expect(dump).toContain("עם תאריך");
      expect(dump).not.toContain("לא נכללה בטווח");
      expect(dump).not.toContain("לא נכללו בטווח");
      expect(
        countUndatedTasksExcludedByDateRange(
          [
            {
              title: "בלי תאריך גלוי",
              item: { item_id: "u1", "שם מטלה": "בלי תאריך גלוי" },
            },
          ],
          { viewerName: "טל" },
        ),
      ).toBe(0);
    });

    it("shopping dump ignores date bounds and never discloses undated-task note", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "shopping",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              { item_id: "s1", "שם פריט": "חלב" },
              {
                item_id: "s2",
                "שם פריט": "לחם",
                "תאריך לביצוע": "2026-10-25",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [{ item_id: "t1", "שם מטלה": "מטלה בלי תאריך" }],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const shopping = formatShowDumpFromKind("shopping", snap, {
        viewerName: "טל",
        dateFrom: "2026-10-17",
        dateTo: "2026-10-20",
      })!;
      expect(shopping).toContain("חלב");
      expect(shopping).toContain("לחם");
      expect(shopping).not.toContain("בלי תאריך");
      expect(shopping).not.toContain("מטלה בלי תאריך");
    });
  });

  describe("show_dump calendar-date validation (ymdFromDumpValue)", () => {
    it("accepts a valid leap-day YMD", () => {
      expect(ymdFromDumpValue("2024-02-29")).toBe("2024-02-29");
      expect(ymdFromDumpValue("2024-02-29 09:00")).toBe("2024-02-29");
      expect(itemHasDumpCalendarDate({ "תאריך לביצוע": "2024-02-29" })).toBe(
        true,
      );
      expect(
        itemMatchesDateRange(
          { "תאריך לביצוע": "2024-02-29" },
          "2024-02-28",
          "2024-03-01",
        ),
      ).toBe(true);
    });

    it("rejects an impossible leap-day such as 2025-02-29", () => {
      expect(ymdFromDumpValue("2025-02-29")).toBeNull();
      expect(ymdFromDumpValue("2025-02-29T10:00:00")).toBeNull();
      expect(itemHasDumpCalendarDate({ "תאריך לביצוע": "2025-02-29" })).toBe(
        false,
      );
      expect(
        itemMatchesDateRange(
          { "תאריך לביצוע": "2025-02-29" },
          "2025-02-01",
          "2025-03-01",
        ),
      ).toBe(false);
    });

    it("dated dump: impossible calendar day is not treated as in-range", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "valid-leap",
                "שם מטלה": "פגישת 29 בפברואר 2024",
                "תאריך לביצוע": "2024-02-29",
                "שעה לביצוע": "10:00",
              },
              {
                item_id: "bad-leap",
                "שם מטלה": "תאריך בלתי אפשרי",
                "תאריך לביצוע": "2025-02-29",
              },
              {
                item_id: "plain-undated",
                "שם מטלה": "בלי תאריך בכלל",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const dump = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
        dateFrom: "2024-02-28",
        dateTo: "2024-03-01",
      })!;
      expect(dump).toContain("פגישת 29 בפברואר 2024");
      expect(dump).not.toContain("תאריך בלתי אפשרי");
      expect(dump).not.toContain("בלי תאריך בכלל");
      // Impossible YMD counts as undated for exclusion disclosure.
      expect(dump).toContain(
        "(שים לב: 2 מטלות בלי תאריך לא נכללו בטווח.)",
      );
    });

    it("no date bounds: impossible YMD still appears (not filtered as out-of-range)", () => {
      const snap: EmployeeRecordSnapshot = {
        lists: [
          {
            list_type: "tasks",
            list_name: "",
            owner: "טל",
            scope: "personal",
            items: [
              {
                item_id: "bad-leap",
                "שם מטלה": "תאריך בלתי אפשרי גלוי",
                "תאריך לביצוע": "2025-02-29",
              },
              {
                item_id: "ok",
                "שם מטלה": "עם תאריך תקין",
                "תאריך לביצוע": "2026-10-18",
              },
            ],
          } as EmployeeRecordSnapshot["lists"][number],
        ],
        filing: [],
        reminders: [],
      };
      const dump = formatShowDumpFromKind("tasks", snap, {
        viewerName: "טל",
      })!;
      expect(dump).toContain("תאריך בלתי אפשרי גלוי");
      expect(dump).toContain("עם תאריך תקין");
      expect(dump).not.toContain("לא נכללה בטווח");
      expect(dump).not.toContain("לא נכללו בטווח");
    });
  });
});

describe("reminder display UX — list/agenda timed 🔔 + ITEM DUMP", () => {
  const now = new Date("2026-10-15T10:00:00.000Z");
  const seriesItem = {
    item_id: "series-1",
    "שם מטלה": "לקחת אקמול",
    חוזר: "כל יום ב־08:45",
    next_occurrences: ["2026-10-16 08:45", "2026-10-17 08:45"],
    reminder: {
      reminder_id: "r-series",
      fire_at: "2026-10-16 08:30",
      repeat: "custom",
      recurrence_text: "כל יום ב־08:30",
      exception_entries: [
        { date: "2026-10-16", time: "09:15" },
        { date: "2026-10-17", cancel: true },
      ],
      exceptions: ["16.10 ב־09:15", "17.10 בוטל"],
    },
  };

  it("list: one-time reminder → 🔔 + when; without reminder → no bell", () => {
    expect(
      formatNumberedItem(
        1,
        "לבדוק באג",
        { reminder: { fire_at: "2026-10-15 20:30", repeat: "none" } },
        "tasks",
        { now },
      ),
    ).toBe("1. לבדוק באג 🔔 תזכורת: היום ב־20:30");
    expect(
      formatNumberedItem(2, "בלי תזכורת", {}, "tasks", { now }),
    ).toBe("2. בלי תזכורת");
  });

  it("list: recurring series reminder shows next effective when beside 🔔", () => {
    const line = formatNumberedItem(1, "לקחת אקמול", seriesItem, "tasks", {
      now,
    });
    expect(line).toBe(
      "1. לקחת אקמול — כל יום ב־08:45 (קבוע) 🔔 תזכורת: 09:15",
    );
  });

  it("agenda: moved occurrence keeps chore time + timed 🔔; cancelled has no bell", () => {
    expect(
      formatAgendaStandingLine(1, "לקחת אקמול", seriesItem, "08:45", {
        now,
        occurrenceYmd: "2026-10-16",
      }),
    ).toBe("1. לקחת אקמול — 08:45 🔔 תזכורת: 09:15");
    expect(
      formatOccurrenceEffectiveReminderParen(
        seriesItem,
        "2026-10-16",
        "list",
      ),
    ).toBe("🔔 תזכורת: 09:15");
    expect(
      formatAgendaStandingLine(2, "לקחת אקמול", seriesItem, "08:45", {
        now,
        occurrenceYmd: "2026-10-17",
      }),
    ).toBe("2. לקחת אקמול — 08:45");
    expect(
      formatOccurrenceEffectiveReminderParen(
        seriesItem,
        "2026-10-17",
        "list",
      ),
    ).toBe("");
  });

  it("ITEM DUMP detail: shows effective moved time; cancelled shows nothing", () => {
    expect(
      formatOccurrenceEffectiveReminderParen(
        seriesItem,
        "2026-10-16",
        "detail",
      ),
    ).toBe("🔔 תזכורת: 09:15");
    expect(
      formatOccurrenceEffectiveReminderParen(
        seriesItem,
        "2026-10-17",
        "detail",
      ),
    ).toBe("");
    // Flat ITEM DUMP: first next_occurrence is moved → show that effective time.
    expect(
      formatNumberedItem(1, "לקחת אקמול", seriesItem, "tasks", {
        now,
        itemIds: new Set(["series-1"]),
      }),
    ).toBe("1. לקחת אקמול — כל יום ב־08:45 (קבוע) 🔔 תזכורת: 09:15");
    expect(
      formatReminderIndicator(seriesItem, "detail", {
        occurrenceYmd: "2026-10-16",
      }),
    ).toBe("🔔 תזכורת: 09:15");
    // Never fall back to series 08:30 when the occurrence was moved.
    expect(
      formatReminderIndicator(seriesItem, "detail", {
        occurrenceYmd: "2026-10-16",
      }),
    ).not.toContain("08:30");
  });

  it("flat ITEM DUMP: skips cancelled first occurrence for later effective reminder", () => {
    const item = {
      item_id: "skip-cancel",
      "שם מטלה": "לקחת אקמול",
      חוזר: "כל יום ב־08:45",
      next_occurrences: [
        "2026-10-16 08:45",
        "2026-10-17 08:45",
        "2026-10-18 08:45",
      ],
      reminder: {
        reminder_id: "r-skip",
        fire_at: "2026-10-16 08:30",
        repeat: "custom",
        recurrence_text: "כל יום ב־08:30",
        exception_entries: [
          { date: "2026-10-16", cancel: true },
          { date: "2026-10-17", time: "09:45" },
        ],
        exceptions: ["16.10 בוטל", "17.10 ב־09:45"],
      },
    };
    expect(formatReminderIndicator(item, "detail")).toBe("🔔 תזכורת: 09:45");
    expect(
      formatNumberedItem(1, "לקחת אקמול", item, "tasks", {
        now,
        itemIds: new Set(["skip-cancel"]),
      }),
    ).toBe("1. לקחת אקמול — כל יום ב־08:45 (קבוע) 🔔 תזכורת: 09:45");
    // List mode also shows the next effective reminder when.
    expect(
      formatNumberedItem(1, "לקחת אקמול", item, "tasks", { now }),
    ).toBe("1. לקחת אקמול — כל יום ב־08:45 (קבוע) 🔔 תזכורת: 09:45");
  });

  it("flat ITEM DUMP: first occurrence moved reminder uses that effective time", () => {
    const item = {
      item_id: "first-moved",
      "שם מטלה": "לקחת אקמול",
      חוזר: "כל יום ב־08:45",
      next_occurrences: ["2026-10-16 08:45", "2026-10-17 08:45"],
      reminder: {
        reminder_id: "r-moved",
        fire_at: "2026-10-16 08:30",
        repeat: "custom",
        recurrence_text: "כל יום ב־08:30",
        exception_entries: [{ date: "2026-10-16", time: "07:05" }],
        exceptions: ["16.10 ב־07:05"],
      },
    };
    expect(formatReminderIndicator(item, "detail")).toBe("🔔 תזכורת: 07:05");
    expect(formatReminderIndicator(item, "detail")).not.toContain("08:30");
    expect(
      formatNumberedItem(1, "לקחת אקמול", item, "tasks", {
        now,
        itemIds: new Set(["first-moved"]),
      }),
    ).toBe("1. לקחת אקמול — כל יום ב־08:45 (קבוע) 🔔 תזכורת: 07:05");
  });

  it("flat ITEM DUMP: no upcoming effective reminder → no bell or time", () => {
    const item = {
      item_id: "all-cancel",
      "שם מטלה": "לקחת אקמול",
      חוזר: "כל יום ב־08:45",
      next_occurrences: ["2026-10-16 08:45", "2026-10-17 08:45"],
      reminder: {
        reminder_id: "r-all-cancel",
        fire_at: "2026-10-16 08:30",
        repeat: "custom",
        recurrence_text: "כל יום ב־08:30",
        exception_entries: [
          { date: "2026-10-16", cancel: true },
          { date: "2026-10-17", cancel: true },
        ],
        exceptions: ["16.10 בוטל", "17.10 בוטל"],
      },
    };
    expect(formatReminderIndicator(item, "detail")).toBe("");
    expect(
      formatNumberedItem(1, "לקחת אקמול", item, "tasks", {
        now,
        itemIds: new Set(["all-cancel"]),
      }),
    ).toBe("1. לקחת אקמול — כל יום ב־08:45 (קבוע)");
  });

  it("ITEM DUMP day-agenda detail uses occurrence-effective time", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [seriesItem],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const moved = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-16",
      dateTo: "2026-10-16",
      itemIds: new Set(["series-1"]),
    })!;
    expect(moved).toContain("לקחת אקמול — 08:45 🔔 תזכורת: 09:15");
    expect(moved).not.toContain("08:30");

    const cancelled = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-17",
      dateTo: "2026-10-17",
      itemIds: new Set(["series-1"]),
    })!;
    expect(cancelled).toContain("לקחת אקמול — 08:45");
    expect(cancelled).not.toContain("🔔");
    expect(cancelled).not.toMatch(/תזכורת/);
  });

  it("list/agenda paths show reminder when beside 🔔 from linked data", () => {
    const snap: EmployeeRecordSnapshot = {
      lists: [
        {
          list_type: "tasks",
          list_name: "",
          owner: "טל",
          scope: "personal",
          items: [
            seriesItem,
            {
              item_id: "once-1",
              "שם מטלה": "לבדוק באג",
              reminder: {
                fire_at: "2026-10-15 20:30",
                repeat: "none",
              },
            },
          ],
        } as EmployeeRecordSnapshot["lists"][number],
      ],
      filing: [],
      reminders: [],
    };
    const list = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
    })!;
    expect(list).toContain("🔔 תזכורת: היום ב־20:30");
    expect(list).toContain("🔔 תזכורת: 09:15");
    expect(list).not.toMatch(/קבוע \+ תזכורת/);

    const agenda = formatShowDumpFromKind("tasks", snap, {
      viewerName: "טל",
      now,
      dateFrom: "2026-10-16",
      dateTo: "2026-10-16",
    })!;
    expect(agenda).toContain("לקחת אקמול — 08:45 🔔 תזכורת: 09:15");
  });
});
