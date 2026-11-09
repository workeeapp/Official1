import { afterAll, describe, expect, it } from "vitest";
import {
  browserClick,
  browserExtract,
  browserNavigate,
  browserObserve,
  browserPress,
  browserSelect,
  browserType,
  cleanZapCardText,
  clearBrowserSession,
  shutdownMissionBrowsers,
} from "../src/services/mission-tools/browser.js";

const ctx = {
  userId: "00000000-0000-4000-8000-000000000001",
  speakerId: "00000000-0000-4000-8000-000000000002",
  orchestratorId: "00000000-0000-4000-8000-000000000003",
  executorId: "00000000-0000-4000-8000-000000000004",
  missionId: "00000000-0000-4000-8000-000000000099",
};

afterAll(async () => {
  await clearBrowserSession(ctx.missionId);
  await shutdownMissionBrowsers();
});

describe("cleanZapCardText", () => {
  it("keeps name and first price", () => {
    expect(
      cleanZapCardText(
        "הזול ביותר Xiaomi Electric Scooter 4 Lite - קורקינט חשמלי שיאומי 4 לייט הוספת חוות דעת 899 ₪ משלוח חינם עד 7 ימי עסקים ב-Xi-Mobility",
      ),
    ).toBe("Xiaomi Electric Scooter 4 Lite - קורקינט חשמלי שיאומי 4 לייט — 899 ₪");
  });
});

describe("mission playwright browser tools", () => {
  it("extracts Zap card-v2 / model-row-v2 product lines", async () => {
    // Use NIS (not ₪) — data: URLs can mojibake the shekel glyph in Playwright.
    const html = Buffer.from(
      `<!doctype html><html><body>
  <div id="divSearchResults">
    <div class="model-row-v2">Best Xiaomi Electric Scooter 4 Lite review 899 NIS free ship</div>
    <div class="model-row-v2">Xiaomi Electric Scooter 6 review 2,002 NIS with ship</div>
    <div class="model-row-v2">RIDER X RACE MINI review 2,619 NIS at store</div>
  </div>
</body></html>`,
      "utf8",
    ).toString("base64");
    const nav = await browserNavigate(
      { url: `data:text/html;base64,${html}` },
      ctx,
    );
    expect(nav.ok).toBe(true);
    const extracted = await browserExtract(
      { aspect: "search_results" },
      ctx,
    );
    expect(extracted.ok).toBe(true);
    const products = Array.isArray(extracted.data?.products)
      ? (extracted.data?.products as string[])
      : [];
    const text =
      products.length > 0
        ? products.join("\n")
        : String(extracted.data?.text ?? "");
    expect(extracted.data?.source).toBe("zap");
    expect(text).toMatch(/1\.\s+.*899/);
    expect(text).toMatch(/2\.\s+.*2,002/);
    expect(text).toMatch(/3\.\s+.*2,619/);
    expect(text).not.toContain("שלום אורח");
  }, 60_000);

  it("navigates, types, clicks, and extracts on a data page", async () => {
    const html = encodeURIComponent(`<!doctype html>
<html><body>
  <h1 id="title">Hello Mission</h1>
  <input id="name" />
  <button id="go">Go</button>
  <p id="out"></p>
  <script>
    document.getElementById('go').onclick = () => {
      document.getElementById('out').textContent =
        'Hi ' + document.getElementById('name').value;
    };
  </script>
</body></html>`);
    const nav = await browserNavigate(
      { url: `data:text/html,${html}` },
      ctx,
    );
    expect(nav.ok).toBe(true);
    expect(nav.summary).toContain("Opened");

    const typed = await browserType(
      { selector: "#name", text: "Amit" },
      ctx,
    );
    expect(typed.ok).toBe(true);

    const clicked = await browserClick({ selector: "#go" }, ctx);
    expect(clicked.ok).toBe(true);

    const extracted = await browserExtract(
      { selector: "#out", aspect: "greeting" },
      ctx,
    );
    expect(extracted.ok).toBe(true);
    expect(String(extracted.data?.text ?? "")).toContain("Hi Amit");
  }, 60_000);

  it("observes controls, clicks by role+name, selects, and presses Enter", async () => {
    const html = Buffer.from(
      `<!doctype html>
<html><body>
  <h1>Dig page</h1>
  <a href="#cats">Categories</a>
  <button type="button" id="open">Open list</button>
  <label>Product <select id="prod" aria-label="Product">
    <option value="">—</option>
    <option value="mixer">Mixer</option>
    <option value="scooter">Scooter</option>
  </select></label>
  <input id="qty" aria-label="Quantity" value="1" />
  <p id="out"></p>
  <script>
    document.getElementById('open').onclick = () => {
      document.getElementById('out').textContent = 'opened';
    };
    document.getElementById('qty').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = document.getElementById('prod').value;
        document.getElementById('out').textContent = 'ok:' + v;
      }
    });
  </script>
</body></html>`,
      "utf8",
    ).toString("base64");
    const nav = await browserNavigate(
      { url: `data:text/html;base64,${html}` },
      ctx,
    );
    expect(nav.ok).toBe(true);
    expect(Array.isArray(nav.data?.controls_preview)).toBe(true);

    const observed = await browserObserve({}, ctx);
    expect(observed.ok).toBe(true);
    const controls = (observed.data?.controls ?? []) as Array<{
      role: string;
      name: string;
    }>;
    expect(
      controls.some((c) => c.role === "button" && /Open list/i.test(c.name)),
    ).toBe(true);
    expect(controls.some((c) => c.role === "link")).toBe(true);

    const clicked = await browserClick(
      { role: "button", name: "Open list" },
      ctx,
    );
    expect(clicked.ok).toBe(true);
    expect(String(clicked.data?.text_sample ?? "")).toContain("opened");

    const selected = await browserSelect(
      { selector: "#prod", value: "Mixer" },
      ctx,
    );
    expect(selected.ok).toBe(true);

    const pressed = await browserPress(
      { selector: "#qty", key: "Enter" },
      ctx,
    );
    expect(pressed.ok).toBe(true);

    const extracted = await browserExtract(
      { selector: "#out", aspect: "result" },
      ctx,
    );
    expect(extracted.ok).toBe(true);
    expect(String(extracted.data?.text ?? "")).toContain("ok:mixer");
  }, 60_000);
});
