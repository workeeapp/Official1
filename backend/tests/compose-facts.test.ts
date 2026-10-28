import { beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  resolveGitDigestWindow: vi.fn(() => ({
    sinceDate: new Date("2026-09-01T00:00:00.000Z"),
    advanceLastReportSha: false,
    windowLabel: "last 7 days",
  })),
  readGitChangelog: vi.fn(async () => ({
    headSha: "abc",
    commits: [
      {
        sha: "abc",
        subject: "Add compose facts plugins",
        body: "Unify git and saved_data.",
        files: ["backend/src/services/compose-facts.ts"],
      },
    ],
    maxCount: 50,
    commitCapSaturated: false,
  })),
  formatGitChangelogForCompose: vi.fn(
    (
      commits: Array<{ subject: string }>,
      _opts?: { commitCapSaturated?: boolean },
    ) => commits.map((row, i) => `${i + 1}. ${row.subject}`).join("\n"),
  ),
}));

const records = vi.hoisted(() => ({
  getEmployeeRecordSnapshot: vi.fn(async () => ({
    lists: [],
    filing: [],
    reminders: [],
  })),
  formatEmployeeContext: vi.fn(
    () =>
      'EMPLOYEE_SAVED_DATA:\n{"lists":[{"owner":"טל","items":[{"שם פריט":"חלב"}]}]}',
  ),
}));

const contacts = vi.hoisted(() => ({
  listContactsForEmployee: vi.fn(async () => []),
  formatSpeakerContacts: vi.fn(() => ""),
}));

const clock = vi.hoisted(() => ({
  formatSessionClockContext: vi.fn(() => "SESSION_CLOCK: test"),
}));

const weather = vi.hoisted(() => ({
  fetchWeatherFacts: vi.fn(async () => ({
    place: { name: "תל אביב", latitude: 32.08, longitude: 34.78 },
    requestedDate: "2026-10-20",
    aspects: ["summary"],
    days: [
      {
        date: "2026-10-20",
        condition: "בהיר",
        weatherCode: 0,
        isRain: false,
        precipMm: 0,
        tempMinC: 18,
        tempMaxC: 28,
        tempNowC: 24,
        humidityPct: 50,
        windKmh: 10,
        windGustKmh: 15,
        waveHeightM: 0.5,
      },
    ],
  })),
  formatWeatherHebrew: vi.fn(() => "מזג האוויר בתל אביב היום: בהיר."),
  parseWeatherAspects: vi.fn(() => ["summary"]),
}));

const market = vi.hoisted(() => ({
  fetchMarketFacts: vi.fn(async () => ({
    quotes: [
      {
        symbol: "AAPL",
        name: "Apple",
        price: 190,
        changePct: 1,
        changeAbs: 2,
        dayHigh: 191,
        dayLow: 188,
        currency: "USD",
        query: "AAPL",
      },
    ],
    aspects: ["summary"],
    missing: [],
  })),
  formatMarketHebrew: vi.fn(
    () => "Apple (AAPL): 190.00 USD — שינוי +1.00%.\nלא ייעוץ השקעות.",
  ),
  parseMarketAspects: vi.fn(() => ["summary"]),
  parseMarketQueries: vi.fn((raw: unknown) =>
    String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
}));

vi.mock("../src/services/git-changelog.js", () => git);
vi.mock("../src/services/employee-records.service.js", () => records);
vi.mock("../src/services/contact.service.js", () => contacts);
vi.mock("../src/utils/relative-date.js", () => clock);
const mashov = vi.hoisted(() => ({
  parseMashovAspects: vi.fn(() => ["grades"]),
  resolveMashovReply: vi.fn(async () => "ציונים של דניאל:\n• מתמטיקה — 90"),
}));

const smartschool = vi.hoisted(() => ({
  parseSmartschoolAspects: vi.fn(() => ["homework"]),
  resolveSmartschoolReply: vi.fn(
    async () => "שיעורי בית של דניאל:\n• עברית — לקרוא",
  ),
}));

const routes = vi.hoisted(() => ({
  resolveRoutesReply: vi.fn(async () => ({
    text: "מסלול בתחבורה ציבורית מ«מיקום הבית» ל«דיזנגוף»:",
    navigateAddress: "דיזנגוף",
  })),
}));

vi.mock("../src/services/weather.js", () => weather);
vi.mock("../src/services/market.js", () => market);
vi.mock("../src/services/mashov.js", () => mashov);
vi.mock("../src/services/smartschool.js", () => smartschool);
vi.mock("../src/services/routes.js", () => routes);

import { loadComposeFacts } from "../src/services/compose-facts.js";

describe("loadComposeFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads git_log commits as a shared facts bundle", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "git_log",
      subjectEmployeeId: "tal",
      repeat: "once",
      lookbackHours: 168,
    });
    expect(bundle.kind).toBe("git_log");
    expect(bundle.facts).toContain("Add compose facts plugins");
    expect(bundle.windowLabel).toBe("last 7 days");
    expect(bundle.fixedBody).toBeUndefined();
    expect(git.readGitChangelog).toHaveBeenCalledOnce();
    expect(git.formatGitChangelogForCompose).toHaveBeenCalledWith(
      expect.any(Array),
      { commitCapSaturated: false },
    );
  });

  it("loads saved_data from the employee snapshot", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "saved_data",
      subjectEmployeeId: "tal",
      repeat: "once",
    });
    expect(bundle.kind).toBe("saved_data");
    expect(bundle.facts).toContain("EMPLOYEE_SAVED_DATA");
    expect(bundle.facts).toContain("חלב");
    expect(bundle.sessionClock).toContain("SESSION_CLOCK");
    expect(records.getEmployeeRecordSnapshot).toHaveBeenCalledWith("tal");
  });

  it("returns creative kind when no compose source", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "",
      subjectEmployeeId: "tal",
      repeat: "once",
    });
    expect(bundle).toMatchObject({ kind: "creative", facts: "" });
    expect(git.readGitChangelog).not.toHaveBeenCalled();
    expect(records.getEmployeeRecordSnapshot).not.toHaveBeenCalled();
  });

  it("loads weather with fixedBody for compose_place", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "weather",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "תל אביב",
    });
    expect(bundle.kind).toBe("weather");
    expect(bundle.fixedBody).toContain("תל אביב");
    expect(weather.fetchWeatherFacts).toHaveBeenCalledWith(
      expect.objectContaining({ place: "תל אביב" }),
    );
  });

  it("asks for place when weather compose_place is empty", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "weather",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "",
    });
    expect(bundle.kind).toBe("weather");
    expect(bundle.fixedBody).toContain("לאיזה מקום");
    expect(weather.fetchWeatherFacts).not.toHaveBeenCalled();
  });

  it("loads market with fixedBody for compose_place tickers", async () => {
    const bundle = await loadComposeFacts({
      composeSource: "market",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "AAPL,BTC-USD",
    });
    expect(bundle.kind).toBe("market");
    expect(bundle.fixedBody).toContain("AAPL");
    expect(market.fetchMarketFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        queries: ["AAPL", "BTC-USD"],
      }),
    );
  });

  it("asks when market compose_place is empty", async () => {
    market.parseMarketQueries.mockReturnValueOnce([]);
    const bundle = await loadComposeFacts({
      composeSource: "market",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "",
    });
    expect(bundle.kind).toBe("market");
    expect(bundle.fixedBody).toContain("לאיזה");
    expect(market.fetchMarketFacts).not.toHaveBeenCalled();
  });

  it("loads mashov with fixedBody from filings snapshot", async () => {
    records.getEmployeeRecordSnapshot.mockResolvedValueOnce({
      lists: [],
      filing: [
        { item_name: "תעודת זהות למשוב", item_info: "1" },
      ],
      reminders: [],
    });
    const bundle = await loadComposeFacts({
      composeSource: "mashov",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "דניאל",
    });
    expect(bundle.kind).toBe("mashov");
    expect(bundle.fixedBody).toContain("דניאל");
    expect(mashov.resolveMashovReply).toHaveBeenCalledWith(
      expect.objectContaining({ child: "דניאל" }),
    );
    // Compose/watch Mashov stays open-range — no dateFrom/dateTo on the call.
    const call = mashov.resolveMashovReply.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).not.toHaveProperty("dateFrom");
    expect(call).not.toHaveProperty("dateTo");
  });

  it("loads smartschool with fixedBody from filings snapshot", async () => {
    records.getEmployeeRecordSnapshot.mockResolvedValueOnce({
      lists: [],
      filing: [
        { item_name: "שם משתמש לסמארט סקול", item_info: "u" },
      ],
      reminders: [],
    });
    const bundle = await loadComposeFacts({
      composeSource: "smartschool",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "דניאל",
    });
    expect(bundle.kind).toBe("smartschool");
    expect(bundle.fixedBody).toContain("דניאל");
    expect(smartschool.resolveSmartschoolReply).toHaveBeenCalledWith(
      expect.objectContaining({ child: "דניאל" }),
    );
    expect(bundle.eval?.smartschoolFingerprint).toBeTruthy();
  });

  it("routes compose passes subject snapshot into resolveRoutesReply", async () => {
    const snapshot = {
      lists: [],
      filing: [
        {
          filing_id: "f-home",
          item_name: "מיקום הבית",
          item_info: "32.099279, 34.8923104",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
      reminders: [],
    };
    records.getEmployeeRecordSnapshot.mockResolvedValueOnce(snapshot);
    const bundle = await loadComposeFacts({
      composeSource: "routes",
      subjectEmployeeId: "tal",
      repeat: "once",
      composePlace: "מיקום הבית|דיזנגוף סנטר",
    });
    expect(bundle.kind).toBe("routes");
    expect(bundle.fixedBody).toContain("מיקום הבית");
    expect(records.getEmployeeRecordSnapshot).toHaveBeenCalledWith("tal");
    expect(routes.resolveRoutesReply).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "מיקום הבית",
        destination: "דיזנגוף סנטר",
        snapshot,
      }),
    );
  });
});
