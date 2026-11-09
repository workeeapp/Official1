import {
  HOSTED_WEB_SEARCH_MODEL,
  runHostedWebSearch,
} from "../llm-client.js";
import type { MissionToolHandler } from "./types.js";

/** Mission tool name for OpenAI hosted web_search. */
export const WEB_SEARCH_TOOL = "web.search";

/**
 * Hosted web search → TOOL_RESULTS evidence (citations + answer text).
 * Does not browse or fill forms; executor may still browser.navigate to a source URL.
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

  try {
    const result = await runHostedWebSearch({ query, model });
    const text = result.text.trim();
    if (!text && result.sources.length === 0) {
      return {
        ok: false,
        summary: `web.search empty for «${query}»`,
        data: { query, sources: [] },
      };
    }
    const sourcesBlock =
      result.sources.length > 0
        ? `SOURCES:\n${result.sources
            .slice(0, 8)
            .map((s) => `- ${s}`)
            .join("\n")}`
        : "";
    const summary = [`web.search: ${query}`, text, sourcesBlock]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4000);
    return {
      ok: true,
      summary,
      data: {
        query,
        sources: result.sources.slice(0, 8),
        model,
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
