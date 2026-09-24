import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDavidConfig, loadLlmConfig, loadLlmResponseFormat } from "../src/config/llm.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("LLM action schema", () => {
  it("loads Lucy json_schema from LLM.action.json", () => {
    const format = loadLlmResponseFormat(repoRoot);

    expect(format).toMatchObject({
      type: "json_schema",
      name: "lucy_metadata_response",
      strict: false,
    });
    expect(format?.schema.required).toEqual(["response", "metadata"]);
    expect(format?.schema.properties).toMatchObject({
      response: { type: "string" },
      metadata: { type: "object" },
    });
  });

  it("attaches the schema when loading Lucy config", () => {
    const config = loadLlmConfig(repoRoot);

    expect(config.responseFormat?.name).toBe("lucy_metadata_response");
    expect(config.systemMessage).toContain("metadata");
  });

  it("loads David reminder rules without changing Lucy config", () => {
    const lucy = loadLlmConfig(repoRoot);
    const david = loadDavidConfig(repoRoot);

    expect(david?.systemMessage).toContain("CLOCK");
    expect(david?.systemMessage).toContain("in");
    expect(david?.systemMessage).toContain("phone numbers");
    expect(david?.systemMessage).toContain("CONFIRM BEFORE CHANGE OR DELETE");
    expect(david?.systemMessage).toContain("metadata.query");
    expect(lucy.systemMessage).not.toContain("LLM.david");
    expect(lucy.systemMessage).toContain("דוד");
    expect(lucy.systemMessage).toContain("metadata.query");
  });
});
