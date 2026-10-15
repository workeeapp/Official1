import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderChatText } from "./formatChatText";

describe("renderChatText", () => {
  it("bolds a guillemet line and keeps the urgent mark after it", () => {
    render(<span>{renderChatText("«1. לשתות מים» ‼️")}</span>);

    const line = screen.getByText("1. לשתות מים");
    expect(line.tagName).toBe("STRONG");
    expect(line.parentElement).toHaveTextContent("1. לשתות מים ‼️");
    expect(line.parentElement?.textContent).not.toContain("«");
    expect(line.parentElement?.textContent).not.toContain("»");
  });

  it("leaves a line without guillemets unchanged", () => {
    render(<span>{renderChatText("1. לחם")}</span>);

    expect(screen.getByText("1. לחם").tagName).not.toBe("STRONG");
  });
});
