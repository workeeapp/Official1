/**
 * Live check: Bing kickoff + (non-shopping) dig into top SERP result.
 * No site hardcoding — query/URL come from goal + speaker answers.
 */
import {
  browserExtract,
  browserNavigate,
  clearBrowserSession,
  shutdownMissionBrowsers,
} from "../src/services/mission-tools/browser.js";
import {
  bingSearchUrl,
  extractLooksLikeLogin,
  extractLooksLikePortalGate,
  formatLoginCredentialsAsk,
  formatProductOptionsAsk,
  relevantOptionLinesFromExtract,
  searchQueryFromMission,
  stillOnSearchEngineOnly,
  topRelevantResultUrls,
} from "../src/services/mission.service.js";

const ctx = {
  userId: "00000000-0000-4000-8000-000000000001",
  speakerId: "00000000-0000-4000-8000-000000000002",
  orchestratorId: "00000000-0000-4000-8000-000000000003",
  executorId: "00000000-0000-4000-8000-000000000004",
  missionId: "00000000-0000-4000-8000-000000000077",
};

function extractBody(summary: string, dataText: unknown): string {
  if (summary.includes(":\n")) {
    return summary.split(":\n").slice(1).join(":\n");
  }
  return String(dataText || summary || "");
}

async function kickoff(
  goal: string,
  contextFacts: unknown[],
  opts: { dig?: boolean } = {},
): Promise<void> {
  console.log("\n====", goal);
  const query = searchQueryFromMission({ goal, contextFacts });
  const url = bingSearchUrl(query);
  console.log("query:", query);
  console.log("url:", url);
  await clearBrowserSession(ctx.missionId);
  const nav = await browserNavigate({ url }, ctx);
  console.log("nav:", nav.ok, (nav.summary || "").slice(0, 120));
  const ex = await browserExtract({ aspect: "search_results" }, ctx);
  const summary = String(ex.summary || "");
  const text = extractBody(summary, ex.data?.text);
  const lines = relevantOptionLinesFromExtract(goal, text);
  console.log(
    "serp options:",
    lines.length
      ? formatProductOptionsAsk(goal, lines)
      : `NO OPTIONS\n${text.slice(0, 400)}`,
  );

  if (!opts.dig) {
    return;
  }

  const digUrls = topRelevantResultUrls(goal, text, 3);
  console.log("digUrls:", digUrls);
  if (digUrls.length === 0) {
    console.log("FAIL: expected a destination URL to dig");
    process.exitCode = 1;
    return;
  }
  let digNav: Awaited<ReturnType<typeof browserNavigate>> | null = null;
  let digUrl = "";
  for (const candidate of digUrls) {
    digUrl = candidate;
    digNav = await browserNavigate({ url: candidate }, ctx);
    console.log("dig nav:", digNav.ok, (digNav.summary || "").slice(0, 160));
    if (digNav.ok) {
      break;
    }
  }
  if (!digNav?.ok) {
    console.log("FAIL: all dig URLs failed");
    process.exitCode = 1;
    return;
  }
  const digEx = await browserExtract({ aspect: "page" }, ctx);
  const digText = extractBody(String(digEx.summary || ""), digEx.data?.text);
  const toolFacts = [
    {
      tool: "browser.navigate",
      status: "done",
      result_summary: digNav.summary || digUrl,
    },
    {
      tool: "browser.extract",
      status: "done",
      result_summary: digEx.summary || digText.slice(0, 200),
    },
  ];
  console.log("stillOnSERP:", stillOnSearchEngineOnly(toolFacts));
  console.log("looksLikeLogin:", extractLooksLikeLogin(digText));
  console.log("portalGate:", extractLooksLikePortalGate(digText));
  if (extractLooksLikePortalGate(digText)) {
    console.log("login ask:", formatLoginCredentialsAsk(goal, digUrl));
  } else {
    console.log("dig page sample:", digText.slice(0, 400));
  }
}

try {
  await kickoff("לקנות מיקסר חשמלי של קנווד", []);
  await kickoff(
    "לקבוע תור לרופא בקופת חולים",
    [{ source: "speaker", text: "קופת חולים כללית, רופא משפחה." }],
    { dig: true },
  );
  await kickoff(
    "למצוא טיסה לאתונה",
    [
      {
        source: "speaker",
        text: "יוצאים מנתב״ג בשבוע הבא, שני מבוגרים.",
      },
    ],
    { dig: true },
  );
} finally {
  await clearBrowserSession(ctx.missionId);
  await shutdownMissionBrowsers();
}
