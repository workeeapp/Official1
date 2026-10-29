/**
 * Offline prompt alignment: DESTINATION LADDER path (D) contacts +
 * THIS-TURN DESTINATION WINS (no engine utterance regex).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");
const actionPath = resolve(root, "LLM.action.json");
const configPath = resolve(root, "LLM.config.json");
const chatPath = resolve(process.cwd(), "src/services/chat.service.ts");
const contactPath = resolve(process.cwd(), "src/services/contact.service.ts");

describe("attachment DESTINATION LADDER path D + THIS-turn wins", () => {
  const action = readFileSync(actionPath, "utf8");
  const config = readFileSync(configPath, "utf8");
  const chat = readFileSync(chatPath, "utf8");
  const contact = readFileSync(contactPath, "utf8");

  it("LLM.action.json teaches four destinations including phone-book (D)", () => {
    expect(action).toMatch(
      /DESTINATION LADDER[\s\S]*?Four destinations:[\s\S]*?\(D\) Phone-book contact/,
    );
    expect(action).toMatch(
      /DESTINATION LADDER[\s\S]*?directory\.update with contact_id[\s\S]*?SPEAKER_CONTACTS/,
    );
    expect(action).toMatch(
      /THIS-TURN DESTINATION WINS:[\s\S]*?FORBIDDEN completing a deferred attach to a prior USER target/,
    );
    expect(action).toMatch(
      /שמרי לאיש קשר ניר[\s\S]*?directory\.update for ניר only/,
    );
    expect(action).not.toMatch(
      /DESTINATION LADDER[\s\S]*?Three destinations:/,
    );
  });

  it("LLM.config.json DESTINATION LADDER matches path D + THIS-turn wins", () => {
    expect(config).toMatch(
      /DESTINATION LADDER[\s\S]*?Four destinations[\s\S]*?\(D\) phone-book contact/,
    );
    expect(config).toMatch(
      /THIS-TURN DESTINATION WINS:[\s\S]*?FORBIDDEN re-emitting prior row attachment_ids/,
    );
  });

  it("runtime ATTACHMENTS_RULE includes directory and path D", () => {
    expect(chat).toMatch(
      /ATTACHMENTS:[\s\S]*?directory add\|update attachment_ids \(phone-book contact\)/,
    );
    expect(chat).toMatch(
      /ATTACHMENTS:[\s\S]*?\(D\) phone-book contact[\s\S]*?THIS-TURN DESTINATION WINS/,
    );
  });

  it("SHARED_CONTACT_RULES teach contact attach without list re-home", () => {
    expect(contact).toMatch(
      /ATTACH FILES TO A CONTACT:[\s\S]*?directory\.update contact_id \+ attachment_ids/,
    );
    expect(contact).toMatch(
      /ATTACH FILES TO A CONTACT:[\s\S]*?THIS-TURN DESTINATION WINS/,
    );
  });
});
