import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLlmMetadata } from "@workee/shared";
import {
  BOOTSTRAP_PLAN_STEPS,
  clearReSearchFlags,
  countBrowseTools,
  distinctHostsFromToolResults,
  emptyMissionTurnPolicy,
  evaluateBrowseBudget,
  extractLooksRepeated,
  extractTextFromToolSummary,
  formatAutomationBlockedAsk,
  extractMatchesGoal,
  formatProductOptionsAsk,
  formatSearchBudgetExhaustedAsk,
  formatSearchFailedAsk,
  hostFromUrlOrSummary,
  isUselessSearchExtract,
  productOptionLinesFromExtract,
  relevantOptionLinesFromExtract,
  missionNeedsFreshSearch,
  resumeImpliesReSearch,
  SEARCH_BROWSE_BUDGET,
  SEARCH_MAX_HOSTS,
  searchFallbackUrlForGoal,
  searchQueryFromGoal,
  searchQueryFromMission,
  searchUrlForGoal,
  shouldBootstrapExtract,
  shouldBootstrapWebSearch,
  shouldStartEngineWebSearch,
  shouldStopNavigateLoop,
  stillOnSearchEngineOnly,
  topRelevantResultUrl,
  isSearchEngineHost,
  normalizeSerpDisplayUrl,
  extractLooksLikePortalGate,
  digEmptyRetryCount,
  bumpDigEmptyRetry,
  MAX_DIG_EMPTY_RETRIES,
  formatDigStuckAsk,
  formatSerpFactEvidenceAsk,
  looksLikeGenericHubPath,
  priorSerpFactExtract,
  inferMissionShape,
  isNonMissionAnswerText,
  isSearchableSpeakerFact,
  usesHostedWebSearchBootstrap,
  hasWebSearchTool,
  MISSION_EXECUTOR_MODEL,
  answerTextFromWebSearchSummary,
  webSearchSummaryLooksComplete,
  scoreSerpCandidate,
  extractLooksLikeDeadPage,
  looksLikeTruncatedSerpPath,
  serpLooksLikeFactAnswer,
  textLooksLikeMatchScore,
  pastResultsControlLabel,
  trackingTitleFromGoal,
} from "../src/services/mission.service.js";
import { looksLikeCaptcha } from "../src/services/mission-tools/browser.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("emptyMissionTurnPolicy", () => {
  const approved = {
    planApprovedAt: new Date("2026-11-07T18:52:00Z"),
    planUpdatedAt: new Date("2026-11-07T18:51:00Z"),
  };

  it("bootstraps plan while still planning/open", () => {
    expect(
      emptyMissionTurnPolicy({
        status: "planning",
        planApprovedAt: null,
        planUpdatedAt: null,
      }),
    ).toBe("bootstrap_plan");
    expect(
      emptyMissionTurnPolicy({
        status: "open",
        planApprovedAt: null,
        planUpdatedAt: null,
      }),
    ).toBe("bootstrap_plan");
  });

  it("continues tools after approve when executor returns nothing (no forced browse)", () => {
    expect(
      emptyMissionTurnPolicy({ status: "running", ...approved }),
    ).toBe("continue_tools");
    expect(
      emptyMissionTurnPolicy({ status: "pending", ...approved }),
    ).toBe("continue_tools");
  });

  it("retries other active states without an approved plan", () => {
    expect(
      emptyMissionTurnPolicy({
        status: "waiting_approval",
        planApprovedAt: null,
        planUpdatedAt: new Date(),
      }),
    ).toBe("retry");
  });
});

describe("shouldBootstrapWebSearch", () => {
  const approved = {
    planApprovedAt: new Date("2026-11-07T18:52:00Z"),
    planUpdatedAt: new Date("2026-11-07T18:51:00Z"),
  };

  it("legacy forced-site bootstrap stays off", () => {
    expect(
      shouldBootstrapWebSearch(
        { status: "running", stepCount: 0, ...approved },
        0,
      ),
    ).toBe(false);
  });
});

describe("usesHostedWebSearchBootstrap / hasWebSearchTool", () => {
  it("uses hosted search for fact and generic, not options/portal", () => {
    expect(usesHostedWebSearchBootstrap("תוצאת המשחק של חיפה")).toBe(true);
    expect(usesHostedWebSearchBootstrap("מה מזג האוויר בתל אביב")).toBe(true);
    expect(usesHostedWebSearchBootstrap("מלון בתל אביב לסוף השבוע")).toBe(
      false,
    );
    expect(usesHostedWebSearchBootstrap("יתרת חשבון בבנק")).toBe(false);
  });

  it("detects web.search tool rows", () => {
    expect(hasWebSearchTool([])).toBe(false);
    expect(
      hasWebSearchTool([{ tool: "browser.navigate", status: "done" }]),
    ).toBe(false);
    expect(
      hasWebSearchTool([{ tool: "web.search", status: "done" }]),
    ).toBe(true);
  });

  it("executor model default is gpt-6-luna", () => {
    expect(MISSION_EXECUTOR_MODEL).toBe("gpt-6-luna");
  });

  it("strips web.search header/SOURCES for user-facing answer", () => {
    const raw = [
      "web.search: הפועל פתח תקווה",
      "",
      "ב־7 בנובמבר 2026 ניצחה הפועל פתח תקווה **2:1**.",
      "",
      "SOURCES:",
      "- site — https://example.com",
    ].join("\n");
    expect(answerTextFromWebSearchSummary(raw)).toBe(
      "ב־7 בנובמבר 2026 ניצחה הפועל פתח תקווה 2:1.",
    );
    expect(webSearchSummaryLooksComplete(raw)).toBe(true);
    expect(webSearchSummaryLooksComplete("web.search: q\n\nקצר")).toBe(false);
  });
});

describe("shouldStartEngineWebSearch", () => {
  const approved = {
    planApprovedAt: new Date("2026-11-07T18:52:00Z"),
    planUpdatedAt: new Date("2026-11-07T18:51:00Z"),
    goal: "תוצאת המשחק של מכבי חיפה",
  };

  it("starts when approved running with no browse tools", () => {
    expect(
      shouldStartEngineWebSearch({ status: "running", ...approved }, []),
    ).toBe(true);
    expect(
      shouldStartEngineWebSearch(
        { status: "running", ...approved },
        [{ tool: "browser.navigate", status: "done" }],
      ),
    ).toBe(false);
  });

  it("does not start after hosted web.search already ran", () => {
    expect(
      shouldStartEngineWebSearch(
        { status: "running", ...approved },
        [{ tool: "web.search", status: "done" }],
      ),
    ).toBe(false);
  });
});

describe("topRelevantResultUrl / search-engine helpers", () => {
  it("picks a non-SERP URL from numbered extract lines", () => {
    const extract = [
      "1. אתר כללית תור לרופא https://www.clalit.co.il › he › info תורים בקופת חולים",
      "2. MyVisit https://www.bing.com/search?q=clalit",
    ].join("\n");
    expect(
      normalizeSerpDisplayUrl(
        "https://www.clalit.co.il › he › info › services › Pages › ...",
      ),
    ).toBe("https://www.clalit.co.il/he/info/services/Pages");
    expect(
      normalizeSerpDisplayUrl(
        "https://www.kiwi.com › il › cheap-flights › tel-aviv-israel › athens-greece",
      ),
    ).toBe(
      "https://www.kiwi.com/il/cheap-flights/tel-aviv-israel/athens-greece",
    );
    expect(
      topRelevantResultUrl("לקבוע תור לרופא בקופת חולים כללית", extract),
    ).toBe("https://www.clalit.co.il/he/info");
    expect(isSearchEngineHost("bing.com")).toBe(true);
    expect(isSearchEngineHost("clalit.co.il")).toBe(false);
    expect(
      stillOnSearchEngineOnly([
        {
          tool: "browser.navigate",
          status: "done",
          result_summary: "Opened https://www.bing.com/search?q=x",
        },
      ]),
    ).toBe(true);
    expect(
      stillOnSearchEngineOnly([
        {
          tool: "browser.navigate",
          status: "done",
          result_summary: "Opened https://www.clalit.co.il/",
        },
      ]),
    ).toBe(false);
    expect(
      extractLooksLikePortalGate(
        "כללית און־ליין זימון תורים תוצאות בדיקות",
      ),
    ).toBe(true);
  });
});

describe("searchQueryFromMission", () => {
  it("appends speaker context facts to the goal query", () => {
    expect(
      searchQueryFromMission({
        goal: "לקבוע תור לרופא בקופת חולים",
        contextFacts: [
          {
            source: "speaker",
            text: "קופת חולים כללית, רופא משפחה.",
          },
        ],
      }),
    ).toContain("כללית");
    expect(
      searchQueryFromMission({
        goal: "לקנות מיקסר חשמלי של קנווד",
        contextFacts: [],
      }),
    ).toContain("מיקסר");
  });
});

describe("shouldBootstrapExtract", () => {
  const approved = {
    planApprovedAt: new Date("2026-11-07T18:52:00Z"),
    planUpdatedAt: new Date("2026-11-07T18:51:00Z"),
  };

  it("is true after a navigate with no extract yet", () => {
    expect(
      shouldBootstrapExtract(
        { status: "running", ...approved },
        [{ tool: "browser.navigate", status: "done" }],
      ),
    ).toBe(true);
  });

  it("is false after extract exists", () => {
    expect(
      shouldBootstrapExtract(
        { status: "running", ...approved },
        [
          { tool: "browser.extract", status: "done" },
          { tool: "browser.navigate", status: "done" },
        ],
      ),
    ).toBe(false);
  });
});

describe("shouldStopNavigateLoop", () => {
  it("is true when last 3 tools are navigates", () => {
    expect(
      shouldStopNavigateLoop([
        { tool: "browser.navigate", status: "done" },
        { tool: "browser.navigate", status: "done" },
        { tool: "browser.navigate", status: "done" },
      ]),
    ).toBe(true);
  });

  it("is false with fewer than 3 navigates", () => {
    expect(
      shouldStopNavigateLoop([
        { tool: "browser.navigate", status: "done" },
        { tool: "browser.navigate", status: "done" },
      ]),
    ).toBe(false);
  });
});

describe("search findings / blocked copy", () => {
  it("hides DuckDuckGo error spam and asks in Hebrew", () => {
    expect(
      isUselessSearchExtract(
        "If this persists, please email us. Our support email address includes an anonymized error code that helps us understand the context of your search.",
      ),
    ).toBe(true);
    const text = formatSearchFailedAsk("לקבוע תור במשרד הפנים להוצאת דרכון");
    expect(text).toContain("לא החזיר תוצאות שימושיות");
    expect(text).toContain("סניף");
  });

  it("formats automation blocked and budget exhausted asks", () => {
    expect(formatAutomationBlockedAsk("לקנות חינה")).toContain("חומת בוטים");
    expect(formatSearchBudgetExhaustedAsk("לקנות מיקסר Kenwood")).toContain(
      "לא מצאתי",
    );
  });

  it("preserves multiline extract payload from tool summary", () => {
    const summary = [
      "Extracted search_results (120 chars) from https://www.zap.co.il/x:",
      "1. מיקסר KitchenAid ₪1890",
      "2. מיקסר Bosch ₪1200",
      "3. מיקסר Kenwood ₪990",
    ].join("\n");
    const sample = extractTextFromToolSummary(summary);
    expect(sample).toContain("\n");
    expect(sample).toContain("Kenwood");
  });
});

describe("browse budget guards", () => {
  it("counts browse tools and hosts", () => {
    const prior = [
      {
        tool: "browser.extract",
        status: "done",
        result_summary: "Extracted from https://www.zap.co.il/search: hello",
      },
      {
        tool: "browser.navigate",
        status: "done",
        result_summary: "Opened https://www.zap.co.il/search",
      },
      {
        tool: "browser.navigate",
        status: "done",
        result_summary: "Opened https://www.bing.com/search?q=x",
      },
    ];
    expect(countBrowseTools(prior)).toBe(3);
    expect(hostFromUrlOrSummary("https://www.Zap.co.il/x")).toBe("zap.co.il");
    expect(distinctHostsFromToolResults(prior).sort()).toEqual([
      "bing.com",
      "zap.co.il",
    ]);
  });

  it("allows a 4th host and blocks a 5th", () => {
    // Mix tools so this is not a navigate-loop (3 navigates in a row).
    const prior = [
      {
        tool: "browser.extract",
        status: "done",
        result_summary: "Extracted from https://d.example/x: body",
      },
      {
        tool: "browser.navigate",
        status: "done",
        result_summary: "Opened https://d.example/x",
      },
      {
        tool: "browser.extract",
        status: "done",
        result_summary: "Extracted from https://c.example/x: body",
      },
      {
        tool: "browser.navigate",
        status: "done",
        result_summary: "Opened https://c.example/x",
      },
      {
        tool: "browser.extract",
        status: "done",
        result_summary: "Extracted from https://b.example/x: body",
      },
      {
        tool: "browser.navigate",
        status: "done",
        result_summary: "Opened https://b.example/x",
      },
      {
        tool: "browser.navigate",
        status: "done",
        result_summary: "Opened https://a.example/x",
      },
    ];
    expect(distinctHostsFromToolResults(prior)).toHaveLength(SEARCH_MAX_HOSTS);
    expect(
      evaluateBrowseBudget(prior, [
        { tool: "browser.navigate", args: { url: "https://c.example/y" } },
      ]).ok,
    ).toBe(true);
    expect(
      evaluateBrowseBudget(prior, [
        { tool: "browser.navigate", args: { url: "https://e.example/x" } },
      ]),
    ).toEqual({ ok: false, reason: "host_budget" });
  });

  it("does not count observe/wait/scroll toward browse budget", () => {
    const prior = Array.from({ length: SEARCH_BROWSE_BUDGET }, (_, i) => ({
      tool: i % 2 === 0 ? "browser.navigate" : "browser.extract",
      status: "done",
      result_summary: `Opened https://www.bing.com/search?q=${i}`,
    }));
    expect(
      evaluateBrowseBudget(prior, [{ tool: "browser.observe", args: {} }]),
    ).toEqual({ ok: true });
    expect(
      evaluateBrowseBudget(prior, [{ tool: "browser.wait", args: {} }]),
    ).toEqual({ ok: true });
    expect(
      evaluateBrowseBudget(prior, [{ tool: "browser.scroll", args: {} }]),
    ).toEqual({ ok: true });
  });

  it("blocks browse over budget and repeated extract", () => {
    const many = Array.from({ length: SEARCH_BROWSE_BUDGET }, (_, i) => ({
      tool: i % 2 === 0 ? "browser.navigate" : "browser.extract",
      status: "done",
      result_summary: `Opened https://www.bing.com/search?q=${i}`,
    }));
    expect(
      evaluateBrowseBudget(many, [{ tool: "browser.click", args: {} }]),
    ).toEqual({ ok: false, reason: "browse_budget" });

    const same =
      "Extracted search_results (200 chars) from https://x.test/:\n" +
      "hello world page content that is long enough to compare for repeats xx";
    const extracts = [
      { tool: "browser.extract", status: "done", result_summary: same },
      { tool: "browser.extract", status: "done", result_summary: same },
    ];
    expect(extractLooksRepeated(extracts)).toBe(true);
    expect(
      evaluateBrowseBudget(extracts, [{ tool: "browser.extract", args: {} }]),
    ).toEqual({ ok: false, reason: "repeated_extract" });
  });

  it("blocks navigate loop", () => {
    const prior = [
      { tool: "browser.navigate", status: "done", result_summary: "a" },
      { tool: "browser.navigate", status: "done", result_summary: "b" },
      { tool: "browser.navigate", status: "done", result_summary: "c" },
    ];
    expect(shouldStopNavigateLoop(prior)).toBe(true);
    expect(
      evaluateBrowseBudget(prior, [
        { tool: "browser.navigate", args: { url: "https://x.test/" } },
      ]),
    ).toEqual({ ok: false, reason: "navigate_loop" });
  });
});

describe("looksLikeCaptcha", () => {
  it("detects google.com/sorry", () => {
    expect(
      looksLikeCaptcha(
        "https://www.google.com/sorry/index?continue=x",
        "",
        "",
      ),
    ).toBe(true);
    expect(looksLikeCaptcha("https://example.com/", "Home", "hello")).toBe(
      false,
    );
  });
});

describe("productOptionLinesFromExtract", () => {
  it("keeps priced numbered lines and formats ask", () => {
    const extract = [
      "1. Xiaomi Electric Scooter 4 Lite — 899 ₪",
      "2. Xiaomi Electric Scooter 6 — 2,002 ₪",
      "3. RIDER X RACE MINI — 2,619 ₪",
      "שלום אורח כל הקטגוריות",
    ].join("\n");
    const lines = productOptionLinesFromExtract(extract);
    expect(lines).toHaveLength(3);
    expect(formatProductOptionsAsk("לקנות קורקינט חשמלי", lines)).toContain(
      "מצאתי 3 אפשרויות",
    );
    expect(formatProductOptionsAsk("לקנות קורקינט חשמלי", lines)).toContain(
      "899 ₪",
    );
  });

  it("rejects chrome blobs and request-rejected walls", () => {
    expect(
      productOptionLinesFromExtract(
        "1. שלום אורח, התחבר כל הקטגוריות סינון תוצאות מיקסרים (7) 159 ₪",
      ),
    ).toHaveLength(0);
    expect(isUselessSearchExtract("The requested URL was rejected. Your support ID is: 123")).toBe(
      true,
    );
  });

  it("extractMatchesGoal requires a query token in the extract", () => {
    expect(
      extractMatchesGoal(
        "לקנות קורקינט חשמלי",
        "1. Xiaomi Electric Scooter — קורקינט חשמלי — 899 ₪",
      ),
    ).toBe(true);
    expect(
      extractMatchesGoal(
        "תקני לי קעקועי חינה לגבר",
        "1. Apple iPhone 17 — 2,880 ₪",
      ),
    ).toBe(false);
  });

  it("relevantOptionLinesFromExtract accepts Bing SERP without ₪ when goal matches", () => {
    const bing = [
      "1. Pinterest - 45 רעיונות של קעקועי חינה",
      "2. שיקשוק - קעקועי חינה מדבקה עמידה",
      "3. Unrelated phones only",
    ].join("\n");
    const lines = relevantOptionLinesFromExtract(
      "תקני לי קעקועי חינה לגבר",
      bing,
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/קעקועי חינה/);
  });
});

describe("searchUrlForGoal", () => {
  it("cleans query and always uses Bing (no Zap/MyVisit/Hot hard-route)", () => {
    expect(searchQueryFromGoal("לקנות לעמית קעקועי חינה")).toBe(
      "קעקועי חינה",
    );
    expect(searchQueryFromGoal("לקנות קורקינט חשמלי מתאים")).toBe(
      "קורקינט חשמלי",
    );
    expect(searchQueryFromGoal("תקני לי מיקסר לעוגה")).toBe("מיקסר לעוגה");
    const shop = searchUrlForGoal("לקנות לעמית קעקועי חינה");
    expect(shop.startsWith("https://www.bing.com/search?q=")).toBe(true);
    expect(shop).toContain(encodeURIComponent("קעקועי חינה"));
    expect(shop).not.toContain(encodeURIComponent("לעמית"));
    expect(shop).not.toContain("zap.co.il");
    expect(searchUrlForGoal("תקני לי מיקסר לעוגה")).toContain(
      encodeURIComponent("מיקסר לעוגה"),
    );
    expect(searchUrlForGoal("לקבוע תור במשרד הפנים")).toContain("bing.com");
    expect(searchUrlForGoal("תקבעי לי תור לקופת חולים")).not.toContain(
      "myvisit",
    );
    expect(searchUrlForGoal("תבטלי לי את המנוי בהוט")).not.toContain(
      "hot.net",
    );
    expect(
      searchFallbackUrlForGoal("לקנות קורקינט חשמלי").startsWith(
        "https://www.bing.com/search?q=",
      ),
    ).toBe(true);
    expect(searchFallbackUrlForGoal("לקבוע תור במשרד הפנים")).toContain(
      "bing.com",
    );
  });
});

describe("trackingTitleFromGoal", () => {
  it("keeps Hebrew imperative goals", () => {
    expect(trackingTitleFromGoal("לקנות קעקועי חינה")).toBe(
      "לקנות קעקועי חינה",
    );
  });

  it("prefixes other goals", () => {
    expect(trackingTitleFromGoal("ביטול מינוי הוט")).toBe(
      "לבצע: ביטול מינוי הוט",
    );
  });
});

describe("missions.resume parse", () => {
  it("parses resume with summary", () => {
    const meta = parseLlmMetadata({
      missions: [
        {
          action: "resume",
          mission_id: "11111111-1111-4111-8111-111111111111",
          summary: "תחפשי באינטרנט, 2 לגבר",
        },
      ],
    });
    expect(meta.missions?.[0]?.action).toBe("resume");
    expect(meta.missions?.[0]?.summary).toContain("תחפשי");
  });

  it("parses resume with re_search", () => {
    const meta = parseLlmMetadata({
      missions: [
        {
          action: "resume",
          mission_id: "11111111-1111-4111-8111-111111111111",
          summary: "תחפשי שוב",
          re_search: true,
        },
      ],
    });
    expect(meta.missions?.[0]?.action).toBe("resume");
    expect(meta.missions?.[0]?.reSearch).toBe(true);
    expect(meta.missions?.[0]?.summary).toBe("תחפשי שוב");
  });
});

describe("missionNeedsFreshSearch", () => {
  it("detects re_search on latest fact", () => {
    expect(
      missionNeedsFreshSearch([
        { source: "speaker", text: "2 לגבר" },
        { source: "speaker", text: "תחפשי שוב", re_search: true },
      ]),
    ).toBe(true);
    expect(
      missionNeedsFreshSearch([{ source: "speaker", text: "2 לגבר" }]),
    ).toBe(false);
  });

  it("clearReSearchFlags strips the flag", () => {
    const cleared = clearReSearchFlags([
      { source: "speaker", text: "תחפשי שוב", re_search: true },
    ]);
    expect(missionNeedsFreshSearch(cleared)).toBe(false);
    expect((cleared[0] as { text: string }).text).toBe("תחפשי שוב");
  });
});

describe("resumeImpliesReSearch", () => {
  it("detects search-again / search-on-site summaries", () => {
    expect(resumeImpliesReSearch("תחפשי באתר של משרד הפנים")).toBe(true);
    expect(resumeImpliesReSearch("תחפשי שוב")).toBe(true);
    expect(resumeImpliesReSearch("2 לגבר")).toBe(false);
    expect(resumeImpliesReSearch("בתל אביב")).toBe(false);
  });
});

describe("mission search-first guards in source", () => {
  it("MISSIONS_RULES require Lucy-only tracking and resume", () => {
    const src = readFileSync(
      join(here, "../src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("Tracking task = YOUR (Lucy) tasks only");
    expect(src).toContain("ensureOrchestratorTrackingTask");
    expect(src).toContain("missions.resume");
    expect(src).not.toContain("איפה לקנות, כמות, והעדפות");
  });

  it("tracking task addedById is the mission speaker (inventory visibility)", () => {
    const src = readFileSync(
      join(here, "../src/services/mission.service.ts"),
      "utf8",
    );
    expect(src).toContain("addedById: speakerId");
    expect(src).toContain("workerItemTiedToSpeaker");
    expect(src).toContain("existing.addedById !== speakerId");
  });

  it("runner kicks Bing on empty continue_tools; digs SERP; re-wakes model to dig", () => {
    const src = readFileSync(
      join(here, "../src/services/mission-runner.ts"),
      "utf8",
    );
    expect(src).toContain("shouldStartEngineWebSearch");
    expect(src).toContain("engineStartWebSearchAndWake");
    expect(src).toContain("engineStartHostedWebSearchAndWake");
    expect(src).toContain("engineStartBingWebSearchAndWake");
    expect(src).toContain("usesHostedWebSearchBootstrap");
    expect(src).toContain("WEB_SEARCH_TOOL");
    expect(src).toContain("completeMissionFromWebSearchEvidence");
    expect(src).toContain("pendingWakes");
    expect(src).toContain("from_web_search");
    expect(src).toContain("never fall back to Bing");
    expect(src).toContain("formatSearchFailedAsk");
    expect(src).toContain("searchQueryFromMission");
    expect(src).toContain("bingSearchUrl");
    expect(src).toContain("shouldBootstrapExtract");
    expect(src).toContain("recoverMissionSearchComeback");
    expect(src).toContain("topRelevantResultUrls");
    expect(src).toContain("stillOnSearchEngineOnly");
    expect(src).toContain("Do NOT Bing-kick before the executor LLM turn");
    expect(src).toContain("bumpDigEmptyRetry");
    expect(src).toContain("MAX_DIG_EMPTY_RETRIES");
    expect(src).toContain("formatDigStuckAsk");
    expect(src).toContain("formatSerpFactEvidenceAsk");
    expect(src).toContain("priorSerpFactExtract");
    expect(src).toContain("looksLikeGenericHubPath");
    expect(src).toContain("pastResultsControlLabel");
    expect(src).toContain("actionableMissions");
    expect(src).toContain("extractLooksLikeDeadPage");
    expect(src).toContain("awaiting_credentials");
    expect(src).toContain("continue_on_host");
    expect(src).not.toContain("runSearchNavigateWithFallback");
    expect(src).not.toContain("myvisit.com");
    expect(src).toContain("engineExtractAndWakeExecutor");
    expect(src).toContain('policy === "continue_tools"');
    expect(src).toContain("MISSION_EXECUTOR_INSTRUCTIONS");
    expect(src).toContain("formatSessionClockContext");
    expect(src).toContain("rulesInInstructions: true");
    expect(src).toContain("SEARCH_BROWSE_BUDGET");
  });

  it("executor instructions carry SESSION_CLOCK rules like Lucy", () => {
    const src = readFileSync(
      join(here, "../src/services/mission-executor-prompt.ts"),
      "utf8",
    );
    expect(src).toContain("MISSION_SESSION_CLOCK_RULES");
    expect(src).toContain("SESSION_CLOCK:");
    expect(src).toContain("Asia/Jerusalem");
    expect(src).toContain("weekday_dates");
  });

  it("dig empty retry helpers bump and cap", () => {
    expect(digEmptyRetryCount([])).toBe(0);
    const once = bumpDigEmptyRetry([]);
    expect(digEmptyRetryCount(once)).toBe(1);
    expect(digEmptyRetryCount(bumpDigEmptyRetry(once))).toBe(2);
    expect(MAX_DIG_EMPTY_RETRIES).toBeGreaterThanOrEqual(3);
    expect(formatDigStuckAsk("יתרת חשבון", "יתרה זמינה")).toContain("יתרת");
  });

  it("infers mission shapes and filters noisy speaker facts", () => {
    expect(inferMissionShape("מה התוצאה של עירוני טבריה בכדורגל")).toBe(
      "fact",
    );
    expect(
      inferMissionShape("תחפשי מלון בקופנהגן משלישי עד חמישי"),
    ).toBe("options");
    expect(
      inferMissionShape("תבדוק לי את התוצאות בדיקות האחרונות בכללית"),
    ).toBe("portal");
    expect(isNonMissionAnswerText("מה יש לך")).toBe(true);
    expect(isNonMissionAnswerText("כללית")).toBe(false);
    expect(isSearchableSpeakerFact("מה יש לך")).toBe(false);
    expect(isSearchableSpeakerFact("כללית, רופא משפחה")).toBe(true);
    expect(extractLooksLikeDeadPage("שגיאת 404 – page not found")).toBe(true);
    expect(
      extractLooksLikeDeadPage('Opened https://x/item — "דף לא נמצא 404 – וואלה"'),
    ).toBe(true);
    expect(
      extractLooksLikeDeadPage(
        "Extracted search_results (0 chars) from https://www.365scores.com/he/football/team/matches:",
      ),
    ).toBe(true);
    expect(
      looksLikeGenericHubPath(
        "https://www.365scores.com/he/football/team/matches",
      ),
    ).toBe(true);
    expect(
      looksLikeGenericHubPath(
        "https://www.365scores.com/he/football/match/12345",
      ),
    ).toBe(false);
    expect(
      formatSerpFactEvidenceAsk(
        "תוצאת מכבי חיפה",
        "1. מכבי חיפה ניצחה 2:1 את הפועל באר שבע",
      ),
    ).toMatch(/מצאתי ל/);
    expect(looksLikeTruncatedSerpPath("https://sports.walla.co.il/item")).toBe(
      true,
    );
    expect(
      looksLikeTruncatedSerpPath("https://sports.walla.co.il/item/12345"),
    ).toBe(false);
    expect(textLooksLikeMatchScore("15:00 מכבי חיפה")).toBe(false);
    expect(textLooksLikeMatchScore("שערים 10-11")).toBe(false);
    expect(textLooksLikeMatchScore("מכבי חיפה 0 - 4 מכבי נתניה")).toBe(true);
    expect(textLooksLikeMatchScore("מכבי חיפה 2:1 הפועל")).toBe(true);
    expect(
      serpLooksLikeFactAnswer(
        "תוצאת מכבי חיפה",
        "מי ניצח במשחק הכדורגל של אתמול? מכבי חיפה משחקים",
      ),
    ).toBe(false);
    expect(
      pastResultsControlLabel(
        "משחקי הקבוצה משחקים קודמים משחקים הבאים 15:00",
      ),
    ).toBe("משחקים קודמים");
    expect(
      serpLooksLikeFactAnswer(
        "כמה נגמר המשחק של מכבי חיפה",
        "1. הפועל תל אביב ניצחה 1:2 את מכבי חיפה - וואלה ספורט",
      ),
    ).toBe(true); // score 1:2
    expect(
      serpLooksLikeFactAnswer(
        "כמה נגמר המשחק של מכבי חיפה",
        "1. הפועל תל אביב ניצחה את מכבי חיפה - וואלה ספורט",
      ),
    ).toBe(false); // win verb alone — dig for the score
    expect(
      serpLooksLikeFactAnswer(
        "תוצאת מכבי חיפה",
        "משחקים הבאים נובמבר 2026 28 נוב' 15:00 מכבי חיפה",
      ),
    ).toBe(false);
    expect(
      looksLikeTruncatedSerpPath("https://www.sport5.co.il/articles.aspx"),
    ).toBe(true);
    expect(
      scoreSerpCandidate(
        "מלון בקופנהגן",
        "Booking הזמנת מלונות https://example.com/hotels",
        "https://example.com/hotels",
      ),
    ).toBeGreaterThan(
      scoreSerpCandidate(
        "מלון בקופנהגן",
        "מומחה המלונות בלוג https://blog.example.com/",
        "https://blog.example.com/",
      ),
    );
    expect(
      scoreSerpCandidate(
        "מכבי חיפה תוצאה",
        "כתבה https://sports.example.com/full/123",
        "https://sports.example.com/full/123",
      ),
    ).toBeGreaterThan(
      scoreSerpCandidate(
        "מכבי חיפה תוצאה",
        "כתבה https://sports.example.com/item",
        "https://sports.example.com/item",
      ),
    );
  });

  it("chat auto-resumes a single waiting_user when Lucy omits resume", () => {
    const src = readFileSync(
      join(here, "../src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("waitingBefore");
    expect(src).toContain('action: "resume"');
    expect(src).toContain("waiting_user");
    expect(src).toContain("isNonMissionAnswerText");
  });

  it("browser UA does not advertise WorkeeMission and exposes observe dig tools", () => {
    const src = readFileSync(
      join(here, "../src/services/mission-tools/browser.ts"),
      "utf8",
    );
    expect(src).not.toContain("WorkeeMission");
    expect(src).toContain("extractZapProductList");
    expect(src).toContain("model-row-v2");
    expect(src).toContain("cleanZapCardText");
    expect(src).toContain("payloadLines.join");
    expect(src).toContain("locale: \"he-IL\"");
    expect(src).toContain("browserObserve");
    expect(src).toContain("collectControls");
  });

  it("runner parks shopping options only after dig retries; dig-stuck otherwise", () => {
    const src = readFileSync(
      join(here, "../src/services/mission-runner.ts"),
      "utf8",
    );
    expect(src).toContain("productOptionLinesFromExtract");
    expect(src).toContain("formatProductOptionsAsk");
    expect(src).toContain("shoppingWithoutProducts");
    expect(src).toContain("isShoppingGoal(mission.goal)");
    expect(src).toContain("ממשיכה לחפור באתר");
  });

  it("mission tool index registers observe/wait/scroll/select/press + web.search", () => {
    const src = readFileSync(
      join(here, "../src/services/mission-tools/index.ts"),
      "utf8",
    );
    expect(src).toContain('"browser.observe"');
    expect(src).toContain('"browser.wait"');
    expect(src).toContain('"browser.scroll"');
    expect(src).toContain('"browser.select"');
    expect(src).toContain('"browser.press"');
    expect(src).toContain("WEB_SEARCH_TOOL");
    expect(src).toContain("webSearchTool");
  });

  it("mission service owns browse budgets and Bing-only URL helpers", () => {
    const src = readFileSync(
      join(here, "../src/services/mission.service.ts"),
      "utf8",
    );
    expect(src).toContain("SEARCH_BROWSE_BUDGET = 16");
    expect(src).toContain("SEARCH_MAX_HOSTS = 4");
    expect(src).toContain("evaluateBrowseBudget");
    expect(src).toContain("formatSearchBudgetExhaustedAsk");
    expect(src).toContain("isShoppingGoal");
    expect(src).toContain("bingSearchUrl");
    expect(src).toContain("usesHostedWebSearchBootstrap");
    expect(src).toContain("MISSION_EXECUTOR_MODEL");
    expect(src).not.toContain("myvisit.com");
    expect(src).not.toContain("hot.net.il");
    expect(src).not.toContain("isAppointmentGoal");
    expect(src).not.toContain("isCancelHotGoal");
    expect(src).not.toContain("formatSearchFindingsAsk");
    expect(src).not.toContain("looksLikeZapCategoryChrome");
    expect(src).not.toContain("SHOPPING_MIN_PRODUCTS");
    expect(src).toContain("shouldBootstrapWebSearch");
    expect(src).toContain("return false");
  });

  it("run_tools parks automation_blocked with ask_user notice", () => {
    const src = readFileSync(
      join(here, "../src/services/mission.service.ts"),
      "utf8",
    );
    expect(src).toContain('blockedReason === "automation_blocked"');
    expect(src).toContain("formatAutomationBlockedAsk");
    expect(src).toContain("Keep wakeAt null mid-tool");
    expect(src).toContain("actionSummary || execResult.summary");
    expect(src).toContain('re_search:${mission.id}');
    expect(src).toContain("action.reSearch === true");
  });

  it("chat routes re_search notice to recoverMissionSearchComeback", () => {
    const src = readFileSync(
      join(here, "../src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("recoverMissionSearchComeback");
    expect(src).toContain('n.startsWith("re_search:")');
    expect(src).toContain("re_search:true");
  });

  it("bootstrap plan starts with clarify then search", () => {
    expect(BOOTSTRAP_PLAN_STEPS[0]).toContain("פרטים חסרים");
    expect(BOOTSTRAP_PLAN_STEPS[1]).toContain("לחפש באינטרנט");
  });

  it("executor prompt clarifies slots then digs (model-owned path)", () => {
    const src = readFileSync(
      join(here, "../src/services/mission-executor-prompt.ts"),
      "utf8",
    );
    expect(src).toContain("ask_user FIRST");
    expect(src).toContain("באיזה אתר לחפש");
    expect(src).toContain("ask_user with up to 3 Hebrew options");
    expect(src).toContain("לא מצאתי");
    expect(src).toContain("Browse budget");
    expect(src).toContain("DIG UNTIL USEFUL");
    expect(src).toContain("browser.observe");
    expect(src).toContain("live fact");
    expect(src).toContain("authenticated portal");
    expect(src).toContain("Never invent facts");
    expect(src).toContain("continue_on_host");
    expect(src).not.toContain("3–5 concrete products");
  });

  it("Lucy creates missions for do-it and live-lookup asks", () => {
    const src = readFileSync(
      join(here, "../src/services/chat.service.ts"),
      "utf8",
    );
    expect(src).toContain("live-lookup");
    expect(src).toContain("missions.create");
    expect(src).toContain("missions.resume");
  });
});
