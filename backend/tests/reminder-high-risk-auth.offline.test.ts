/**
 * Stage 6 — legacy foreign clock suppress + auth marker helpers (no DB).
 */
import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import {
  isHumanActorForeignPingClock,
  shouldSuppressLegacyForeignClock,
} from "../src/services/reminder-high-risk-auth.js";

const ACTOR: PublicEmployee = {
  id: "actor-1",
  name: "טל",
  surname: "",
  nickname: "טל",
  email: null,
  phone: "0501111111",
  kind: "human",
  isGuest: false,
  isOwner: true,
};

const OTHER: PublicEmployee = {
  id: "other-1",
  name: "עמית",
  surname: "",
  nickname: "עמית",
  email: null,
  phone: "0502222222",
  kind: "human",
  isGuest: false,
  isOwner: false,
};

const LUCY: PublicEmployee = {
  id: "lucy-1",
  name: "לוסי",
  surname: "",
  nickname: "לוסי",
  email: null,
  phone: null,
  kind: "digital",
  isGuest: false,
  isOwner: false,
};

const employees = [ACTOR, OTHER, LUCY];

describe("Stage 6 legacy foreign clock auth", () => {
  it("treats human→other-human ping as foreign", () => {
    expect(
      isHumanActorForeignPingClock({
        actorId: ACTOR.id,
        pingIds: [OTHER.id],
        employees,
      }),
    ).toBe(true);
  });

  it("treats human→external phone as foreign", () => {
    expect(
      isHumanActorForeignPingClock({
        actorId: ACTOR.id,
        pingIds: ["0509999999"],
        employees,
      }),
    ).toBe(true);
  });

  it("does not treat personal self-ping as foreign", () => {
    expect(
      isHumanActorForeignPingClock({
        actorId: ACTOR.id,
        pingIds: [ACTOR.id],
        employees,
      }),
    ).toBe(false);
  });

  it("does not treat Lucy-owned clocks as foreign", () => {
    expect(
      isHumanActorForeignPingClock({
        actorId: LUCY.id,
        pingIds: [OTHER.id],
        employees,
      }),
    ).toBe(false);
  });

  it("suppresses foreign clocks without authorization marker", () => {
    expect(
      shouldSuppressLegacyForeignClock({
        actorId: ACTOR.id,
        pingIds: [OTHER.id],
        highRiskAuthorizedAt: null,
        employees,
      }),
    ).toBe(true);
  });

  it("allows foreign clocks with authorization marker", () => {
    expect(
      shouldSuppressLegacyForeignClock({
        actorId: ACTOR.id,
        pingIds: [OTHER.id],
        highRiskAuthorizedAt: new Date("2026-11-18T09:00:00.000Z"),
        employees,
      }),
    ).toBe(false);
  });

  it("F3: stamped foreign clocks fire; unstamped stay suppressed (Gap A closed by stamp-on-allow)", () => {
    expect(
      shouldSuppressLegacyForeignClock({
        actorId: ACTOR.id,
        pingIds: [OTHER.id],
        highRiskAuthorizedAt: new Date(),
        employees,
      }),
    ).toBe(false);
    expect(
      shouldSuppressLegacyForeignClock({
        actorId: ACTOR.id,
        pingIds: [OTHER.id],
        highRiskAuthorizedAt: null,
        employees,
      }),
    ).toBe(true);
  });

  it("never suppresses personal clocks for lack of marker", () => {
    expect(
      shouldSuppressLegacyForeignClock({
        actorId: ACTOR.id,
        pingIds: [ACTOR.id],
        highRiskAuthorizedAt: null,
        employees,
      }),
    ).toBe(false);
  });
});
