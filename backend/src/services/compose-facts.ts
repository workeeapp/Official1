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
  parseSmartschoolAspects,
  resolveSmartschoolReply,
  type SmartschoolAspect,
} from "./smartschool.js";
import {
  parseJewishAspects,
  resolveJewishReply,
  type JewishAspect,
} from "./jewish.js";
import { resolvePlacesReply } from "./places.js";
import { resolveFlightsReply } from "./flights.js";
import { resolveRoutesReply } from "./routes.js";
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
  | "mashov"
  | "smartschool"
  | "jewish"
  | "places"
  | "flights"
  | "routes";

/**
 * Fire-time facts for compose clocks. Sources differ only in how facts are
 * loaded; live domains use fixedBody so the outbound copy is factual.
 */
export type ComposeFactsBundle = {
  kind:
    | "git_log"
    | "saved_data"
    | "weather"
    | "market"
    | "mashov"
    | "smartschool"
    | "jewish"
    | "places"
    | "flights"
    | "routes"
    | "creative";
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
  /** Optional smartschool aspects; default homework. */
  smartschoolAspects?: SmartschoolAspect[] | unknown;
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

  if (source === "smartschool") {
    const child = String(input.composePlace ?? "").trim();
    const aspects = parseSmartschoolAspects(
      input.smartschoolAspects ?? listAspects,
    );
    try {
      const snapshot = await getEmployeeRecordSnapshot(input.subjectEmployeeId);
      const body = await resolveSmartschoolReply({
        filings: snapshot.filing ?? [],
        child,
        aspects,
      });
      return {
        kind: "smartschool",
        facts: body,
        factsLabel: "SmartSchool (סמארט סקול)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
        eval: {
          smartschoolFingerprint: mashovContentFingerprint(body),
        },
      };
    } catch {
      return {
        kind: "smartschool",
        facts: "",
        factsLabel: "SmartSchool",
        fixedBody:
          "לא הצלחתי לשלוף עכשיו נתונים מסמארט סקול. נסה שוב בעוד רגע.",
      };
    }
  }

  if (source === "jewish") {
    const place = String(input.composePlace ?? "").trim();
    const aspects = parseJewishAspects(listAspects) as JewishAspect[];
    try {
      const body = await resolveJewishReply({
        place,
        aspects: aspects.length > 0 ? aspects : ["summary"],
        now: input.now,
      });
      return {
        kind: "jewish",
        facts: body,
        factsLabel: "Jewish calendar (Hebcal)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
      };
    } catch {
      return {
        kind: "jewish",
        facts: "",
        factsLabel: "Jewish",
        fixedBody:
          "לא הצלחתי לשלוף עכשיו זמני שבת/חגים. נסה שוב בעוד רגע.",
      };
    }
  }

  if (source === "places") {
    // compose_place: "query|place" or a single search string used as query+place.
    const raw = String(input.composePlace ?? "").trim();
    if (!raw) {
      return {
        kind: "places",
        facts: "",
        factsLabel: "Places",
        fixedBody: "מה לחפש ואיפה?",
      };
    }
    const pipe = raw.indexOf("|");
    const query = pipe >= 0 ? raw.slice(0, pipe).trim() : raw;
    const place = pipe >= 0 ? raw.slice(pipe + 1).trim() : raw;
    try {
      const body = await resolvePlacesReply({
        query: query || place,
        place: place || query,
        aspects: listAspects ?? ["summary"],
      });
      return {
        kind: "places",
        facts: body,
        factsLabel: "Places (Google)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
      };
    } catch {
      return {
        kind: "places",
        facts: "",
        factsLabel: "Places",
        fixedBody:
          "לא הצלחתי לחפש עסקים עכשיו. נסה שוב בעוד רגע.",
      };
    }
  }

  if (source === "flights") {
    // compose_place: optional "airport|city" or airport / city alone.
    const raw = String(input.composePlace ?? "").trim();
    const pipe = raw.indexOf("|");
    const airport = pipe >= 0 ? raw.slice(0, pipe).trim() : raw;
    const city = pipe >= 0 ? raw.slice(pipe + 1).trim() : "";
    try {
      const body = await resolveFlightsReply({
        airport: airport || undefined,
        city: city || undefined,
        aspects: listAspects ?? ["board"],
        now: input.now,
      });
      return {
        kind: "flights",
        facts: body,
        factsLabel: "Flights (AviationStack)",
        fixedBody: body,
        sessionClock: formatSessionClockContext(input.now),
      };
    } catch {
      return {
        kind: "flights",
        facts: "",
        factsLabel: "Flights",
        fixedBody:
          "לא הצלחתי לשלוף לוח טיסות עכשיו. נסה שוב בעוד רגע.",
      };
    }
  }

  if (source === "routes") {
    // compose_place: "origin|destination" (required). Labels/ids from schedule
    // time resolve against the subject's live snapshot (same as chat routes).
    const raw = String(input.composePlace ?? "").trim();
    const pipe = raw.indexOf("|");
    const origin = pipe >= 0 ? raw.slice(0, pipe).trim() : "";
    const destination = pipe >= 0 ? raw.slice(pipe + 1).trim() : raw;
    if (!origin || !destination) {
      return {
        kind: "routes",
        facts: "",
        factsLabel: "Routes",
        fixedBody: "לסיכום מסלול צריך מוצא ויעד (compose_place: מוצא|יעד).",
      };
    }
    try {
      const snapshot = await getEmployeeRecordSnapshot(input.subjectEmployeeId);
      const result = await resolveRoutesReply({
        origin,
        destination,
        aspects: listAspects ?? ["summary"],
        snapshot,
      });
      return {
        kind: "routes",
        facts: result.text,
        factsLabel: "Routes (transit)",
        fixedBody: result.text,
        sessionClock: formatSessionClockContext(input.now),
      };
    } catch {
      return {
        kind: "routes",
        facts: "",
        factsLabel: "Routes",
        fixedBody:
          "לא הצלחתי לחשב מסלול עכשיו. נסה שוב בעוד רגע.",
      };
    }
  }

  return {
    kind: "creative",
    facts: "",
    factsLabel: "",
  };
}
