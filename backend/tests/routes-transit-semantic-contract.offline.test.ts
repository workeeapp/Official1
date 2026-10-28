/**
 * Semantic-contract tests for transit UX ACTION parameters (#6/#7 board open).
 *
 * What this proves (offline):
 * - Prompt/schema/runtime text instructs recalculate / disclose_network_disruption /
 *   open_itinerary correctly, without contradictions that force inventing O/D.
 * - If the model emits the intended metadata, parseRoutesAction yields the
 *   expected structured ACTION (pipeline contract).
 * - Closed-choice open commands do not swallow missed-bus / mixed / new-trip
 *   paraphrases (engine exception stays exact-only).
 *
 * What this does NOT prove:
 * - That a live model will always emit these fields for natural Hebrew.
 *   That requires LIVE_FULL / live-model evaluation (out of scope here).
 *
 * Run: npx vitest run tests/routes-transit-semantic-contract.offline.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoutesAction } from "@workee/shared";
import { mapRoutesOpenCommand } from "../src/services/routes.js";

const root = resolve(process.cwd(), "..");
const chat = readFileSync(resolve(process.cwd(), "src/services/chat.service.ts"), "utf8");
const config = readFileSync(resolve(root, "LLM.config.json"), "utf8");
const action = readFileSync(resolve(root, "LLM.action.json"), "utf8");
const actionJson = JSON.parse(action) as {
  response_format: {
    json_schema: {
      schema: {
        properties: {
          metadata: {
            properties: {
              routes: {
                required?: string[];
                properties: Record<string, { description?: string }>;
                description: string;
              };
            };
          };
        };
      };
    };
  };
};
const routesSchema =
  actionJson.response_format.json_schema.schema.properties.metadata.properties
    .routes;

/** Representative NL → intended ACTION metadata (mocked model output). */
type SemanticCase = {
  id: string;
  utterance: string;
  /** Mocked model metadata.routes (or null). */
  mockedRoutes: Record<string, unknown> | null;
  expect: {
    recalculate?: boolean;
    discloseNetworkDisruption?: boolean;
    openItinerary?: "recommended" | "all" | number | null;
    origin?: string;
    destination?: string;
    /** Closed-choice engine shortcut must not fire. */
    openCommand?: null | "recommended" | "all" | number;
  };
};

const cases: SemanticCase[] = [
  {
    id: "missed-canonical",
    utterance: "פספסתי את האוטובוס, מה עכשיו?",
    mockedRoutes: {
      recalculate: true,
      origin: "",
      destination: "",
      aspects: ["summary"],
    },
    expect: {
      recalculate: true,
      openItinerary: null,
      origin: "",
      destination: "",
      openCommand: null,
    },
  },
  {
    id: "missed-paraphrase-didnt-catch",
    utterance: "לא הספקתי לאוטובוס, תמצאי לי חלופה.",
    mockedRoutes: {
      recalculate: true,
      origin: "",
      destination: "",
      aspects: ["summary"],
    },
    expect: {
      recalculate: true,
      openItinerary: null,
      openCommand: null,
    },
  },
  {
    id: "missed-after-intervening-reminder",
    // Conversation had a trip board; an automated Lucy reminder intervened;
    // speaker still wants alternatives now — model must recalculate, not open.
    utterance: "פספסתי — מה האלטרנטיבות עכשיו?",
    mockedRoutes: {
      recalculate: true,
      aspects: ["summary"],
    },
    expect: {
      recalculate: true,
      openItinerary: null,
      openCommand: null,
    },
  },
  {
    id: "disruption-only",
    utterance: "יש שיבושים או ביטולים ברשת התחבורה הציבורית עכשיו?",
    mockedRoutes: {
      disclose_network_disruption: true,
    },
    expect: {
      discloseNetworkDisruption: true,
      recalculate: false,
      openItinerary: null,
      origin: "",
      destination: "",
      openCommand: null,
    },
  },
  {
    id: "mixed-route-plus-disruption",
    utterance: "איך מגיעים מפתח תקווה לתל אביב, ויש שיבושים ברשת?",
    mockedRoutes: {
      origin: "תחנה מרכזית פתח תקווה",
      destination: "תחנה מרכזית תל אביב",
      aspects: ["summary"],
      disclose_network_disruption: true,
    },
    expect: {
      origin: "תחנה מרכזית פתח תקווה",
      destination: "תחנה מרכזית תל אביב",
      discloseNetworkDisruption: true,
      recalculate: false,
      openItinerary: null,
      openCommand: null,
    },
  },
  {
    id: "open-recommended-exact",
    utterance: "המסלול המומלץ",
    mockedRoutes: {
      open_itinerary: "recommended",
      origin: "",
      destination: "",
    },
    expect: {
      openItinerary: "recommended",
      recalculate: false,
      openCommand: "recommended",
    },
  },
  {
    id: "mixed-open-wording-plus-new-destination",
    // Must NOT be treated as closed open — material dest change → fresh search.
    utterance: "המסלול המומלץ אבל לחיפה",
    mockedRoutes: {
      origin: "פתח תקווה",
      destination: "חיפה מרכז",
      aspects: ["summary"],
      recalculate: true,
    },
    expect: {
      origin: "פתח תקווה",
      destination: "חיפה מרכז",
      recalculate: true,
      openItinerary: null,
      openCommand: null,
    },
  },
];

describe("prompt/schema/runtime wiring for transit semantic intents", () => {
  it("schema exposes recalculate and disclose_network_disruption", () => {
    expect(routesSchema.properties.recalculate).toBeTruthy();
    expect(routesSchema.properties.disclose_network_disruption).toBeTruthy();
    expect(routesSchema.properties.open_itinerary?.description).toMatch(
      /Ignored when recalculate:true/,
    );
    expect(routesSchema.properties.origin?.description).toMatch(
      /recalculate:true|disclose_network_disruption/,
    );
  });

  it("config no longer claims bare origin-required for empty O/D paths", () => {
    expect(config).toMatch(
      /origin required for ordinary trip \(empty OK for open_itinerary \/ recalculate \/ disclose_network_disruption alone\)/,
    );
    expect(config).toMatch(/recalculate:true/);
    expect(config).toMatch(/disclose_network_disruption:true/);
    expect(config).toMatch(/לא הספקתי לאוטובוס/);
    expect(config).toMatch(/intervening assistant message/);
  });

  it("chat ROUTES teaches recalculate, disclose, open vs material change", () => {
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?Missed bus\/departure[\s\S]*?intervening assistant reminder[\s\S]*?recalculate:true/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?FORBIDDEN open_itinerary for missed-bus/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?disclose_network_disruption:true[\s\S]*?do not block the route/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?Exact typed board commands alone[\s\S]*?open_itinerary/,
    );
    expect(chat).toMatch(
      /ROUTES:[\s\S]*?board wording plus a new place[\s\S]*?fresh O\/D/,
    );
  });

  it("action description covers missed paraphrases + mixed disruption", () => {
    expect(routesSchema.description).toMatch(/recalculate:true/);
    expect(routesSchema.description).toMatch(/לא הספקתי לאוטובוס/);
    expect(routesSchema.description).toMatch(/disclose_network_disruption:true/);
    expect(routesSchema.description).toMatch(/do not block the route/);
    expect(routesSchema.description).toMatch(/intervening assistant message/);
  });
});

describe("mocked model outputs → expected ACTION (pipeline contract)", () => {
  for (const c of cases) {
    it(`${c.id}: «${c.utterance}»`, () => {
      // 1) Closed-choice engine must not mis-intercept (exact-only).
      const openCmd = mapRoutesOpenCommand(c.utterance);
      if (c.expect.openCommand === null) {
        expect(openCmd).toBeNull();
      } else if (c.expect.openCommand !== undefined) {
        expect(openCmd).toBe(c.expect.openCommand);
      }

      // 2) Mocked model metadata parses to the intended structured ACTION.
      const parsed = parseRoutesAction(
        c.mockedRoutes == null ? {} : { routes: c.mockedRoutes },
      );
      if (c.mockedRoutes == null) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      if (c.expect.recalculate !== undefined) {
        expect(parsed!.recalculate).toBe(c.expect.recalculate);
      }
      if (c.expect.discloseNetworkDisruption !== undefined) {
        expect(parsed!.discloseNetworkDisruption).toBe(
          c.expect.discloseNetworkDisruption,
        );
      }
      if (c.expect.openItinerary !== undefined) {
        expect(parsed!.openItinerary).toBe(c.expect.openItinerary);
      }
      if (c.expect.origin !== undefined) {
        expect(parsed!.origin).toBe(c.expect.origin);
      }
      if (c.expect.destination !== undefined) {
        expect(parsed!.destination).toBe(c.expect.destination);
      }
      // Missed-bus / recalculate must never keep a stale open_itinerary.
      if (c.expect.recalculate === true) {
        expect(parsed!.openItinerary).toBeNull();
      }
    });
  }

  it("recalculate wins over open_itinerary if both appear in mocked output", () => {
    const parsed = parseRoutesAction({
      routes: {
        recalculate: true,
        open_itinerary: "recommended",
        aspects: ["summary"],
      },
    });
    expect(parsed).toMatchObject({
      recalculate: true,
      openItinerary: null,
    });
  });

  it("both intents preserved: trip O/D + disclose_network_disruption", () => {
    const parsed = parseRoutesAction({
      routes: {
        origin: "A",
        destination: "B",
        aspects: ["summary"],
        disclose_network_disruption: true,
      },
    });
    expect(parsed).toMatchObject({
      origin: "A",
      destination: "B",
      discloseNetworkDisruption: true,
      recalculate: false,
    });
  });
});

describe("evidence boundary (documentation)", () => {
  it("documents that live-model NL→ACTION emission is unverified here", () => {
    // This suite intentionally uses mocked metadata. Presence of this assertion
    // keeps the report honest: prompt/schema + parse contracts ≠ live emission.
    expect(cases.length).toBeGreaterThanOrEqual(7);
    expect(cases.every((c) => typeof c.utterance === "string")).toBe(true);
  });
});
