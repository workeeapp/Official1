import { HOSTED_WEB_SEARCH_MODEL } from "../llm-client.js";
import { cachedHostedWebSearch } from "../external-lookup.service.js";
import type { MissionToolHandler } from "./types.js";

/** Mission tool name for OpenAI hosted web_search. */
export const WEB_SEARCH_TOOL = "web.search";

/**
 * Hosted web search → TOOL_RESULTS evidence (citations + answer text).
 * Read-through ExternalDataCache (HIT burns 0 user quota; mission path omits userId).
 */
export const webSearchTool: MissionToolHandler = async (args) => {
  const query =
    typeof args.query === "string"
      ? args.query.trim()
      : typeof args.q === "string"
        ? args.q.trim()
        : "";
  if (!query) {
    return { ok: false, summary: "web.search requires query" };
  }
  const model =
    typeof args.model === "string" && args.model.trim()
      ? args.model.trim()
      : HOSTED_WEB_SEARCH_MODEL;
  const forceRefresh =
    args.force_refresh === true ||
    args.forceRefresh === true ||
    args.refresh === true;
  const userId =
    typeof args.userId === "string" && args.userId.trim()
      ? args.userId.trim()
      : typeof args.user_id === "string" && args.user_id.trim()
        ? args.user_id.trim()
        : null;

  try {
    const result = await cachedHostedWebSearch({
      query,
      model,
      forceRefresh,
      userId,
    });
    if (result.quotaBlocked) {
      return {
        ok: false,
        summary: `web.search quota blocked for «${query}»`,
        data: { query, sources: [], quotaBlocked: true },
      };
    }
    const text = result.payload.text.trim();
    if (!text && result.payload.sources.length === 0) {
      return {
        ok: false,
        summary: `web.search empty for «${query}»`,
        data: { query, sources: [], cacheHit: result.cacheHit },
      };
    }
    const sourcesBlock =
      result.payload.sources.length > 0
        ? `SOURCES:\n${result.payload.sources
            .slice(0, 8)
            .map((s) => `- ${s}`)
            .join("\n")}`
        : "";
    const cacheNote = result.cacheHit ? "cache=HIT" : "cache=MISS";
    const summary = [`web.search: ${query} (${cacheNote})`, text, sourcesBlock]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4000);
    return {
      ok: true,
      summary,
      data: {
        query,
        sources: result.payload.sources.slice(0, 8),
        model,
        cacheHit: result.cacheHit,
        ageSeconds: result.ageSeconds,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: `web.search failed: ${msg}`.slice(0, 500),
      data: { query },
    };
  }
};
