import { describe, expect, it } from "vitest";
import {
  GENERAL_TIP_MIN_INTERVAL_MINUTES,
  SYSTEM_TIP_SEEDS,
} from "../src/services/tip-catalog.js";

const GENERAL_LIVE_KEYS = [
  "general_weather",
  "general_market",
  "general_places",
  "general_routes",
  "general_parking",
  "general_filing_media_ask",
  "general_location_waze",
  "general_mashov",
  "general_smartschool",
  "general_watch",
] as const;

describe("general live tip catalog seeds", () => {
  const generals = SYSTEM_TIP_SEEDS.filter((s) => s.triggerKind === "general");

  it("includes the live/capability general tips with stable keys", () => {
    const keys = generals.map((s) => s.key);
    for (const key of GENERAL_LIVE_KEYS) {
      expect(keys).toContain(key);
    }
    expect(generals).toHaveLength(GENERAL_LIVE_KEYS.length);
    expect(GENERAL_TIP_MIN_INTERVAL_MINUTES).toBe(360);
  });

  it("keeps general tips non-contextual (no area/op/list ladder)", () => {
    for (const tip of generals) {
      expect(tip.audience).toBe("member");
      expect(tip.for).toBe("lucy");
      expect(tip.triggerArea).toBeNull();
      expect(tip.triggerOp).toBeNull();
      expect(tip.topic).toBeNull();
      expect(tip.listType).toBeNull();
      expect(tip.unlockAfterKey).toBeNull();
      expect(tip.maxShows).toBeLessThanOrEqual(2);
      expect(tip.text.trim().length).toBeGreaterThan(10);
      expect(tip.text).toMatch(/[\u0590-\u05FF]/);
      expect(tip.text).not.toMatch(/^אגב,/);
      expect(tip.text).not.toMatch(/metadata\.|show_dump|compose_condition/);
      // Exactly one emoji mark (not a feature-catalog wall of icons).
      expect(
        [...tip.text].filter((ch) => /\p{Extended_Pictographic}/u.test(ch))
          .length,
      ).toBe(1);
    }
  });

  it("does not duplicate legacy fill-member general keys wiped on reseed", () => {
    const keys = new Set(SYSTEM_TIP_SEEDS.map((s) => s.key));
    expect(keys.has("general_lists")).toBe(false);
    expect(keys.has("general_reminders")).toBe(false);
  });

  it("wording stays capability-honest for media ask and watch", () => {
    const media = generals.find((s) => s.key === "general_filing_media_ask");
    expect(media?.text).toContain("לתייק");
    expect(media?.text).toContain("לפי השם");
    expect(media?.text).toContain("📎");
    expect(media?.text).not.toMatch(/פענח|OCR|מערכת שעות/);

    const watch = generals.find((s) => s.key === "general_watch");
    expect(watch?.text).toMatch(/תנאי/);
    expect(watch?.text).toMatch(/שער/);
    expect(watch?.text).toContain("🔔");
  });
});
