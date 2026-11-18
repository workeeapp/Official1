/**
 * LIVE MODEL QA — Lucy Hebrew VOICE naturalness / repetition (+ optional A/B).
 *
 * Real sendChatMessage on disposable workee_test accounts. Seeds each Lucy
 * row explicitly (file or git commit systemMessage). Does not change VOICE,
 * temperature, or production behavior. Uniqueness is reported, not gated.
 *
 *   VOICE_NATURALNESS_LIVE=1 npm run test:voice-naturalness -w backend
 *   VOICE_NATURALNESS_AB=1   npm run test:voice-naturalness -w backend
 *   Optional: VOICE_NATURALNESS_AB_SEED=<int> for reproducible shuffle
 *
 * Requires approved workee_test URL, WORKEE_DISABLE_WHATSAPP_OUTBOUND=1,
 * WORKEE_DISABLE_REMINDER_FIRE=1, OPENAI_API_KEY.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runVoiceNaturalnessAbComparison,
  runVoiceNaturalnessSuite,
  writeVoiceNaturalnessAbReports,
  writeVoiceNaturalnessReports,
  VOICE_AB_BASELINE_SHA16,
  VOICE_AB_CURRENT_SHA16,
} from "../src/eval/voice-naturalness.js";
import { assertApprovedEvalDatabaseUrl } from "../src/eval/studio-db-guard.js";
import * as reminderFire from "../src/services/reminder-fire.js";
import * as whatsappSend from "../src/services/whatsapp-send.js";
import { injectProductEnvKey } from "./helpers/eval-live-provider-harness.js";

describe("LIVE MODEL QA: VOICE naturalness / repetition", () => {
  beforeAll(() => {
    injectProductEnvKey("OPENAI_API_KEY");
    vi.spyOn(whatsappSend, "sendWhatsAppText").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppButtons").mockResolvedValue("sent");
    vi.spyOn(whatsappSend, "sendWhatsAppMedia").mockResolvedValue("sent");
    vi.spyOn(reminderFire, "fireDueReminders").mockResolvedValue(0);
    vi.spyOn(reminderFire, "scheduleSoon").mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it.skipIf(process.env.VOICE_NATURALNESS_LIVE !== "1")(
    "runs naturalness scenarios and writes the report",
    async () => {
      assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
      expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
      expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
      expect(process.env.OPENAI_API_KEY?.trim().length ?? 0).toBeGreaterThan(0);

      const report = await runVoiceNaturalnessSuite({ repeats: 10 });
      const paths = writeVoiceNaturalnessReports(report);

      console.info(
        `[voice-naturalness] report ${paths.mdPath} hardOk=${report.hardOk} sha16=${report.prompt.instructionsSha16}`,
      );
      for (const sc of report.scenarios) {
        console.info(
          `[voice-naturalness] ${sc.scenarioId}: exact=${sc.exactUnique}/${sc.n} near=${sc.nearUnique}/${sc.n} openings=${sc.distinctOpenings} emoji=${(sc.emojiRate * 100).toFixed(0)}% closers=${sc.helpCloserHits}`,
        );
      }

      expect(report.prompt.hasSituationalVoice).toBe(true);
      expect(report.scenarios).toHaveLength(4);
      for (const sc of report.scenarios) {
        expect(sc.n).toBe(10);
        expect(sc.responses).toHaveLength(10);
      }
      // Hard gates only: empty replies / help-closers / unexpected personal-share saves.
      // Duplicate rates are informational — never fail the suite for low uniqueness.
      expect(report.hardOk, report.hardFailures.join("\n") || "hard failures").toBe(
        true,
      );
    },
    900_000,
  );

  it.skipIf(process.env.VOICE_NATURALNESS_AB !== "1")(
    "runs baseline vs current VOICE A/B comparison and writes the report",
    async () => {
      assertApprovedEvalDatabaseUrl(process.env.DATABASE_URL);
      expect(process.env.WORKEE_DISABLE_WHATSAPP_OUTBOUND).toBe("1");
      expect(process.env.WORKEE_DISABLE_REMINDER_FIRE).toBe("1");
      expect(process.env.OPENAI_API_KEY?.trim().length ?? 0).toBeGreaterThan(0);

      const report = await runVoiceNaturalnessAbComparison({ repeats: 10 });
      const paths = writeVoiceNaturalnessAbReports(report);

      console.info(
        `[voice-naturalness-ab] report ${paths.mdPath} recommendation=${report.overall.recommendation} seed=${report.config.shuffleSeed}`,
      );
      console.info(`[voice-naturalness-ab] ${report.overall.summary}`);
      for (const sc of report.scenarios) {
        console.info(
          `[voice-naturalness-ab] ${sc.scenarioId}: base exact=${sc.baseline.exactUnique}/${sc.baseline.n} cur exact=${sc.current.exactUnique}/${sc.current.n} closers ${sc.baseline.helpCloserHits}->${sc.current.helpCloserHits}`,
        );
      }

      expect(report.arms.baseline.instructionsSha16).toBe(VOICE_AB_BASELINE_SHA16);
      expect(report.arms.current.instructionsSha16).toBe(VOICE_AB_CURRENT_SHA16);
      expect(report.arms.current.hasSituationalVoice).toBe(true);
      expect(report.arms.baseline.hasSituationalVoice).toBe(false);
      expect(report.scenarios).toHaveLength(4);
      expect(report.baselineReport.hardOk).toBe(true);
      expect(report.currentReport.hardOk).toBe(true);
      expect(report.overall.regressions).toEqual([]);
    },
    1_800_000,
  );
});
