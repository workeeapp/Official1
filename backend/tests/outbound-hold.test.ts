import { describe, expect, it } from "vitest";
import { planOutboundSends } from "../src/services/outbound-hold.js";

describe("planOutboundSends", () => {
  it("sends the metadata payloads as given", () => {
    const phones = [{ phone: "0502222222", text: "היי" }];
    expect(
      planOutboundSends({
        relays: [],
        phones,
      }),
    ).toEqual({ relays: [], phones, held: false });
  });
});
