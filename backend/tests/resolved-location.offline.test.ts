import { describe, expect, it } from "vitest";
import {
  ASK_FOR_WHATSAPP_PIN_MARKER,
  fromActionCoords,
  fromPendingLocation,
  isValidViewport,
  parseCoordinatePair,
  replyAsksForWhatsAppPin,
  shouldClearPendingAfterSpeakerPinUse,
} from "../src/services/resolved-location.js";
import type { PendingLocation } from "../src/services/pending-location.js";

describe("resolved-location", () => {
  it("isValidViewport rejects inverted low/high (B2a)", () => {
    expect(
      isValidViewport({
        low: { lat: 32.0, lng: 34.7 },
        high: { lat: 32.4, lng: 35.1 },
      }),
    ).toBe(true);
    expect(
      isValidViewport({
        low: { lat: 32.4, lng: 34.7 },
        high: { lat: 32.0, lng: 35.1 },
      }),
    ).toBe(false);
  });

  it("accepts in-range coords and rejects malformed / out-of-range", () => {
    expect(parseCoordinatePair(32.08, 34.78)).toEqual({
      lat: 32.08,
      lng: 34.78,
    });
    expect(parseCoordinatePair(91, 34)).toBeNull();
    expect(parseCoordinatePair(32, 181)).toBeNull();
    expect(parseCoordinatePair(NaN, 34)).toBeNull();
    expect(parseCoordinatePair(32, Infinity)).toBeNull();
  });

  it("fromPendingLocation keeps name/address and neutral label fallback", () => {
    const withName: PendingLocation = {
      lat: 32.1,
      lng: 34.8,
      name: "קפה",
      address: "רחוב 1",
      at: Date.now(),
    };
    expect(fromPendingLocation(withName)?.label).toBe("קפה");
    expect(fromPendingLocation(withName)?.source).toBe("whatsapp_pin");

    const bare: PendingLocation = {
      lat: 32.1,
      lng: 34.8,
      name: "",
      address: "",
      at: Date.now(),
    };
    expect(fromPendingLocation(bare)?.label).toBe("המיקום שלך");
    expect(fromActionCoords(32, 34)?.source).toBe("action_coords");
  });

  it("clear guard: used pin clears; ask-for-pin and named-place do not", () => {
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: true,
        needsLocation: false,
      }),
    ).toBe(true);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: true,
        needsLocation: true,
      }),
    ).toBe(false);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: false,
      }),
    ).toBe(false);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: true,
        replyText: `${ASK_FOR_WHATSAPP_PIN_MARKER} (סיכת מיקום)`,
      }),
    ).toBe(false);
    expect(
      replyAsksForWhatsAppPin(
        "שלח מיקום בוואטסאפ (סיכת מיקום) ואחפש באזור שלך.",
      ),
    ).toBe(true);
  });
});
