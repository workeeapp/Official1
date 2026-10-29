import { describe, expect, it } from "vitest";
import type { EmployeeRecordSnapshot } from "../src/services/employee-records.service.js";
import {
  ASK_FOR_WHATSAPP_PIN_MARKER,
  fromActionCoords,
  fromPendingLocation,
  fromSavedCoords,
  isValidViewport,
  parseCoordinatePair,
  replyAsksForWhatsAppPin,
  resolveActionLocation,
  shouldClearPendingAfterSpeakerPinUse,
} from "../src/services/resolved-location.js";
import type { PendingLocation } from "../src/services/pending-location.js";

const HOME_LAT = 32.099279;
const HOME_LNG = 34.8923104;
const PIN_LAT = 31.5;
const PIN_LNG = 34.5;

function snapshotWithHome(
  itemInfo: string,
): Pick<EmployeeRecordSnapshot, "lists" | "filing"> {
  return {
    filing: [
      {
        filing_id: "f-home",
        item_name: "מיקום הבית",
        item_info: itemInfo,
        item_description: "",
        owner: "טל",
        scope: "personal",
      },
    ],
    lists: [],
  };
}

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

describe("resolveActionLocation", () => {
  const pending: PendingLocation = {
    lat: PIN_LAT,
    lng: PIN_LNG,
    name: "סיכה",
    address: "",
    at: Date.now(),
  };

  it("saved home wins over pending pin when place is set", () => {
    const hit = resolveActionLocation({
      place: "מיקום הבית",
      nearSpeaker: true,
      pending,
      snapshot: snapshotWithHome(`${HOME_LAT}, ${HOME_LNG}`),
    });
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.usedPendingPin).toBe(false);
    expect(hit.location.source).toBe("saved");
    expect(hit.location.lat).toBeCloseTo(HOME_LAT);
    expect(hit.location.lng).toBeCloseTo(HOME_LNG);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: hit.usedPendingPin,
      }),
    ).toBe(false);
  });

  it("near=speaker with empty place uses pending pin", () => {
    const hit = resolveActionLocation({
      place: "",
      nearSpeaker: true,
      pending,
      snapshot: snapshotWithHome(`${HOME_LAT}, ${HOME_LNG}`),
    });
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.usedPendingPin).toBe(true);
    expect(hit.location.source).toBe("whatsapp_pin");
    expect(hit.location.lat).toBeCloseTo(PIN_LAT);
    expect(
      shouldClearPendingAfterSpeakerPinUse({
        usedPendingPin: hit.usedPendingPin,
        needsLocation: false,
      }),
    ).toBe(true);
  });

  it("near=speaker without pending → need_pin", () => {
    expect(
      resolveActionLocation({
        place: "",
        nearSpeaker: true,
        pending: null,
        snapshot: snapshotWithHome(`${HOME_LAT}, ${HOME_LNG}`),
      }).kind,
    ).toBe("need_pin");
  });

  it("named city with no saved match → none (geocode path)", () => {
    expect(
      resolveActionLocation({
        place: "תל אביב",
        nearSpeaker: false,
        pending,
        snapshot: snapshotWithHome(`${HOME_LAT}, ${HOME_LNG}`),
      }).kind,
    ).toBe("none");
  });

  it("address-like filing without coords → label_without_coords (no fabricate)", () => {
    const result = resolveActionLocation({
      place: "מיקום הבית",
      nearSpeaker: false,
      pending,
      snapshot: snapshotWithHome("הרצל 1 תל אביב"),
    });
    expect(result.kind).toBe("label_without_coords");
    if (result.kind !== "label_without_coords") return;
    expect(result.askText).toMatch(/אין קואורדינטות/);
  });

  it("ambiguous soft match among saved coords → ask", () => {
    const snapshot: Pick<EmployeeRecordSnapshot, "lists" | "filing"> = {
      filing: [
        {
          filing_id: "f1",
          item_name: "מיקום הבית",
          item_info: `${HOME_LAT}, ${HOME_LNG}`,
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
        {
          filing_id: "f2",
          item_name: "בית הורים",
          item_info: "32.05, 34.75",
          item_description: "",
          owner: "טל",
          scope: "personal",
        },
      ],
      lists: [],
    };
    const result = resolveActionLocation({
      place: "בית",
      nearSpeaker: false,
      pending: null,
      snapshot,
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("fromSavedCoords sets source saved", () => {
    expect(fromSavedCoords(HOME_LAT, HOME_LNG, "מיקום הבית")?.source).toBe(
      "saved",
    );
  });
});
