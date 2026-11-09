/**
 * Live check of generic dig paths for the four example shapes.
 * No site hardcoding — Bing + topRelevantResultUrls + extract signals only.
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
  topRelevantResultUrls,
} from "../src/services/mission.service.js";

const ctxBase = {
  userId: "00000000-0000-4000-8000-000000000001",
  speakerId: "00000000-0000-4000-8000-000000000002",
  orchestratorId: "00000000-0000-4000-8000-000000000003",
  executorId: "00000000-0000-4000-8000-000000000004",
};

function body(summary: string, dataText: unknown): string {
  if (summary.includes(":\n")) {
    return summary.split(":\n").slice(1).join(":\n");
  }
  return String(dataText || summary || "");
}

async function runCase(input: {
  label: string;
  goal: string;
  facts: unknown[];
  missionId: string;
}): Promise<void> {
  const ctx = { ...ctxBase, missionId: input.missionId };
  console.log("\n========", input.label);
  const query = searchQueryFromMission({
    goal: input.goal,
    contextFacts: input.facts,
  });
  console.log("query:", query);
  await clearBrowserSession(ctx.missionId);
  const nav = await browserNavigate(
    { url: bingSearchUrl(query) },
    ctx,
  );
  console.log("serp:", nav.ok, (nav.summary || "").slice(0, 100));
  const ex = await browserExtract({ aspect: "search_results" }, ctx);
  const text = body(String(ex.summary || ""), ex.data?.text);
  const lines = relevantOptionLinesFromExtract(input.goal, text);
  console.log(
    "serp hits:",
    lines.length ? lines.slice(0, 3).join(" | ") : text.slice(0, 200),
  );
  let digText = text;
  let digUrls = topRelevantResultUrls(input.goal, digText, 3);
  if (digUrls.length === 0) {
    const {
      searchFallbackUrlForGoal,
    } = await import("../src/services/mission.service.js");
    const refine = searchFallbackUrlForGoal(
      searchQueryFromMission({
        goal: input.goal,
        contextFacts: input.facts,
      }),
    );
    console.log("refine:", refine);
    const rNav = await browserNavigate({ url: refine }, ctx);
    console.log("refine nav:", rNav.ok);
    const rEx = await browserExtract({ aspect: "search_results" }, ctx);
    digText = body(String(rEx.summary || ""), rEx.data?.text);
    digUrls = topRelevantResultUrls(input.goal, digText, 3);
  }
  console.log("digUrls:", digUrls);
  let opened = "";
  let pageText = "";
  for (const url of digUrls) {
    const d = await browserNavigate({ url }, ctx);
    console.log("dig:", d.ok, (d.summary || "").slice(0, 140));
    if (!d.ok) {
      continue;
    }
    opened = url;
    const page = await browserExtract({ aspect: "page" }, ctx);
    pageText = body(String(page.summary || ""), page.data?.text);
    break;
  }
  if (!opened) {
    console.log("FAIL: no dig URL opened");
    process.exitCode = 1;
    return;
  }
  console.log("opened:", opened);
  console.log("login?", extractLooksLikeLogin(pageText));
  console.log("portal?", extractLooksLikePortalGate(pageText));
  if (extractLooksLikeLogin(pageText) || extractLooksLikePortalGate(pageText)) {
    console.log("ask:", formatLoginCredentialsAsk(input.goal, opened));
  } else {
    const opts = relevantOptionLinesFromExtract(input.goal, pageText);
    console.log(
      "page signal:",
      opts.length
        ? formatProductOptionsAsk(input.goal, opts).slice(0, 400)
        : pageText.slice(0, 400),
    );
  }
}

try {
  await runCase({
    label: "score",
    goal: "כמה נגמר המשחק של הפועל פתח תקוה בכדורגל",
    facts: [],
    missionId: "00000000-0000-4000-8000-000000000081",
  });
  await runCase({
    label: "hotel",
    goal: "לחפש מלון בקופנהגן בתאריכים 10-12.11.2026 במחיר 100-150 דולר ללילה",
    facts: [],
    missionId: "00000000-0000-4000-8000-000000000082",
  });
  await runCase({
    label: "labs",
    goal: "מה תוצאות הבדיקות מעבדה שלי בקופת חולים",
    facts: [{ source: "speaker", text: "כללית" }],
    missionId: "00000000-0000-4000-8000-000000000083",
  });
  await runCase({
    label: "bank",
    goal: "לבדוק מה מצב החשבון שלי בבנק",
    facts: [{ source: "speaker", text: "בנק הפועלים" }],
    missionId: "00000000-0000-4000-8000-000000000084",
  });
} finally {
  for (const id of [
    "00000000-0000-4000-8000-000000000081",
    "00000000-0000-4000-8000-000000000082",
    "00000000-0000-4000-8000-000000000083",
    "00000000-0000-4000-8000-000000000084",
  ]) {
    await clearBrowserSession(id);
  }
  await shutdownMissionBrowsers();
}
