/**
 * Stage C — Capability alignment (offline, structural).
 *
 * Checks ACTION schema keys ↔ shared parse surface ↔ chat live-domain
 * execution imports ↔ prompt ACTION CONTRACT mentions.
 * Prefer structure over brittle prompt-string matching.
 * No OpenAI, Prisma, WhatsApp, LIVE, or MODEL_APPLY.
 *
 *   npx vitest run tests/capability-alignment.offline.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLACES_INCLUDED_TYPE_ALLOWLIST,
  parseReplyMetadata,
} from "@workee/shared";
import { loadLlmConfig, loadLlmResponseFormat } from "../src/config/llm.js";

const REPO = resolve(import.meta.dirname, "../..");

/** Live domains with a dedicated resolve* service path in chat.service. */
const LIVE_DOMAIN_KEYS = [
  "weather",
  "market",
  "mashov",
  "smartschool",
  "places",
  "jewish",
  "routes",
  "flights",
] as const;

/** Core mutate / session ACTION keys (non-live). */
const CORE_ACTION_KEYS = [
  "lists",
  "messages",
  "jobs",
  "directory",
  "handoff",
  "register",
  "confirm",
  "send_attachments",
  "show_dump",
  "tips",
] as const;

function actionSchemaMetadataKeys(): string[] {
  const format = loadLlmResponseFormat(REPO);
  expect(format, "LLM.action.json response format").toBeTruthy();
  const schema = format!.schema as {
    properties?: {
      metadata?: { properties?: Record<string, unknown> };
    };
  };
  const props = schema.properties?.metadata?.properties;
  expect(props, "metadata.properties").toBeTruthy();
  return Object.keys(props!).sort();
}

function placesSchemaIntentEnum(): string[] {
  const raw = JSON.parse(
    readFileSync(resolve(REPO, "LLM.action.json"), "utf8"),
  ) as {
    response_format: {
      json_schema: {
        schema: {
          properties: {
            metadata: {
              properties: {
                places: {
                  properties: {
                    intent?: { enum?: Array<string | null> };
                  };
                };
              };
            };
          };
        };
      };
    };
  };
  const en =
    raw.response_format.json_schema.schema.properties.metadata.properties.places
      .properties.intent?.enum ?? [];
  return en.filter((x): x is string => typeof x === "string");
}

function chatServiceSource(): string {
  return readFileSync(
    resolve(REPO, "backend/src/services/chat.service.ts"),
    "utf8",
  );
}

function configSystemMessage(): string {
  return loadLlmConfig(REPO).systemMessage;
}

describe("Capability alignment (offline structural)", () => {
  it("schema metadata keys include core + live domains", () => {
    const keys = new Set(actionSchemaMetadataKeys());
    for (const k of [...CORE_ACTION_KEYS, ...LIVE_DOMAIN_KEYS]) {
      expect(keys.has(k), `schema missing metadata.${k}`).toBe(true);
    }
  });

  it("shared parse accepts every live-domain schema key (round-trip shape)", () => {
    const metadata: Record<string, unknown> = {
      lists: [],
      messages: [],
      jobs: [],
      directory: [],
      weather: { place: "תל אביב", aspects: ["summary"] },
      market: { queries: ["דולר"], aspects: ["summary"] },
      mashov: { aspects: ["grades"] },
      smartschool: { aspects: ["homework"] },
      places: {
        query: "חניון",
        place: "הקניון",
        intent: "parking",
        geo_mode: "soft_place",
        aspects: ["summary"],
      },
      jewish: { place: "תל אביב", aspects: ["candles"] },
      routes: {
        origin: "א",
        destination: "ב",
        aspects: ["summary"],
      },
      flights: { airport: "TLV", aspects: ["summary"] },
      show_dump: "tasks",
    };
    const meta = parseReplyMetadata(
      JSON.stringify({ response: "בדיקה", metadata }),
    );
    expect(meta.weather?.place).toBe("תל אביב");
    expect(meta.market?.queries?.[0]).toBe("דולר");
    expect(meta.mashov?.aspects).toContain("grades");
    expect(meta.smartschool?.aspects).toContain("homework");
    expect(meta.places?.intent).toBe("parking");
    expect(meta.places?.includedType).toBe("parking");
    expect(meta.places?.geoMode).toBe("soft_place");
    expect(meta.jewish?.place).toBe("תל אביב");
    expect(meta.routes?.aspects).toContain("summary");
    expect(meta.flights?.airport).toBe("TLV");
    expect(meta.showDump).toBe("tasks");
  });

  it("chat.service imports a resolve* path for every live domain key", () => {
    const src = chatServiceSource();
    const expectImport: Record<(typeof LIVE_DOMAIN_KEYS)[number], RegExp> = {
      weather: /resolveWeatherMessages/,
      market: /resolveMarketReply/,
      mashov: /resolveMashovReply/,
      smartschool: /resolveSmartschoolReply/,
      places: /resolvePlacesReply/,
      jewish: /resolveJewishReply/,
      routes: /resolveRoutesReply/,
      flights: /resolveFlightsReply/,
    };
    for (const key of LIVE_DOMAIN_KEYS) {
      expect(src, key).toMatch(expectImport[key]);
      expect(src, `${key} action read`).toMatch(
        new RegExp(`metadata\\.${key}\\b`),
      );
    }
  });

  it("live-domain service modules exist on disk", () => {
    for (const key of LIVE_DOMAIN_KEYS) {
      const path = resolve(REPO, `backend/src/services/${key}.ts`);
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("LLM.config ACTION CONTRACT names each live domain (structural line markers)", () => {
    const msg = configSystemMessage();
    for (const key of LIVE_DOMAIN_KEYS) {
      expect(msg, `prompt missing ${key}:`).toMatch(
        new RegExp(`(?:^|\\n)${key}:\\s`, "m"),
      );
    }
  });

  it("places intent enum aligns schema ↔ shared parking included type", () => {
    const intents = placesSchemaIntentEnum();
    expect(intents.sort()).toEqual(["business", "parking"].sort());
    expect(PLACES_INCLUDED_TYPE_ALLOWLIST).toContain("parking");
    expect(PLACES_INCLUDED_TYPE_ALLOWLIST.length).toBeGreaterThanOrEqual(5);
  });

  it("no schema-only live domain without a service file (bidirectional live set)", () => {
    const schemaKeys = new Set(actionSchemaMetadataKeys());
    const liveInSchema = LIVE_DOMAIN_KEYS.filter((k) => schemaKeys.has(k));
    expect(liveInSchema).toEqual([...LIVE_DOMAIN_KEYS]);
    for (const key of liveInSchema) {
      expect(existsSync(resolve(REPO, `backend/src/services/${key}.ts`))).toBe(
        true,
      );
    }
  });

  it("config loader responseFormat name matches action schema", () => {
    const cfg = loadLlmConfig(REPO);
    expect(cfg.responseFormat?.name).toBe("lucy_metadata_response");
  });
});
