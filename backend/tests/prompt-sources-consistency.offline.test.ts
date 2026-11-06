/**
 * Prompt source-of-truth checks.
 * Runtime instructions = LLM.config.json systemMessage (+ Lucy runtime strings in
 * chat.service.ts). LLM.action.json contributes ONLY response_format to the model;
 * its prose systemMessage is not sent. Health policy lives in LLM.config SENSITIVE;
 * other sources may only point to it, never re-state a contradicting rule.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLlmConfig } from "../src/config/llm.js";

const root = resolve(import.meta.dirname, "../..");
const config = loadLlmConfig(root);
const actionProse = (
  JSON.parse(readFileSync(resolve(root, "LLM.action.json"), "utf8")) as {
    systemMessage: string[];
  }
).systemMessage.join("\n");
const chatSource = readFileSync(
  resolve(root, "backend/src/services/chat.service.ts"),
  "utf8",
);

describe("prompt sources", () => {
  it("LLM.action.json prose is not part of the runtime system message", () => {
    expect(config.systemMessage).not.toContain(
      "You are an AI assistant that manages lists, meetings, and filing",
    );
    expect(config.responseFormat).toBeTruthy();
  });

  it("allergies / diet are never auto-filed in any source — all point to SENSITIVE", () => {
    const sources = {
      config: config.systemMessage,
      runtime: chatSource,
      actionProse,
    };
    for (const [name, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/allerg/gi)) {
        const around = text.slice(Math.max(0, m.index! - 120), m.index! + 160);
        expect(around, `${name}: ${around}`).toMatch(/SENSITIVE|consent/);
      }
    }
  });

  it("SENSITIVE is the single health rule and covers allergies + diet", () => {
    expect(config.systemMessage.match(/^• SENSITIVE \(personal health/gm)?.length).toBe(1);
    expect(config.systemMessage).toMatch(/SENSITIVE \(personal health[^)]*allergies, personal diet/);
    expect(config.systemMessage).toMatch(/unsaved, it may still inform the current conversation/);
  });

  it("non-health durable facts still auto-file in both runtime sources", () => {
    expect(config.systemMessage).toMatch(/Durable facts \(family, address form, address, job, …; health incl\. allergies \/ diet → SENSITIVE\) → filing add same turn when clearly stated/);
    expect(chatSource).toMatch(/Durable personal memory — file with lists add list_type filing in the same turn/);
  });

  it("FILE INTENT is one identical principle in both runtime sources; old auto-attach wording gone", () => {
    const sentence = (text: string) => {
      const start = text.indexOf("FILE INTENT:");
      expect(start, "FILE INTENT present").toBeGreaterThanOrEqual(0);
      const end = text.indexOf("FORBIDDEN substituting a PENDING or any other file.", start);
      expect(end, "FILE INTENT complete").toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(sentence(chatSource)).toBe(sentence(config.systemMessage));
    for (const text of [config.systemMessage, chatSource]) {
      expect(text).not.toMatch(/Deferred file after USER named a target/);
      expect(text).not.toMatch(/No save intent in this or prior USER turns/);
    }
    expect(chatSource).toMatch(/PENDING_ATTACHMENTS = recent unlinked files the speaker sent — context only, never a request \(FILE INTENT\)/);
  });

  it("PENDING_ATTACHMENTS header is context, not a request; Lucy-generated files are Lucy's", () => {
    const attachmentSource = readFileSync(
      resolve(root, "backend/src/services/attachment.service.ts"),
      "utf8",
    );
    expect(attachmentSource).not.toMatch(/Attach them with attachment_ids on the action they belong to/);
    expect(attachmentSource).toMatch(/Context only — not a request and not permission/);
    // Celebration image is uploaded by the digital worker, never the speaker.
    expect(chatSource).toMatch(/runDeleteCelebration\(\{\s*userId: input\.userId,[\s\S]{0,200}uploaderId: digital\.id,/);
    // Send path may deliver digital-worker files; attach path may not.
    expect(attachmentSource).toMatch(/purpose === "send" && row\.uploader\?\.kind === "digital"/);
    const whatsappSource = readFileSync(
      resolve(root, "backend/src/services/whatsapp.service.ts"),
      "utf8",
    );
    expect(whatsappSource).toMatch(/turn\.outboundAttachmentIds,\s*"send",/);
  });

  it("LIST NAME MATCH: one definition (by meaning: unique → act, several/none → ask); others only reference it", () => {
    const defs = [...chatSource.matchAll(/LIST NAME MATCH \(custom/g)];
    expect(defs).toHaveLength(1);
    const start = defs[0]!.index!;
    const def = chatSource.slice(start, chatSource.indexOf("\n", start));
    expect(def).toMatch(/Match by MEANING/);
    expect(def).toMatch(/ONE clearly matching list → mutate NOW, no confirm/);
    expect(def).toMatch(/TWO OR MORE plausible lists[^]*ASK which/);
    expect(def).toMatch(/No sufficiently clear match → lists=\[\] and ASK/);
    for (const text of [chatSource, config.systemMessage]) {
      expect(text).not.toMatch(/VERY SIMILAR|very similar one|similar → confirm/i);
    }
    expect(config.systemMessage).not.toMatch(/LIST NAME MATCH \(/);
    expect(config.systemMessage).toContain("Which list → LIST NAME MATCH");
  });

  it("Q1: instructions are assembled only by buildLucyInstructions (server + every eval runner)", () => {
    const evalSource = readFileSync(
      resolve(root, "backend/src/eval/eval-prompt-source.ts"),
      "utf8",
    );
    const batchSource = readFileSync(resolve(root, "backend/src/eval/run-batch-a.ts"), "utf8");
    // One definition, one production call site.
    expect(chatSource.match(/export function buildLucyInstructions\(/g)).toHaveLength(1);
    const send = chatSource.slice(chatSource.indexOf("export async function sendChatMessage("));
    expect(send.match(/buildLucyInstructions\(\{/g)).toHaveLength(1);
    // No second assembly of the system message + RESPONSES_RULE anywhere.
    expect(chatSource.match(/config\.systemMessage,\s*RESPONSES_RULE,/g)).toHaveLength(2); // attach + thin branch, inside the builder
    expect(chatSource).not.toContain("buildLucyModelEvalInstructions");
    expect(evalSource).toContain("helpers.buildLucyInstructions(");
    expect(evalSource).not.toContain("RESPONSES_RULE");
    expect(batchSource).toContain("buildLucyInstructions(");
  });
});
