import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import {
  applyAttachmentLinks,
  ingestUploadedBytes,
} from "../attachment.service.js";
import type { MissionToolContext, MissionToolResult } from "./types.js";

type MissionBrowserSession = {
  context: BrowserContext;
  page: Page;
  lastAction: string;
};

export type ObservedControl = {
  role: string;
  name: string;
  disabled?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 45_000;
const WAIT_CAP_MS = 15_000;
const CONTROLS_PREVIEW_LIMIT = 15;
const OBSERVE_LIMIT = 40;

let sharedBrowser: Browser | null = null;
const sessions = new Map<string, MissionBrowserSession>();

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser;
  }
  sharedBrowser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  sharedBrowser.on("disconnected", () => {
    sharedBrowser = null;
  });
  return sharedBrowser;
}

async function sessionFor(
  missionId: string,
): Promise<MissionBrowserSession> {
  const existing = sessions.get(missionId);
  if (existing && !existing.page.isClosed()) {
    return existing;
  }
  if (existing) {
    sessions.delete(missionId);
    await existing.context.close().catch(() => undefined);
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  // Block risky downloads / exe payloads.
  await context.route("**/*", async (route) => {
    const type = route.request().resourceType();
    const url = route.request().url().toLowerCase();
    if (
      type === "media" &&
      (url.endsWith(".exe") || url.endsWith(".dmg") || url.endsWith(".msi"))
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  const session: MissionBrowserSession = {
    context,
    page,
    lastAction: "open",
  };
  sessions.set(missionId, session);
  return session;
}

export async function clearBrowserSession(missionId: string): Promise<void> {
  const session = sessions.get(missionId);
  if (!session) {
    return;
  }
  sessions.delete(missionId);
  await session.context.close().catch(() => undefined);
}

export async function shutdownMissionBrowsers(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => clearBrowserSession(id)));
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => undefined);
    sharedBrowser = null;
  }
}

/** Exported for offline tests — Google /sorry and common bot walls. */
export function looksLikeCaptcha(
  url: string,
  title: string,
  bodyText: string,
): boolean {
  const blob = `${url} ${title} ${bodyText}`.toLowerCase();
  return (
    blob.includes("captcha") ||
    blob.includes("recaptcha") ||
    blob.includes("hcaptcha") ||
    blob.includes("cf-challenge") ||
    blob.includes("attention required") ||
    blob.includes("verify you are human") ||
    blob.includes("are you a robot") ||
    blob.includes("google.com/sorry") ||
    blob.includes("/sorry/") ||
    blob.includes("unusual traffic")
  );
}

async function pageSnapshot(page: Page): Promise<{
  url: string;
  title: string;
  textSample: string;
}> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const textSample = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  return {
    url,
    title,
    textSample: textSample.replace(/\s+/g, " ").trim().slice(0, 1200),
  };
}

function isCssSelector(value: string): boolean {
  return (
    value.startsWith("#") ||
    value.startsWith(".") ||
    value.startsWith("[") ||
    value.includes(">") ||
    /^[a-z]+(\[|#|\.)/i.test(value)
  );
}

const OBSERVE_ROLES = [
  "link",
  "button",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "searchbox",
  "option",
  "tab",
  "menuitem",
] as const;

async function collectControls(
  page: Page,
  limit: number,
): Promise<ObservedControl[]> {
  const out: ObservedControl[] = [];
  const seen = new Set<string>();

  const push = (role: string, name: string, disabled?: boolean) => {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean) {
      return;
    }
    const key = `${role}:${clean.toLowerCase()}`;
    if (seen.has(key) || out.length >= limit) {
      return;
    }
    seen.add(key);
    out.push({
      role,
      name: clean,
      ...(disabled ? { disabled: true } : {}),
    });
  };

  for (const role of OBSERVE_ROLES) {
    if (out.length >= limit) {
      break;
    }
    const loc = page.getByRole(role);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n && out.length < limit; i += 1) {
      const el = loc.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const name = await el
        .evaluate((node) => {
          const h = node as HTMLElement;
          return (
            h.getAttribute("aria-label") ||
            h.innerText ||
            h.textContent ||
            (h as HTMLInputElement).placeholder ||
            h.getAttribute("name") ||
            h.getAttribute("title") ||
            ""
          );
        })
        .catch(() => "");
      const disabled = await el.isDisabled().catch(() => false);
      push(role, name, disabled);
    }
  }

  // Fallback CSS sweep — covers pages where ARIA roles are sparse.
  if (out.length < Math.min(8, limit)) {
    const raw = await page
      .evaluate((max) => {
        const nodes = Array.from(
          document.querySelectorAll(
            "a[href], button, input:not([type='hidden']), select, textarea, [role='button'], [role='link']",
          ),
        );
        const rows: { role: string; name: string; disabled: boolean }[] = [];
        for (const node of nodes) {
          if (rows.length >= max) {
            break;
          }
          const h = node as HTMLElement;
          const style = window.getComputedStyle(h);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            (h as HTMLInputElement).type === "hidden"
          ) {
            continue;
          }
          const tag = h.tagName || "";
          const type = (h as HTMLInputElement).type || "";
          let role = h.getAttribute("role") || "";
          if (!role) {
            const t = tag.toLowerCase();
            const ty = type.toLowerCase();
            if (t === "a") {
              role = "link";
            } else if (t === "button" || ty === "button" || ty === "submit") {
              role = "button";
            } else if (t === "select") {
              role = "combobox";
            } else if (t === "textarea") {
              role = "textbox";
            } else if (t === "input") {
              role =
                ty === "checkbox"
                  ? "checkbox"
                  : ty === "radio"
                    ? "radio"
                    : ty === "search"
                      ? "searchbox"
                      : "textbox";
            } else {
              role = "generic";
            }
          }
          const name = (
            h.getAttribute("aria-label") ||
            h.innerText ||
            h.textContent ||
            (h as HTMLInputElement).placeholder ||
            h.getAttribute("name") ||
            h.getAttribute("title") ||
            h.id ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          if (!name) {
            continue;
          }
          rows.push({
            role,
            name,
            disabled: !!(h as HTMLButtonElement).disabled,
          });
        }
        return rows;
      }, limit)
      .catch(() => [] as { role: string; name: string; disabled: boolean }[]);
    for (const row of raw) {
      push(row.role, row.name, row.disabled);
    }
  }

  return out;
}

function formatControlsPreview(controls: ObservedControl[]): string {
  if (controls.length === 0) {
    return "";
  }
  return controls
    .slice(0, CONTROLS_PREVIEW_LIMIT)
    .map((c) => `${c.role}:${c.name}${c.disabled ? " (disabled)" : ""}`)
    .join(" | ");
}

async function settleAfterAction(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 3_000 })
    .catch(() => undefined);
  // Zap product cards (legacy ProdBox + current card-v2) may hydrate late.
  await page
    .waitForSelector(
      ".model-row-v2, .card-v2, .ProdBox, .product-box, #divSearchResults, #b_results, main, [role='main']",
      { timeout: 4_000 },
    )
    .catch(() => undefined);
}

async function resolveLocator(
  page: Page,
  args: {
    selector?: string;
    text?: string;
    role?: string;
    name?: string;
  },
): Promise<Locator> {
  const role = args.role?.trim();
  const name = args.name?.trim();
  if (role && name) {
    return page.getByRole(role as "button", { name, exact: false }).first();
  }
  if (role) {
    return page.getByRole(role as "button").first();
  }
  const selectorOrText = (args.selector || args.text || "").trim();
  if (!selectorOrText) {
    throw new Error("missing selector/text/role");
  }
  if (isCssSelector(selectorOrText)) {
    return page.locator(selectorOrText).first();
  }
  return page.getByText(selectorOrText, { exact: false }).first();
}

async function nearbyControlHint(page: Page): Promise<string> {
  const controls = await collectControls(page, 12);
  const preview = formatControlsPreview(controls);
  return preview ? ` Nearby: ${preview}` : "";
}

export async function browserNavigate(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    return { ok: false, summary: "browser.navigate requires url" };
  }
  try {
    const session = await sessionFor(ctx.missionId);
    let response: Awaited<ReturnType<Page["goto"]>> = null;
    try {
      response = await session.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (navError) {
      const msg =
        navError instanceof Error ? navError.message : String(navError);
      // Sites often meta-refresh / JS-redirect mid-goto; land on the final URL.
      const recoverable =
        /interrupted by another navigation|net::ERR_ABORTED|frame was detached|Navigation to .+ is interrupted/i.test(
          msg,
        );
      if (!recoverable) {
        throw navError;
      }
      await session.page
        .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined);
    }
    session.lastAction = `navigate ${url}`;
    // Give SERP / Zap product lists a moment to hydrate.
    await session.page
      .waitForSelector(
        "#b_results, #b_content, #links, main, .ProdBox, .model-row-v2, .card-v2, #divSearchResults",
        { timeout: 8_000 },
      )
      .catch(() => undefined);
    await dismissConsentIfPresent(session.page);
    const snap = await pageSnapshot(session.page);
    if (
      !snap.url ||
      snap.url === "about:blank" ||
      snap.url.startsWith("chrome-error:")
    ) {
      return {
        ok: false,
        summary: `Navigate failed: empty/error page after ${url}`,
        data: { url, final_url: snap.url },
      };
    }
    if (looksLikeCaptcha(snap.url, snap.title, snap.textSample)) {
      return {
        ok: false,
        summary: `CAPTCHA/bot wall at ${snap.url}`,
        blockedReason: "automation_blocked",
        data: { url: snap.url, title: snap.title, status: response?.status() },
      };
    }
    const controls = await collectControls(
      session.page,
      CONTROLS_PREVIEW_LIMIT,
    );
    const sample = snap.textSample.replace(/\s+/g, " ").trim().slice(0, 240);
    const preview = formatControlsPreview(controls);
    return {
      ok: true,
      summary: `Opened ${snap.url}${snap.title ? ` — ${snap.title}` : ""}${
        sample ? `: ${sample}` : ""
      }${preview ? ` | controls: ${preview}` : ""}`,
      data: {
        url: snap.url,
        title: snap.title,
        status: response?.status() ?? null,
        text_sample: snap.textSample.slice(0, 400),
        controls_preview: controls,
      },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Navigate failed: ${error instanceof Error ? error.message : "unknown"}`,
      data: { url },
    };
  }
}

export async function browserClick(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : undefined;
  const text = typeof args.text === "string" ? args.text.trim() : undefined;
  const role = typeof args.role === "string" ? args.role.trim() : undefined;
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  const label = role && name ? `${role}:${name}` : selector || text || "";
  if (!selector && !text && !(role && name) && !role) {
    return {
      ok: false,
      summary: "browser.click requires selector, text, or role(+name)",
    };
  }
  try {
    const session = await sessionFor(ctx.missionId);
    const locator = await resolveLocator(session.page, {
      selector,
      text,
      role,
      name,
    });
    await locator.click({ timeout: DEFAULT_TIMEOUT_MS });
    session.lastAction = `click ${label}`;
    await settleAfterAction(session.page);
    const snap = await pageSnapshot(session.page);
    if (looksLikeCaptcha(snap.url, snap.title, snap.textSample)) {
      return {
        ok: false,
        summary: `CAPTCHA/bot wall after click on «${label}»`,
        blockedReason: "automation_blocked",
        data: { selector: label, url: snap.url, title: snap.title },
      };
    }
    const controls = await collectControls(
      session.page,
      CONTROLS_PREVIEW_LIMIT,
    );
    const sample = snap.textSample.slice(0, 240);
    return {
      ok: true,
      summary: `Clicked «${label}» → ${snap.url}${
        sample ? `: ${sample}` : ""
      }`,
      data: {
        selector: label,
        url: snap.url,
        title: snap.title,
        text_sample: snap.textSample.slice(0, 400),
        controls_preview: controls,
      },
    };
  } catch (error) {
    const session = sessions.get(ctx.missionId);
    const hint = session
      ? await nearbyControlHint(session.page)
      : "";
    return {
      ok: false,
      summary: `Click failed: ${error instanceof Error ? error.message : "unknown"}${hint}`,
      data: { selector: label },
    };
  }
}

export async function browserType(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : undefined;
  const role = typeof args.role === "string" ? args.role.trim() : undefined;
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  const text = typeof args.text === "string" ? args.text : "";
  const label = role && name ? `${role}:${name}` : selector || "";
  if (!selector && !(role && name)) {
    return {
      ok: false,
      summary: "browser.type requires selector or role+name",
    };
  }
  try {
    const session = await sessionFor(ctx.missionId);
    const locator = await resolveLocator(session.page, {
      selector,
      role,
      name,
    });
    await locator.fill(text, { timeout: DEFAULT_TIMEOUT_MS });
    session.lastAction = `type ${label}`;
    return {
      ok: true,
      summary: `Typed into ${label} (${text.length} chars)`,
      data: {
        selector: label,
        length: text.length,
        url: session.page.url(),
      },
    };
  } catch (error) {
    const session = sessions.get(ctx.missionId);
    const hint = session
      ? await nearbyControlHint(session.page)
      : "";
    return {
      ok: false,
      summary: `Type failed: ${error instanceof Error ? error.message : "unknown"}${hint}`,
      data: { selector: label, length: text.length },
    };
  }
}

export async function browserObserve(
  _args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  try {
    const session = await sessionFor(ctx.missionId);
    await dismissConsentIfPresent(session.page);
    const controls = await collectControls(session.page, OBSERVE_LIMIT);
    session.lastAction = "observe";
    const snap = await pageSnapshot(session.page);
    const lines = controls
      .map(
        (c, i) =>
          `${i + 1}. [${c.role}] ${c.name}${c.disabled ? " (disabled)" : ""}`,
      )
      .join("\n");
    return {
      ok: true,
      summary: `Observed ${controls.length} controls at ${snap.url}:\n${lines.slice(0, 1800)}`,
      data: {
        url: snap.url,
        title: snap.title,
        controls,
        text_sample: snap.textSample.slice(0, 400),
      },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Observe failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

export async function browserWait(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const timeoutRaw =
    typeof args.timeout_ms === "number"
      ? args.timeout_ms
      : typeof args.timeout === "number"
        ? args.timeout
        : 5_000;
  const timeout = Math.min(Math.max(timeoutRaw, 100), WAIT_CAP_MS);
  try {
    const session = await sessionFor(ctx.missionId);
    if (selector) {
      await session.page.waitForSelector(selector, { timeout });
    } else if (text) {
      await session.page.getByText(text, { exact: false }).first().waitFor({
        state: "visible",
        timeout,
      });
    } else {
      await session.page.waitForTimeout(timeout);
    }
    session.lastAction = "wait";
    const snap = await pageSnapshot(session.page);
    return {
      ok: true,
      summary: `Waited${selector ? ` for ${selector}` : text ? ` for text «${text}»` : ` ${timeout}ms`} → ${snap.url}`,
      data: { url: snap.url, title: snap.title, timeout_ms: timeout },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Wait failed: ${error instanceof Error ? error.message : "unknown"}`,
      data: { selector, text, timeout_ms: timeout },
    };
  }
}

export async function browserScroll(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : undefined;
  const text = typeof args.text === "string" ? args.text.trim() : undefined;
  const direction =
    typeof args.direction === "string" ? args.direction.trim() : "down";
  try {
    const session = await sessionFor(ctx.missionId);
    if (selector || text) {
      const locator = await resolveLocator(session.page, { selector, text });
      await locator.scrollIntoViewIfNeeded({ timeout: DEFAULT_TIMEOUT_MS });
    } else {
      const delta = direction === "up" ? -800 : 800;
      await session.page.mouse.wheel(0, delta);
    }
    session.lastAction = "scroll";
    return {
      ok: true,
      summary: `Scrolled${selector || text ? ` to «${selector || text}»` : ` ${direction}`}`,
      data: { url: session.page.url(), direction },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Scroll failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

export async function browserSelect(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : undefined;
  const role = typeof args.role === "string" ? args.role.trim() : undefined;
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  const value =
    typeof args.value === "string"
      ? args.value.trim()
      : typeof args.label === "string"
        ? args.label.trim()
        : "";
  const label = role && name ? `${role}:${name}` : selector || "";
  if (!value) {
    return { ok: false, summary: "browser.select requires value or label" };
  }
  if (!selector && !(role && name)) {
    return {
      ok: false,
      summary: "browser.select requires selector or role+name",
    };
  }
  try {
    const session = await sessionFor(ctx.missionId);
    const locator = await resolveLocator(session.page, {
      selector,
      role: role || "combobox",
      name,
    });
    await locator.selectOption({ label: value }).catch(async () => {
      await locator.selectOption({ value });
    });
    session.lastAction = `select ${label}`;
    return {
      ok: true,
      summary: `Selected «${value}» in ${label}`,
      data: { selector: label, value, url: session.page.url() },
    };
  } catch (error) {
    const session = sessions.get(ctx.missionId);
    const hint = session
      ? await nearbyControlHint(session.page)
      : "";
    return {
      ok: false,
      summary: `Select failed: ${error instanceof Error ? error.message : "unknown"}${hint}`,
      data: { selector: label, value },
    };
  }
}

export async function browserPress(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const key =
    typeof args.key === "string"
      ? args.key.trim()
      : typeof args.text === "string"
        ? args.text.trim()
        : "Enter";
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : undefined;
  const role = typeof args.role === "string" ? args.role.trim() : undefined;
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  try {
    const session = await sessionFor(ctx.missionId);
    if (selector || role || name) {
      const locator = await resolveLocator(session.page, {
        selector,
        role,
        name,
      });
      await locator.press(key, { timeout: DEFAULT_TIMEOUT_MS });
    } else {
      await session.page.keyboard.press(key);
    }
    session.lastAction = `press ${key}`;
    await settleAfterAction(session.page);
    const snap = await pageSnapshot(session.page);
    return {
      ok: true,
      summary: `Pressed ${key} → ${snap.url}`,
      data: {
        key,
        url: snap.url,
        text_sample: snap.textSample.slice(0, 240),
      },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Press failed: ${error instanceof Error ? error.message : "unknown"}`,
      data: { key },
    };
  }
}

/** Prefer SERP / main content over cookie banners and chrome. */
const SEARCH_CONTENT_SELECTORS = [
  "#b_results",
  "ol#b_results",
  "#b_content",
  "#divSearchResults",
  ".model-row-v2",
  ".card-v2",
  ".ProdBox",
  ".product-box",
  "[data-testid='mainline']",
  "#links",
  "#react-layout",
  "main",
  "#main",
  "article",
];

/** Price token: real shekel, mojibake shekel from data: pages, or NIS/ILS. */
const PRICE_TOKEN_RE = /([\d,]+)\s*(?:₪|NIS|ILS|\u00e2\u20ac\u00aa)/iu;

export function hasProductPrice(text: string): boolean {
  return PRICE_TOKEN_RE.test(text) || /₪/.test(text);
}

/** Exported for offline tests — trim Zap card chrome to name + price. */
export function cleanZapCardText(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  if (!t) {
    return "";
  }
  t = t.replace(/^הזול ביותר\s*/u, "");
  t = t.replace(/^נוסף למועדפים\s*/u, "");
  t = t.replace(/\s*הוספת חוות דעת\s*/gu, " ");
  t = t.replace(/\s*לפרטים נוספים\s*/gu, " ");
  t = t.replace(/\s*קנו ב-\s*zapstore\s*/giu, " ");
  t = t.replace(/\s*‫החל מ-?\s*/gu, " ");
  t = t.replace(/\s*החל מ-?\s*/gu, " ");
  const priceMatch = t.match(PRICE_TOKEN_RE);
  if (priceMatch && typeof priceMatch.index === "number") {
    let name = t.slice(0, priceMatch.index).trim();
    name = name.replace(/\s*-\s*קורקנטים.*$/u, "").trim();
    name = name.replace(/\s+/g, " ").trim();
    if (name.length >= 8) {
      return `${name} — ${priceMatch[1]} ₪`;
    }
  }
  return t.slice(0, 160).trim();
}

async function dismissConsentIfPresent(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("button", { name: /accept|agree|קבל|אישור|אני מסכים/i }),
    page.locator("#bnp_btn_accept"),
    page.locator("#onetrust-accept-btn-handler"),
  ];
  for (const loc of candidates) {
    const visible = await loc
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false);
    if (visible) {
      await loc.first().click({ timeout: 2_000 }).catch(() => undefined);
      return;
    }
  }
}

async function extractBingAlgoList(page: Page): Promise<string> {
  const items = page.locator("#b_results .b_algo, li.b_algo");
  const n = await items.count().catch(() => 0);
  if (n === 0) {
    return "";
  }
  const parts: string[] = [];
  for (let i = 0; i < Math.min(n, 8); i += 1) {
    const text = (await items.nth(i).innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (text.length >= 20) {
      parts.push(`${parts.length + 1}. ${text.slice(0, 280)}`);
    }
  }
  return parts.join("\n");
}

/**
 * Zap product cards → numbered name/price lines.
 * Current Zap UI uses `.model-row-v2` / `.card-v2` (legacy `.ProdBox` kept).
 * Prefer `.model-row-v2` to avoid nested card-v2 duplicates.
 */
async function extractZapProductList(page: Page): Promise<string> {
  await page
    .waitForSelector(
      ".model-row-v2, .card-v2, .ProdBox, .product-box, #divSearchResults",
      { timeout: 6_000 },
    )
    .catch(() => undefined);

  const prefer = page.locator(
    "#divSearchResults .model-row-v2, .model-row-v2, .ProdBox, .product-box, .prodBox, [class*='ProdBox']",
  );
  let n = await prefer.count().catch(() => 0);
  let items = prefer;
  if (n === 0) {
    items = page.locator("#divSearchResults .card-v2, .card-v2");
    n = await items.count().catch(() => 0);
  }
  if (n === 0) {
    return "";
  }

  const parts: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(n, 24) && parts.length < 8; i += 1) {
    const raw = (await items.nth(i).innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (raw.length < 12 || !hasProductPrice(raw)) {
      continue;
    }
    // Skip pure filter/facet chrome.
    if (/סינון|סנן|מיין לפי|נמצאו \d+/u.test(raw) && raw.length < 80) {
      continue;
    }
    const cleaned = cleanZapCardText(raw);
    if (cleaned.length < 12 || !hasProductPrice(cleaned)) {
      continue;
    }
    const key = cleaned.toLowerCase().slice(0, 80);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parts.push(`${parts.length + 1}. ${cleaned.slice(0, 220)}`);
  }
  return parts.join("\n");
}

type ExtractedPage = {
  text: string;
  source: "bing" | "zap" | "selector" | "body" | "selector_arg";
};

async function extractPageText(
  page: Page,
  selector?: string,
): Promise<ExtractedPage> {
  if (selector) {
    const locator = await resolveLocator(page, { selector });
    const text = (await locator.innerText({ timeout: 8_000 })).trim();
    return { text, source: "selector_arg" };
  }
  await dismissConsentIfPresent(page);
  const pageUrl = page.url();
  const bingList = await extractBingAlgoList(page);
  if (bingList.length >= 80) {
    return { text: bingList, source: "bing" };
  }
  const zapList = await extractZapProductList(page);
  // At least one numbered priced line (~20+ chars) is enough.
  if (zapList.length >= 20 && /^\d+\.\s+/m.test(zapList)) {
    return { text: zapList.slice(0, 2000), source: "zap" };
  }
  for (const cand of SEARCH_CONTENT_SELECTORS) {
    // Avoid grabbing Zap filter chrome via main/#main when products were empty.
    if (
      (cand === "main" || cand === "#main" || cand === "article") &&
      /zap\.co\.il/i.test(pageUrl)
    ) {
      continue;
    }
    const loc = page.locator(cand).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) {
      continue;
    }
    const text = await loc.innerText({ timeout: 3_000 }).catch(() => "");
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 80) {
      return { text: cleaned.slice(0, 2000), source: "selector" };
    }
  }
  const fallback = (await pageSnapshot(page)).textSample;
  return { text: fallback, source: "body" };
}

export async function browserExtract(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const aspect =
    typeof args.aspect === "string" ? args.aspect.trim() : "summary";
  const selector =
    typeof args.selector === "string" ? args.selector.trim() : "";
  try {
    const session = await sessionFor(ctx.missionId);
    const extracted = await extractPageText(
      session.page,
      selector || undefined,
    );
    const text = extracted.text;
    session.lastAction = `extract ${aspect}`;
    const snap = await pageSnapshot(session.page);
    const productLines = text
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line) => /^\d+\.\s+\S/.test(line))
      .slice(0, 8);
    // Prefer numbered product lines; keep newlines so the runner can split options.
    const payloadLines =
      productLines.length > 0
        ? productLines
        : text
            .split("\n")
            .map((line) => line.replace(/[ \t]+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 40);
    const payload = payloadLines.join("\n").slice(0, 1800);
    return {
      ok: true,
      // Newline after ": " — do NOT flatten to a single prose blob.
      summary: `Extracted ${aspect} (${text.length} chars) from ${snap.url}:\n${payload}`,
      data: {
        url: snap.url,
        title: snap.title,
        aspect,
        text: text.slice(0, 2000),
        source: extracted.source,
        products: productLines,
      },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Extract failed: ${error instanceof Error ? error.message : "unknown"}`,
      data: { aspect, selector },
    };
  }
}

export async function browserScreenshot(
  _args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  try {
    const session = await sessionFor(ctx.missionId);
    const png = await session.page.screenshot({
      fullPage: false,
      type: "png",
    });
    session.lastAction = "screenshot";
    const fileName = `mission-${ctx.missionId.slice(0, 8)}-${Date.now()}.png`;
    const attachment = await ingestUploadedBytes({
      userId: ctx.userId,
      uploaderId: ctx.executorId,
      bytes: Buffer.from(png),
      mimeType: "image/png",
      fileName,
      caption: `Mission screenshot ${session.page.url()}`,
    });
    const evidenceIds: string[] = [];
    if (attachment) {
      evidenceIds.push(attachment.id);
      await applyAttachmentLinks({
        actorId: ctx.executorId,
        target: { missionId: ctx.missionId },
        attachmentIds: [attachment.id],
      });
    }
    return {
      ok: true,
      summary: `Screenshot captured at ${session.page.url()}`,
      evidenceAttachmentIds: evidenceIds,
      data: {
        url: session.page.url(),
        attachment_id: attachment?.id ?? null,
        file_name: fileName,
      },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Screenshot failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

export async function browserSubmit(
  args: Record<string, unknown>,
  ctx: MissionToolContext,
): Promise<MissionToolResult> {
  const selector =
    typeof args.selector === "string"
      ? args.selector.trim()
      : typeof args.text === "string"
        ? args.text.trim()
        : 'button[type="submit"], input[type="submit"]';
  const role = typeof args.role === "string" ? args.role.trim() : undefined;
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  try {
    const session = await sessionFor(ctx.missionId);
    const locator = await resolveLocator(session.page, {
      selector,
      role,
      name,
      text: typeof args.text === "string" ? args.text : undefined,
    });
    await locator.click({ timeout: DEFAULT_TIMEOUT_MS });
    await settleAfterAction(session.page);
    session.lastAction = "submit";
    const snap = await pageSnapshot(session.page);
    if (looksLikeCaptcha(snap.url, snap.title, snap.textSample)) {
      return {
        ok: false,
        summary: `CAPTCHA/bot wall after submit on ${snap.url}`,
        blockedReason: "automation_blocked",
        data: { url: snap.url, title: snap.title },
      };
    }
    const controls = await collectControls(
      session.page,
      CONTROLS_PREVIEW_LIMIT,
    );
    return {
      ok: true,
      summary: `Submitted form → ${snap.url}`,
      data: {
        url: snap.url,
        title: snap.title,
        note: typeof args.note === "string" ? args.note : "",
        text_sample: snap.textSample.slice(0, 400),
        controls_preview: controls,
      },
    };
  } catch (error) {
    return {
      ok: false,
      summary: `Submit failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}
