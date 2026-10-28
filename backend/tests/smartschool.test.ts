import { describe, expect, it, vi } from "vitest";
import {
  formatSmartschoolHebrew,
  loadSmartschoolCredsFromFilings,
  mapSmartschoolHomework,
  normalizeBehavior,
  normalizeHomework,
  normalizeMessages,
  normalizeTimetable,
  parseSmartschoolAspects,
  pickSmartschoolChild,
  resolveSmartschoolReply,
  SMARTSCHOOL_UNSUPPORTED_HE,
  smartschoolAspectsAllUnsupported,
  smartschoolLogin,
} from "../src/services/smartschool.js";

describe("parseSmartschoolAspects", () => {
  it("defaults to homework", () => {
    expect(parseSmartschoolAspects(undefined)).toEqual(["homework"]);
  });

  it("maps aliases", () => {
    expect(parseSmartschoolAspects(["behave", "schedule", "הודעות"])).toEqual([
      "behavior",
      "timetable",
      "messages",
    ]);
  });

  it("drops grades/absences from supported list", () => {
    expect(parseSmartschoolAspects(["grades", "homework", "absences"])).toEqual([
      "homework",
    ]);
  });
});

describe("smartschoolAspectsAllUnsupported", () => {
  it("true when only grades/absences", () => {
    expect(smartschoolAspectsAllUnsupported(["grades"])).toBe(true);
    expect(smartschoolAspectsAllUnsupported(["absences", "ציונים"])).toBe(true);
  });

  it("false when any supported aspect present", () => {
    expect(smartschoolAspectsAllUnsupported(["grades", "homework"])).toBe(
      false,
    );
  });
});

describe("loadSmartschoolCredsFromFilings", () => {
  it("reads convention filings", () => {
    const { creds, missing } = loadSmartschoolCredsFromFilings(
      [
        { item_name: "שם משתמש לסמארט סקול", item_info: "parent1" },
        { item_name: "סיסמת סמארט סקול של דניאל", item_info: "secret99" },
        { item_name: "שנת לימודים לסמארט סקול", item_info: "2026" },
      ],
      { child: "דניאל" },
    );
    expect(missing).toEqual([]);
    expect(creds).toMatchObject({
      username: "parent1",
      password: "secret99",
      year: 2026,
    });
  });

  it("reports missing fields", () => {
    const { creds, missing } = loadSmartschoolCredsFromFilings([
      { item_name: "שם משתמש לסמארט סקול", item_info: "u" },
    ]);
    expect(creds).toBeNull();
    expect(missing).toContain("סיסמת סמארט סקול");
  });

  it("ignores mashov filings", () => {
    const { creds, missing } = loadSmartschoolCredsFromFilings([
      { item_name: "תעודת זהות למשוב", item_info: "03222842" },
      { item_name: "סיסמת משוב", item_info: "ds73s" },
    ]);
    expect(creds).toBeNull();
    expect(missing).toContain("שם משתמש לסמארט סקול");
  });
});

describe("normalize helpers", () => {
  it("maps homework rows", () => {
    const rows = mapSmartschoolHomework([
      {
        subjectName: "מתמטיקה",
        homeWork: "עמוד 12",
        date: "2026-10-01",
      },
    ]);
    expect(rows).toEqual([
      { subject: "מתמטיקה", text: "עמוד 12", date: "2026-10-01" },
    ]);
  });

  it("filters homework by date range", () => {
    const { rows } = normalizeHomework(
      [
        { subjectName: "א", homeWork: "ישן", date: "2026-01-01" },
        { subjectName: "ב", homeWork: "חדש", date: "2026-10-15" },
      ],
      { range: { dateFrom: "2026-10-01", dateTo: "2026-10-31" } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("חדש");
  });

  it("maps behavior and messages", () => {
    expect(
      normalizeBehavior([
        { subjectName: "אנגלית", text: "חיזוק", date: "2026-10-02" },
      ]).rows,
    ).toHaveLength(1);
    expect(
      normalizeMessages([
        {
          senderName: "מורה",
          subject: "טיול",
          body: "מחר",
          date: "2026-10-03",
        },
      ]).rows,
    ).toHaveLength(1);
  });

  it("flattens timetable", () => {
    const days = normalizeTimetable([
      {
        dayName: "ראשון",
        lessons: [{ hour: "08:00", subjectName: "מתמטיקה" }],
      },
    ]);
    expect(days[0]?.day).toBe("ראשון");
    expect(days[0]?.lessons).toContain("מתמטיקה");
  });
});

describe("pickSmartschoolChild", () => {
  const kids = [
    {
      studentId: "1",
      login: "a",
      firstName: "דניאל",
      lastName: "כהן",
    },
    {
      studentId: "2",
      login: "b",
      firstName: "מאיה",
      lastName: "כהן",
    },
  ];

  it("asks which when several and no name", () => {
    const picked = pickSmartschoolChild(kids, "");
    expect(picked.child).toBeNull();
    expect(picked.askWhich).toHaveLength(2);
  });

  it("matches by first name", () => {
    const picked = pickSmartschoolChild(kids, "מאיה");
    expect(picked.child?.studentId).toBe("2");
  });
});

describe("formatSmartschoolHebrew", () => {
  it("asks for missing creds", () => {
    expect(
      formatSmartschoolHebrew({
        childName: "",
        aspects: ["homework"],
        homework: [],
        behavior: [],
        timetable: [],
        messages: [],
        missingCreds: ["סיסמת סמארט סקול"],
      }),
    ).toContain("סיסמת סמארט סקול");
  });

  it("formats homework lines", () => {
    const text = formatSmartschoolHebrew({
      childName: "דניאל",
      aspects: ["homework"],
      homework: [
        { subject: "מתמטיקה", text: "עמוד 12", date: "2026-10-01" },
      ],
      behavior: [],
      timetable: [],
      messages: [],
      missingCreds: [],
    });
    expect(text).toContain("שיעורי בית של דניאל");
    expect(text).toContain("מתמטיקה");
  });
});

describe("smartschoolLogin + resolveSmartschoolReply", () => {
  it("logs in with webToken cookie path", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: true,
          data: {
            token: "tok-1",
            id: "enc-1",
            studentId: "s1",
            firstName: "דניאל",
            lastName: "כהן",
            ClassCode: 3,
            ClassNumber: 3,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const session = await smartschoolLogin(
      { username: "u", password: "p", year: 2026 },
      fetchImpl,
    );
    expect(session.token).toBe("tok-1");
    expect(session.encryptedId).toBe("enc-1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns unsupported notice for grades-only ask", async () => {
    const text = await resolveSmartschoolReply({
      filings: [
        { item_name: "שם משתמש לסמארט סקול", item_info: "u" },
        { item_name: "סיסמת סמארט סקול", item_info: "p" },
      ],
      aspects: ["grades"],
    });
    expect(text).toBe(SMARTSCHOOL_UNSUPPORTED_HE);
  });

  it("asks for year when timetable without year filing", async () => {
    const text = await resolveSmartschoolReply({
      filings: [
        { item_name: "שם משתמש לסמארט סקול", item_info: "u" },
        { item_name: "סיסמת סמארט סקול", item_info: "p" },
      ],
      aspects: ["timetable"],
    });
    expect(text).toContain("שנת לימודים");
  });

  it("fetches homework after login", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes("LoginByUserNameAndPassword")) {
        return new Response(
          JSON.stringify({
            status: true,
            data: {
              token: "tok",
              id: "enc",
              studentId: "s1",
              firstName: "דניאל",
              lastName: "",
              ClassCode: 3,
              ClassNumber: 3,
            },
          }),
          { status: 200 },
        );
      }
      if (path.includes("GetMultipleUsersForUser")) {
        return new Response(JSON.stringify({ status: true, data: [] }), {
          status: 200,
        });
      }
      if (path.includes("GetHomeWork")) {
        return new Response(
          JSON.stringify({
            status: true,
            data: [
              {
                subjectName: "עברית",
                homeWork: "לקרוא פרק",
                date: "2026-10-20",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: true, data: {} }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const text = await resolveSmartschoolReply({
      filings: [
        { item_name: "שם משתמש לסמארט סקול", item_info: "u" },
        { item_name: "סיסמת סמארט סקול", item_info: "p" },
      ],
      child: "דניאל",
      aspects: ["homework"],
      fetchImpl,
    });
    expect(text).toContain("עברית");
    expect(text).toContain("לקרוא פרק");
  });
});
