import {
  formatGitChangelogForCompose,
  readGitChangelog,
  resolveGitDigestWindow,
} from "./git-changelog.js";
import {
  formatEmployeeContext,
  getEmployeeRecordSnapshot,
} from "./employee-records.service.js";
import {
  formatSpeakerContacts,
  listContactsForEmployee,
} from "./contact.service.js";
import { formatSessionClockContext } from "../utils/relative-date.js";
import {
  fetchWeatherFacts,
  formatWeatherHebrew,
  parseWeatherAspects,
  type WeatherAspect,
} from "./weather.js";
import {
  fetchDailyChangePct,
  fetchMarketFacts,
  formatMarketHebrew,
  parseMarketAspects,
  parseMarketQueries,
  type MarketAspect,
} from "./market.js";
import {
  parseMashovAspects,
  resolveMashovReply,
  type MashovAspect,
} from "./mashov.js";
import {
  mashovContentFingerprint,
  weatherContentFingerprint,
  type ComposeEvalFacts,
} from "./compose-condition.js";
import type { LlmComposeCondition } from "@workee/shared";

export type ComposeSourceKind =
  | ""
  | "git_log"
  | "saved_data"
  | "weather"
  | "market"
  | "mashov";

/**
 * Fire-time facts for compose clocks. Sources differ only in how facts are
 * loaded; the outbound LLM call is shared (weather/market/mashov use fixedBody).
 */
export type ComposeFactsBundle = {
  kind: "git_log" | "saved_data" | "weather" | "market" | "mashov" | "creative";
  /** Internal facts block (git commits, EMPLOYEE_SAVED_DATA, …). */
  facts: string;
  /** Short label shown above facts in the compose message. */
  factsLabel: string;
  sessionClock?: string;
  windowLabel?: string;
  /** Skip the LLM and send this body (e.g. empty git window / weather). */
  fixedBody?: string;
  headSha?: string;
  advanceLastReportSha?: boolean;
  /** Structured signals for compose_condition evaluation. */
  eval?: ComposeEvalFacts;
};

function aspectsFromList(
  raw: string[] | unknown,
): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  return raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

export async function loadComposeFacts(input: {
  composeSource: string;
  subjectEmployeeId: string;
  repeat: string;
  lastReportSha?: string | null;
  lookbackHours?: number | null;
  composePlace?: string | null;
  /** Optional weather aspects from brief context; default summary. */
  weatherAspects?: WeatherAspect[] | unknown;
  /** Optional market aspects; default summary. */
  marketAspects?: MarketAspect[] | unknown;
  /** Optional mashov aspects; default grades. */
  mashovAspects?: MashovAspect[] | unknown;
  /** Unified aspects list from Reminder.composeAspects. */
  composeAspects?: string[] | unknown;
  /** Day index for weather_rain / weather_changed (0=today). */
  weatherDayOffset?: number;
  /** When set, also load left/right daily change % into eval. */
  composeCondition?: LlmComposeCondition | null;
  now?: Date;
}): Promise<ComposeFactsBundle> {
  const source = input.composeSource.trim();
  const listAspects = aspectsFromList(input.composeAspects);

  if (source === "git_log") {
    const lookbackHours =
      typeof input.lookbackHours === "number" ? input.lookbackHours : 0;
    const window = resolveGitDigestWindow({
      repeat: input.repeat,
      lastReportSha: input.lastReportSha,
      lookbackHours,
      now: input.now,
    });
    const log = await readGitChangelog({
      sinceSha: window.sinceSha,
      sinceDate: window.sinceDate,
    });
    const facts = formatGitChangelogForCompose(log.commits, {
      commitCapSaturated: log.commitCapSaturated,
    });
    if (!facts) {
      return {
        kind: "git_log",
        facts: "",
        factsLabel: "Commit notes",
        windowLabel: window.windowLabel,
        fixedBody: "No new product changes in that window.",
        headSha: log.headSha,
        advanceLastReportSha: window.advanceLastReportSha,
      };
    }
    return {
      kind: "git_log",
      facts,
      factsLabel: "Commit notes (internal source — do not paste verbatim as a log)",
      windowLabel: window.windowLabel,
      headSha: log.headSha,
      advanceLastReportSha: window.advanceLastReportSha,
    };
  }

  if (source === "saved_data") {
    const snapshot = await getEmployeeRecordSnapshot(input.subjectEmployeeId);
    const contacts = await listContactsForEmployee(input.subjectEmployeeId);
    const facts = [
      formatEmployeeContext(snapshot),
      formatSpeakerContacts(contacts),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "saved_data",
      facts,
      factsLabel: "Saved facts (internal — answer from these only)",
      sessionClock: formatSessionClockContext(),
    };
  }

  if (source === "weather") {
    const place = String(input.composePlace ?? "").trim();
    if (!place) {
      return {
        kind: "weather",
        facts: "",
        factsLabel: "Weather",
        fixedBody: "לאיזה מקום לבדוק את מזג האוויר?",
      };
    }
    const aspects = parseWeatherAspects(
      input.weatherAspects ?? listAspects,
    );
    const dayOffset =
      typeof input.weatherDayOffset === "number" &&
      Number.isFinite(input.weatherDayOffset)
        ? Math.max(0, Math.round(input.weatherDayOffset))
        : input.composeCondition?.type === "weather_rain" ||
            input.composeCondition?.type === "weather_changed"
          ? Math.max(0, Math.round(input.composeCondition.dayOffset ?? 0))
          : 0;
    try {
      const weather = await fetchWeatherFacts({
        place,
        aspects,
        now: input.now,
      });
      if (!weather) {
        return {
          kind: "weather",
          facts: "",
          factsLabel: "Weather",
          fixedBody: `לא מצאתי מקום בשם «${place}».`,
        };
      }
      const body = formatWeatherHebrew(weather, input.now);
      const day = weather.days[dayOffset] ?? weather.days[0];
      return {
        kind: "weather",
        facts: body,
        factsLabel: "Weather (Open-Meteo)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
        eval: {
          weatherIsRain: day?.isRain === true,
          weatherFingerprint: weatherContentFingerprint(body),
        },
      };
    } catch {
      return {
        kind: "weather",
        facts: "",
        factsLabel: "Weather",
        fixedBody:
          "לא הצלחתי לשלוף עכשיו את מזג האוויר. נסה שוב בעוד רגע.",
      };
    }
  }

  if (source === "market") {
    const condition = input.composeCondition;
    const compare =
      condition?.type === "market_change_compare" ? condition : null;
    const queries = compare
      ? [compare.left, compare.right]
      : parseMarketQueries(input.composePlace);
    if (queries.length === 0) {
      return {
        kind: "market",
        facts: "",
        factsLabel: "Market",
        fixedBody: "לאיזה מניה, מדד או מטבע קריפטו לבדוק?",
      };
    }
    const aspects = parseMarketAspects(input.marketAspects ?? listAspects);
    try {
      const facts = await fetchMarketFacts({ queries, aspects });
      const body = formatMarketHebrew(facts);
      const firstPrice = facts.quotes.find(
        (q) => q.price != null && Number.isFinite(q.price),
      )?.price;
      const evalFacts: ComposeEvalFacts = {
        marketPrice: firstPrice ?? null,
      };
      if (compare) {
        const [leftPct, rightPct] = await Promise.all([
          fetchDailyChangePct(compare.left, compare.leftDayOffset),
          fetchDailyChangePct(compare.right, compare.rightDayOffset),
        ]);
        evalFacts.marketLeftChangePct = leftPct;
        evalFacts.marketRightChangePct = rightPct;
      }
      return {
        kind: "market",
        facts: body,
        factsLabel: "Market (Yahoo Finance)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
        eval: evalFacts,
      };
    } catch {
      return {
        kind: "market",
        facts: "",
        factsLabel: "Market",
        fixedBody:
          "לא הצלחתי לשלוף עכשיו נתוני שוק. נסה שוב בעוד רגע.",
      };
    }
  }

  if (source === "mashov") {
    const child = String(input.composePlace ?? "").trim();
    const aspects = parseMashovAspects(
      input.mashovAspects ?? listAspects,
    );
    try {
      const snapshot = await getEmployeeRecordSnapshot(input.subjectEmployeeId);
      // Contract: compose/watch Mashov is intentionally open-range until
      // reminder compose metadata carries date_from/date_to. Do not pass
      // event-date bounds here — never pretend a chat date filter applies.
      const body = await resolveMashovReply({
        filings: snapshot.filing ?? [],
        child,
        aspects,
        now: input.now,
      });
      return {
        kind: "mashov",
        facts: body,
        factsLabel: "Mashov (משוב)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
        eval: {
          mashovFingerprint: mashovContentFingerprint(body),
        },
      };
    } catch {
      return {
        kind: "mashov",
        facts: "",
        factsLabel: "Mashov",
        fixedBody:
          "לא הצלחתי לשלוף עכשיו נתונים ממשוב. נסה שוב בעוד רגע.",
      };
    }
  }

  return {
    kind: "creative",
    facts: "",
    factsLabel: "",
  };
}
