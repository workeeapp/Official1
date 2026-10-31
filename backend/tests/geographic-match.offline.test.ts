/**
 * Stage 1: GeographicMatch contract + UX Gate (no domain provider execution).
 */
import { describe, expect, it, vi } from "vitest";
import {
  geographicAmbiguous,
  geographicNeedsClarify,
  geographicResolvedPoint,
  geographicResolvedRegion,
  geographicUnsupportedForConsumer,
  matchAllowsRepresentativePoint,
  provenanceFromAreaSource,
} from "../src/services/geographic-match.js";
import {
  formatGeographicAreaFailureForUser,
  isTechnicalAreaPolicyMessage,
  speakGeographicAreaFailure,
  speakGeographicMatchForUser,
} from "../src/services/geo-area-user-copy.js";
import { parseLlmReply } from "@workee/shared";
import { resolvePlacesReplyDetailed } from "../src/services/places.js";
import { applyLiveDomainReply } from "../src/services/whatsapp-send.js";

describe("GeographicMatch contract", () => {
  const ask = {
    rawText: "הגליל",
    role: "place" as const,
    consumerHint: "weather" as const,
  };

  it("resolved region keeps kind=region when representativePoint is set", () => {
    const match = geographicResolvedRegion({
      asked: ask,
      labelHe: "הגליל",
      provenance: "google_geocode",
      viewport: {
        low: { lat: 32.7, lng: 35.1 },
        high: { lat: 33.1, lng: 35.6 },
      },
      representativePoint: {
        lat: 32.9,
        lng: 35.35,
        justified: true,
        maxSpanDeg: 0.5,
      },
    });
    expect(match.status).toBe("resolved");
    expect(match.kind).toBe("region");
    expect(match.representativePoint?.justified).toBe(true);
    expect(matchAllowsRepresentativePoint(match)).toBe(true);
    expect(match.geometry?.viewport).toBeTruthy();
  });

  it("rejects unjustified representativePoint on region builder", () => {
    expect(() =>
      geographicResolvedRegion({
        asked: ask,
        labelHe: "הגליל",
        provenance: "google_geocode",
        representativePoint: {
          lat: 32.9,
          lng: 35.35,
          justified: false,
        },
      }),
    ).toThrow(/justified/);
  });

  it("resolved point never carries representativePoint / stays non-region", () => {
    const match = geographicResolvedPoint({
      asked: { rawText: "צפת", role: "place" },
      kind: "city",
      labelHe: "צפת",
      provenance: "open_meteo",
      point: { lat: 32.96, lng: 35.5 },
    });
    expect(match.kind).toBe("city");
    expect(match.representativePoint).toBeUndefined();
    expect(matchAllowsRepresentativePoint(match)).toBe(false);
  });

  it("needs_clarify / ambiguous / unsupported are structured (no invented geometry)", () => {
    const clarify = geographicNeedsClarify({
      asked: ask,
      kind: "region",
      userAskHe: "באיזו עיר בגליל לבדוק?",
      policyTrace: "מצאתי יחידה מינהלית צרה ל«רמת הגולן».",
    });
    expect(clarify.status).toBe("needs_clarify");
    expect(clarify.geometry).toBeUndefined();
    expect(clarify.policyTrace).toContain("יחידה מינהלית");

    const amb = geographicAmbiguous({
      asked: ask,
      candidates: [
        { label: "גליל עליון", kind: "region", confidence: "medium" },
        { label: "גליל תחתון", kind: "region", confidence: "medium" },
      ],
      userAskHe: "לאיזה חלק בגליל התכוונת?",
    });
    expect(amb.status).toBe("ambiguous");
    expect(amb.candidates).toHaveLength(2);

    const unsupported = geographicUnsupportedForConsumer({
      asked: { ...ask, consumerHint: "routes" },
      kind: "region",
      userAskHe: "לאיזו עיר בגליל לתכנן את המסלול?",
    });
    expect(unsupported.status).toBe("unsupported_for_consumer");
  });

  it("maps area sources to provenance (extensible for news/events later)", () => {
    expect(provenanceFromAreaSource("geo_area_index")).toBe("geo_area_index");
    expect(provenanceFromAreaSource("geocode_viewport")).toBe("google_geocode");
  });
});

describe("Geographic UX Gate", () => {
  it("flags technical policy jargon", () => {
    expect(
      isTechnicalAreaPolicyMessage(
        "מצאתי יחידה מינהלית צרה ל«רמת הגולן». אם זה האזור שרצית — ציין את שמו המלא; אחרת נסח מחדש.",
      ),
    ).toBe(true);
    expect(isTechnicalAreaPolicyMessage("narrow_admin")).toBe(true);
    expect(
      isTechnicalAreaPolicyMessage("לא זיהיתי את האזור «הגליל». אפשר לנסח מחדש?"),
    ).toBe(false);
  });

  it("never returns יחידה מינהלית / narrow_admin to the user", () => {
    const text = speakGeographicAreaFailure({
      place: "רמת הגולן",
      kind: "invalid",
      policyMessageHe:
        "מצאתי יחידה מינהלית צרה ל«רמת הגולן». אם זה האזור שרצית — ציין את שמו המלא; אחרת נסח מחדש.",
    });
    expect(text).not.toMatch(/יחידה מינהלית|narrow_admin|admin_narrow/i);
    expect(text).toMatch(/עיר|אזור/);
  });

  it("speakGeographicMatchForUser prefers safe userAskHe and logs policyTrace", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const match = geographicNeedsClarify({
      asked: { rawText: "הגליל", role: "area" },
      kind: "region",
      userAskHe: "באיזו עיר בגליל לחפש?",
      policyTrace: "מצאתי יחידה מינהלית צרה ל«הגליל».",
    });
    const spoken = speakGeographicMatchForUser(match);
    expect(spoken).toBe("באיזו עיר בגליל לחפש?");
    expect(spoken).not.toMatch(/יחידה מינהלית/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("formatGeographicAreaFailureForUser: ambiguous vs none", () => {
    expect(
      formatGeographicAreaFailureForUser({
        place: "השרון",
        kind: "ambiguous",
      }),
    ).toMatch(/כמה אפשרויות/);
    expect(
      formatGeographicAreaFailureForUser({
        place: "xyzzy",
        kind: "none",
        policyMessageHe: "מצאתי יחידה מינהלית צרה ל«xyzzy».",
      }),
    ).not.toMatch(/יחידה מינהלית/);
  });
});

describe("UX Gate orchestration (Places area fail — no provider search)", () => {
  it("area_restrict reject policy → natural text; ack stays a separate bubble", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Places search must not run on area resolve failure");
    });
    const result = await resolvePlacesReplyDetailed({
      query: "מסעדות",
      place: "רמת הגולן",
      areaRestrict: true,
      aspects: ["summary"],
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveArea: async () => ({
        ok: false as const,
        kind: "invalid" as const,
        messageHe:
          "מצאתי יחידה מינהלית צרה ל«רמת הגולן». אם זה האזור שרצית — ציין את שמו המלא; אחרת נסח מחדש.",
      }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.needsLocation).toBe(true);
    expect(result.text).not.toMatch(/יחידה מינהלית|narrow_admin/i);
    expect(result.text).toMatch(/עיר|אזור/);

    const stub = JSON.stringify({
      responses: ["אוקיי"],
      metadata: {},
    });
    const merged = applyLiveDomainReply(stub, result.text);
    const spoken = parseLlmReply(merged).responses;
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toBe("אוקיי");
    expect(spoken[1]).toBe(result.text);
    // Engine keeps ack and live body as separate bubbles (not one glued string).
    expect(spoken[0]).not.toContain(result.text.slice(0, 12));
  });
});
