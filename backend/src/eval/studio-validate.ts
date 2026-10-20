/**
 * Studio scenario validation (track-aware).
 * Pure checks only; does not read or write the published regression suite.
 */
import type { RegressionTrack } from "./corpus.js";

const SUPPORTED_TRACKS = new Set<RegressionTrack>(["ENGINE", "MODEL"]);

export class StudioScenarioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioScenarioValidationError";
  }
}

/**
 * Validate a Studio scenario (1..N turns).
 * ENGINE: requires fixtureMetadata each turn.
 * MODEL: requires constraints each turn; forbids fixtureMetadata as decision source.
 */
export function validateStudioScenario(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StudioScenarioValidationError(
      "scenario must be a non-null object",
    );
  }
  const scenario = input as Record<string, unknown>;
  const id = typeof scenario.id === "string" ? scenario.id.trim() : "";
  if (!id) {
    throw new StudioScenarioValidationError("scenario id is required");
  }

  const track = scenario.track;
  if (typeof track !== "string" || !SUPPORTED_TRACKS.has(track as RegressionTrack)) {
    throw new StudioScenarioValidationError(
      `unsupported track: ${String(track)} (supported: ENGINE, MODEL)`,
    );
  }

  if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
    throw new StudioScenarioValidationError(
      `scenario ${id}: turns required (non-empty)`,
    );
  }

  for (let i = 0; i < scenario.turns.length; i += 1) {
    const turn = scenario.turns[i];
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      throw new StudioScenarioValidationError(
        `scenario ${id} turn ${i}: turn must be an object`,
      );
    }
    const row = turn as Record<string, unknown>;
    if (typeof row.utterance !== "string") {
      throw new StudioScenarioValidationError(
        `scenario ${id} turn ${i}: utterance required`,
      );
    }

    if (track === "ENGINE") {
      if (row.fixtureMetadata === undefined || row.fixtureMetadata === null) {
        throw new StudioScenarioValidationError(
          `scenario ${id} turn ${i}: fixtureMetadata is required for ENGINE`,
        );
      }
    } else {
      // MODEL: decision source is the model reply — gold fixtures forbidden.
      if (row.fixtureMetadata !== undefined && row.fixtureMetadata !== null) {
        throw new StudioScenarioValidationError(
          `scenario ${id} turn ${i}: fixtureMetadata is forbidden on MODEL (decision source is the model output)`,
        );
      }
      if (!Array.isArray(row.constraints) || row.constraints.length === 0) {
        throw new StudioScenarioValidationError(
          `scenario ${id} turn ${i}: constraints required for MODEL`,
        );
      }
    }
  }
}
