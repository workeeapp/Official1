import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  formatDirectoryApplyNotice,
  formatSpeakerContacts,
  matchContact,
  type SpeakerContact,
} from "../src/services/contact.service.js";
import { planPhoneRelays } from "../src/services/employee-targets.service.js";
import { parseReplyMetadata } from "@workee/shared";

const contacts: SpeakerContact[] = [
  { id: "1", name: "מיכל", phone: "972541111111", kind: "personal" },
  { id: "2", name: "דני השרברב", phone: "972502222222", kind: "personal" },
];

describe("contact directory POC", () => {
  it("matches contacts by name or phone", () => {
    expect(matchContact("מיכל", contacts)?.phone).toBe("972541111111");
    expect(matchContact("054-1111111", contacts)?.name).toBe("מיכל");
    expect(matchContact("עמית", contacts)).toBeUndefined();
  });

  it("formats empty and filled speaker contacts", () => {
    expect(formatSpeakerContacts([])).toContain("No personal contacts");
    expect(formatSpeakerContacts([])).toContain("ASK «לשמור את");
    expect(formatSpeakerContacts([])).toContain("share_book");
    expect(formatSpeakerContacts(contacts)).toContain("מיכל");
  });

  it("parses directory share_book actions", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        response: "שיתפתי",
        metadata: {
          directory: [
            {
              action: "share_book",
              name: "",
              phone: "",
              targets: ["עמית"],
            },
          ],
        },
      }),
    );
    expect(meta.directory).toEqual([
      {
        action: "share_book",
        name: "",
        phone: "",
        contactId: "",
        targets: ["עמית"],
      },
    ]);
  });

  it("plans WhatsApp phone relays from a saved contact name", () => {
    const deliveries = planPhoneRelays(
      [{ targets: ["מיכל"], text: "שלום מטל" }],
      [],
      "actor",
      contacts,
    );
    expect(deliveries).toEqual([
      { phone: "972541111111", text: "שלום מטל", label: "מיכל" },
    ]);
  });

  it("parses metadata.directory actions", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        response: "שמרתי",
        metadata: {
          directory: [
            { action: "add", name: "מיכל", phone: "0541111111", contactId: "" },
          ],
        },
      }),
    );
    expect(meta.directory).toEqual([
      {
        action: "add",
        name: "מיכל",
        phone: "0541111111",
        contactId: "",
        targets: [],
      },
    ]);
  });

  it("parses optional directory description (תיאור)", () => {
    const meta = parseReplyMetadata(
      JSON.stringify({
        response: "שמרתי",
        metadata: {
          directory: [
            {
              action: "add",
              name: "מיכל",
              phone: "0541111111",
              תיאור: "שכנה מהבניין",
            },
          ],
        },
      }),
    );
    expect(meta.directory?.[0]).toMatchObject({
      action: "add",
      name: "מיכל",
      phone: "0541111111",
      description: "שכנה מהבניין",
    });
  });

  it("includes description in SPEAKER_CONTACTS JSON when present", () => {
    const text = formatSpeakerContacts([
      {
        id: "1",
        name: "מיכל",
        phone: "972541111111",
        description: "שכנה",
        kind: "personal",
      },
    ]);
    expect(text).toContain('"description":"שכנה"');
  });

  it("formats a save notice", () => {
    expect(
      formatDirectoryApplyNotice({
        saved: [contacts[0]],
        removed: [],
      }),
    ).toContain("מיכל");
  });
});
