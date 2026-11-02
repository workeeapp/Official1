import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import type { Attachment } from "@prisma/client";
import type { ChatAttachmentRef } from "@workee/shared";
import { type LlmJsonSchemaFormat } from "../config/llm.js";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { getAttachmentStorage } from "./attachment-storage.js";
import { ingestUploadedBytes, toChatAttachmentRef } from "./attachment.service.js";
import { getLlmClient } from "./llm-client.js";
import {
  recordImageUsage,
  recordLlmUsage,
  type ComposeLlmBilling,
  type ImageApiUsage,
} from "./llm-usage.service.js";
import { recordWhatsAppEvent } from "./whatsapp-log.js";

/** Cheap image stack: mini model + low quality, square (WhatsApp-friendly). */
export const CELEBRATION_IMAGE_MODEL = "gpt-image-1-mini";
export const CELEBRATION_IMAGE_QUALITY = "low" as const;
export const CELEBRATION_IMAGE_SIZE = "1024x1024" as const;
/** Separate cheap Responses model for encouragement / tip / scene JSON. */
export const CELEBRATION_COPY_MODEL = "gpt-4.1-mini";

/** Fixed visual series look — always prepended to the image scene prompt. */
export const CELEBRATION_STYLE_BIBLE = [
  "Unified celebration series style (always apply):",
  "bold comic-book / cartoon superhero illustration,",
  "thick clean ink outlines, cel-shaded color, vibrant heroic palette,",
  "dynamic triumphant pose with euphoric energy,",
  "CRITICAL likeness: face, hair, skin tone, age and features must closely match the reference photo — recognizable as the same person, only stylized as a cartoon hero,",
  "do not invent a generic hero face; keep the reference identity,",
  "bright dramatic lighting, simple graphic background (speed lines / soft burst OK),",
  "no photorealism, no muted pastels, no gloomy mood,",
  "no text, letters, numbers, logos, or watermarks in the image pixels,",
  "no extra people, no cluttered scene.",
].join(" ");

const CELEBRATION_SCHEMA: LlmJsonSchemaFormat = {
  type: "json_schema",
  name: "delete_celebration",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["encouragement", "tip", "scene_prompt"],
    properties: {
      encouragement: {
        type: "string",
        description:
          "One or two COMPLETE short Hebrew sentences (~6–14 words total). MUST end with . or ! — never a cliffhanger. Start with a positive punch (יופי! / אלוף! / מצוין! / כל הכבוד! / מעולה!). Then a clear finished thought tied to what was closed (shopping/task meaning), gendered correctly. Prefer calm clear phrasing over comic mush. Forbidden: unfinished tails («ועכשיו לסיים את», «כמו», hanging «ש…»), vague praise with no link to the win, inventing wins not listed.",
      },
      tip: {
        type: "string",
        description:
          "Usually emit one short Hebrew tip (prefer most turns). Ground it in the closed items when possible. Useful categories: productivity, necessity, safety, money/waste, health, healthy lifestyle, recovery, sleep, movement, hydration, posture, stress. Empty string only when nothing useful fits. One sentence max. No empty fluff.",
      },
      scene_prompt: {
        type: "string",
        description:
          "One English visual scene combining all wins into a single image (no text in the scene).",
      },
    },
  },
};

export type CelebrationRemove = {
  itemLabel: string;
  listType: "shopping" | "tasks";
};

export type CelebrationCopy = {
  encouragement: string;
  tip: string;
  scene_prompt: string;
};

export type CelebrationResult = {
  attachment: Attachment;
  ref: ChatAttachmentRef;
  encouragement: string;
  tip: string;
};

export type ImageGenResult = {
  bytes: Buffer;
  usage?: ImageApiUsage | null;
  raw?: unknown;
};

export type ImageGenFn = (input: {
  avatarBytes: Buffer;
  avatarMime: string;
  prompt: string;
}) => Promise<ImageGenResult | null>;

let imageGenOverride: ImageGenFn | null = null;

export function setCelebrationImageGenForTests(fn: ImageGenFn | null): void {
  imageGenOverride = fn;
}

export function collectCelebrationRemoves(
  mutations: Array<{ action: string; listType: string; itemLabel: string }>,
): CelebrationRemove[] {
  const out: CelebrationRemove[] = [];
  for (const row of mutations) {
    if (row.action !== "remove") continue;
    if (row.listType !== "shopping" && row.listType !== "tasks") continue;
    const label = row.itemLabel.trim();
    if (!label) continue;
    out.push({
      itemLabel: label,
      listType: row.listType,
    });
  }
  return out;
}

export function buildCelebrationImagePrompt(scenePrompt: string): string {
  return `${CELEBRATION_STYLE_BIBLE}\n\nScene: ${scenePrompt.trim()}`;
}

function hebrewFontPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "../../assets/fonts/NotoSansHebrew-Bold.ttf");
  const candidates = [
    bundled,
    "/System/Library/Fonts/Supplemental/Arial Hebrew.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap RTL Hebrew into short lines so comic titles stay inside the frame. */
export function wrapComicLines(
  text: string,
  maxCharsPerLine: number,
  maxLines = 4,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const max = Math.max(6, maxCharsPerLine);
  const lineCap = Math.max(1, maxLines);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= max) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    if (word.length <= max) {
      cur = word;
    } else {
      // Hard-split overlong tokens.
      let rest = word;
      while (rest.length > max) {
        lines.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      cur = rest;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, lineCap);
}

function fitComicFontSize(
  width: number,
  longestLineChars: number,
  baseRatio: number,
  minRatio: number,
): number {
  const maxInk = width * 0.72;
  let size = Math.round(width * baseRatio);
  const min = Math.round(width * minRatio);
  // Bold Hebrew + double comic stroke ≈ 0.78× font-size per glyph; leave side margin.
  while (size > min && longestLineChars * size * 0.78 > maxInk) {
    size -= 2;
  }
  return size;
}

export type CelebrationTextAnchor = {
  /** Horizontal center of the title block, 0–1 of image width. */
  cxRatio: number;
  /** Vertical center of the title block, 0–1 of image height. */
  cyRatio: number;
  rotateDeg: number;
};

/**
 * Pick a calmer region for comic lettering (low edge energy) so placement
 * follows the generated image instead of a fixed bottom band.
 */
export async function pickCelebrationTextAnchor(
  imageBytes: Buffer,
): Promise<CelebrationTextAnchor> {
  const sampleW = 64;
  const sampleH = 64;
  let data: Buffer;
  try {
    const raw = await sharp(imageBytes)
      .resize(sampleW, sampleH, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = raw.data;
  } catch {
    return { cxRatio: 0.5, cyRatio: 0.88, rotateDeg: -1.5 };
  }

  const bands = [
    { y0: 0.08, y1: 0.28 },
    { y0: 0.28, y1: 0.48 },
    { y0: 0.52, y1: 0.72 },
    { y0: 0.72, y1: 0.92 },
  ];
  const cols = [
    { x0: 0.12, x1: 0.4 },
    { x0: 0.3, x1: 0.7 },
    { x0: 0.6, x1: 0.88 },
  ];

  let best = {
    score: Number.POSITIVE_INFINITY,
    cxRatio: 0.5,
    cyRatio: 0.88,
  };

  for (const band of bands) {
    for (const col of cols) {
      const xStart = Math.floor(col.x0 * sampleW);
      const xEnd = Math.min(sampleW - 1, Math.ceil(col.x1 * sampleW));
      const yStart = Math.floor(band.y0 * sampleH);
      const yEnd = Math.min(sampleH - 1, Math.ceil(band.y1 * sampleH));
      let edge = 0;
      let n = 0;
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const i = y * sampleW + x;
          const right = data[i + 1] ?? data[i]!;
          const down = data[i + sampleW] ?? data[i]!;
          const v = data[i]!;
          edge += Math.abs(v - right) + Math.abs(v - down);
          n += 1;
        }
      }
      if (n === 0) continue;
      const score = edge / n;
      if (score < best.score) {
        best = {
          score,
          cxRatio: (col.x0 + col.x1) / 2,
          cyRatio: (band.y0 + band.y1) / 2,
        };
      }
    }
  }

  // Mild tilt varies with the chosen cell so repeats don't look glued.
  const tiltSeed = Math.round(best.cxRatio * 17 + best.cyRatio * 31);
  const rotateDeg = ((tiltSeed % 7) - 3) * 0.7; // about -2.1 … +2.1
  return {
    cxRatio: best.cxRatio,
    cyRatio: best.cyRatio,
    rotateDeg,
  };
}

/** Compact POW lettering only — no bubble plate so the art stays visible. */
function comicTextBlock(input: {
  lines: string[];
  cx: number;
  baselineY: number;
  fontSize: number;
  fill: string;
  rotateDeg: number;
  fontFamily: string;
}): string {
  const lineH = Math.round(input.fontSize * 1.18);
  const startY =
    input.baselineY - ((input.lines.length - 1) * lineH) / 2;
  const tspans = input.lines
    .map((line, i) => {
      const y = startY + i * lineH;
      return i === 0
        ? `<tspan x="${input.cx}" y="${y}">${escapeXml(line)}</tspan>`
        : `<tspan x="${input.cx}" dy="${lineH}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  const blackW = Math.max(8, Math.round(input.fontSize * 0.22));
  const whiteW = Math.max(4, Math.round(input.fontSize * 0.1));
  const common = [
    `x="${input.cx}"`,
    `text-anchor="middle"`,
    `class="comic"`,
    `font-size="${input.fontSize}"`,
    `font-weight="900"`,
    `font-family="${input.fontFamily}"`,
    `letter-spacing="0.02em"`,
  ].join(" ");

  // Triple comic outline: fat black → white halo → colored fill.
  return `
    <g transform="rotate(${input.rotateDeg} ${input.cx} ${input.baselineY})">
      <text ${common} fill="none" stroke="#111111" stroke-width="${blackW}" paint-order="stroke">${tspans}</text>
      <text ${common} fill="none" stroke="#FFFFFF" stroke-width="${whiteW}" paint-order="stroke">${tspans}</text>
      <text ${common} fill="${input.fill}" stroke="#111111" stroke-width="${Math.max(2, Math.round(input.fontSize * 0.04))}" paint-order="stroke fill">${tspans}</text>
    </g>
  `;
}

/** Composite Hebrew encouragement onto a PNG (tip stays message-only). Exported for tests. */
export async function overlayCelebrationHebrew(input: {
  imageBytes: Buffer;
  encouragement: string;
  anchor?: CelebrationTextAnchor;
}): Promise<Buffer> {
  const encouragement = input.encouragement.trim();
  if (!encouragement) {
    return input.imageBytes;
  }
  const meta = await sharp(input.imageBytes).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const fontPath = hebrewFontPath();
  const fontFace = fontPath
    ? `@font-face { font-family: "CelebrationHebrew"; src: url("file://${fontPath}"); }`
    : "";
  const fontFamily = fontPath
    ? "CelebrationHebrew, Arial Hebrew, Arial Black, Impact, sans-serif"
    : "Arial Hebrew, Arial Black, Impact, sans-serif";

  const titleLines = wrapComicLines(encouragement, 16, 4);
  if (titleLines.length === 0) return input.imageBytes;
  const titleLen = Math.max(1, ...titleLines.map((l) => l.length));
  const titleSize = fitComicFontSize(width, titleLen, 0.062, 0.036);
  const titleBlockH = titleLines.length * titleSize * 1.18;
  const halfH = titleBlockH / 2;
  const marginY = Math.max(titleSize * 0.6, height * 0.04);
  const marginX = width * 0.12;

  const anchor =
    input.anchor ?? (await pickCelebrationTextAnchor(input.imageBytes));
  let cx = width * anchor.cxRatio;
  let titleBaseline = height * anchor.cyRatio;
  cx = Math.min(width - marginX, Math.max(marginX, cx));
  titleBaseline = Math.min(
    height - marginY - halfH,
    Math.max(marginY + halfH, titleBaseline),
  );

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          ${fontFace}
          .comic {
            font-family: ${fontFamily};
            direction: rtl;
            unicode-bidi: bidi-override;
            stroke-linejoin: round;
            stroke-linecap: round;
          }
        </style>
      </defs>
      ${comicTextBlock({
        lines: titleLines,
        cx: Math.round(cx),
        baselineY: Math.round(titleBaseline),
        fontSize: titleSize,
        fill: "#FFE600",
        rotateDeg: anchor.rotateDeg,
        fontFamily,
      })}
    </svg>`,
  );
  return sharp(input.imageBytes)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export async function composeCelebrationCopy(input: {
  removes: CelebrationRemove[];
  speakerName: string;
  addressGender?: "male" | "female" | null;
  billing?: ComposeLlmBilling | null;
}): Promise<CelebrationCopy | null> {
  if (input.removes.length === 0) return null;
  const name = input.speakerName.trim() || "חבר";
  const gender =
    input.addressGender === "female"
      ? "female (את / כל הכבוד לך feminine forms)"
      : input.addressGender === "male"
        ? "male (אתה / כל הכבוד לך masculine forms)"
        : "unknown gender — use neutral or masculine Hebrew";
  const lines = input.removes.map(
    (row, i) =>
      `${i + 1}. [${row.listType === "shopping" ? "shopping" : "task"}] ${row.itemLabel}`,
  );
  try {
    const client = getLlmClient();
    const openaiConversationId = await client.createConversation();
    const turn = await client.createResponse({
      conversationId: openaiConversationId,
      model: CELEBRATION_COPY_MODEL,
      temperature: 0.75,
      instructions: [
        "You write one celebration card for a person who just closed shopping items and/or tasks.",
        "Return JSON only matching the schema.",
        "encouragement: 1–2 COMPLETE Hebrew sentences (~6–14 words). MUST finish cleanly with . or !. Never mid-thought.",
        "Structure: positive punch (יופי!/אלוף!/מצוין!/כל הכבוד!/מעולה!) + clear finished meaning tied to the closed win. You MAY include the speaker first name but it is optional if the line stays clear. Gender forms must match Address gender.",
        "Match tone to the kind of win (infer from labels):",
        "Shopping → «יופי! הסופר מאחוריך, עכשיו אפשר להיות בראש שקט.»",
        "Sport/self-care → «אלוף! עשית משהו טוב בשביל עצמך היום.»",
        "Work → «מצוין! עוד משימה מקצועית שהתקדמה לסיום.»",
        "Phone call you delayed → «כל הכבוד! לפעמים הדבר הכי טוב הוא פשוט לסיים עם זה.»",
        "Medical → «יופי! חשוב לדאוג גם לעצמך. שמח שהשלמת את זה.»",
        "Home chore → «מעולה! עוד משהו קטן שעושה סדר בראש ובבית.»",
        "Going outside / errand → «כל הכבוד! יצאת החוצה וסיימת עם זה.»",
        "Bad (forbidden): cliffhangers like «קנית חלב ועכשיו לסיים את»; hanging «כמו»/«ש…»; praise with no link to the win; inventing wins not listed; emoji in encouragement.",
        "When several items closed, one clear batched line — not one sentence per item.",
        "tip: Prefer emitting a tip on MOST turns (roughly ~3 out of 4). One short Hebrew sentence. Prefer grounding in the closed items. Categories: productivity, necessity, safety, money/waste, health, healthy lifestyle, recovery, sleep, movement, hydration, posture, stress-reduction. Examples: after shopping «שים לב לתאריך התפוגה על החלב.»; after a walk «שתה מים ותן לגוף רגע להתאושף.»; after a desk task «קום לדקה מתיחה — הגב יודה לך.» Empty string ONLY when nothing useful fits. No empty fluff / generic «תהיה חיובי».",
        "scene_prompt: one English visual scene that can combine multiple wins in a single image. Style: comic-book / cartoon superhero energy, person recognizable from their photo. No text in the scene. No multiple panels.",
        "Do not invent extra wins beyond the listed items.",
      ].join("\n"),
      textFormat: CELEBRATION_SCHEMA,
      message: [
        `Speaker first name: ${name}`,
        `Address gender: ${gender}`,
        `Closed items this turn:`,
        ...lines,
        "Write a COMPLETE encouragement (no cliffhangers), a useful tip when you can (prefer most turns; health/lifestyle OK), and one combined scene_prompt now.",
      ].join("\n"),
    });
    if (input.billing) {
      await recordLlmUsage({
        conversationId: input.billing.conversationId,
        employeeId: input.billing.employeeId,
        digitalEmployeeId: input.billing.digitalEmployeeId,
        openaiConversationId,
        model: CELEBRATION_COPY_MODEL,
        turn,
        purpose: "delete_celebration",
      });
    }
    const parsed = parseCelebrationCopy(turn.reply);
    if (!parsed) {
      recordWhatsAppEvent("delete_celebration_copy_empty", "parse_fail");
      return null;
    }
    return parsed;
  } catch (error) {
    recordWhatsAppEvent(
      "delete_celebration_copy_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return null;
  }
}

export function parseCelebrationCopy(raw: string): CelebrationCopy | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const json = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    const obj = JSON.parse(json) as Record<string, unknown>;
    const encouragement = String(obj.encouragement ?? "").trim();
    const tip = String(obj.tip ?? "").trim();
    const scene_prompt = String(obj.scene_prompt ?? obj.scenePrompt ?? "").trim();
    if (!encouragement || !scene_prompt) return null;
    return { encouragement, tip, scene_prompt };
  } catch {
    return null;
  }
}

async function defaultImageGen(input: {
  avatarBytes: Buffer;
  avatarMime: string;
  prompt: string;
}): Promise<ImageGenResult | null> {
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const client = new OpenAI({ apiKey });
    const mime = input.avatarMime || "image/png";
    const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
    const image = await toFile(Readable.from(input.avatarBytes), `avatar.${ext}`, {
      type: mime,
    });
    const result = await client.images.edit({
      model: CELEBRATION_IMAGE_MODEL,
      image,
      prompt: input.prompt.slice(0, 32000),
      size: CELEBRATION_IMAGE_SIZE,
      quality: CELEBRATION_IMAGE_QUALITY,
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) return null;
    return {
      bytes: Buffer.from(b64, "base64"),
      usage: (result.usage ?? null) as ImageApiUsage | null,
      raw: result.usage ?? null,
    };
  } catch (error) {
    recordWhatsAppEvent(
      "delete_celebration_image_fail",
      error instanceof Error ? error.message : "unknown",
    );
    return null;
  }
}

/**
 * One celebration image for all shopping/tasks removes this turn.
 * Fail-soft: returns null on any error (delete ack still stands).
 */
export async function runDeleteCelebration(input: {
  userId: string;
  uploaderId: string;
  profileAttachmentId: string;
  removes: CelebrationRemove[];
  speakerName: string;
  addressGender?: "male" | "female" | null;
  billing?: ComposeLlmBilling | null;
}): Promise<CelebrationResult | null> {
  if (input.removes.length === 0) return null;
  if (!input.profileAttachmentId.trim()) return null;

  const profile = await prisma.attachment.findFirst({
    where: {
      id: input.profileAttachmentId,
      userId: input.userId,
      deletedAt: null,
      kind: "image",
    },
  });
  if (!profile) {
    recordWhatsAppEvent("delete_celebration_skip", "no_profile_row");
    return null;
  }

  let avatarBytes: Buffer;
  try {
    avatarBytes = await getAttachmentStorage().read(profile.storageKey);
  } catch {
    recordWhatsAppEvent("delete_celebration_skip", "avatar_read_fail");
    return null;
  }
  if (!avatarBytes.length) return null;

  const copy = await composeCelebrationCopy({
    removes: input.removes,
    speakerName: input.speakerName,
    addressGender: input.addressGender,
    billing: input.billing,
  });
  if (!copy) return null;

  const prompt = buildCelebrationImagePrompt(copy.scene_prompt);
  const gen = imageGenOverride ?? defaultImageGen;
  const generated = await gen({
    avatarBytes,
    avatarMime: profile.mimeType,
    prompt,
  });
  if (!generated?.bytes?.length) return null;
  if (input.billing) {
    await recordImageUsage({
      conversationId: input.billing.conversationId,
      employeeId: input.billing.employeeId,
      digitalEmployeeId: input.billing.digitalEmployeeId,
      model: CELEBRATION_IMAGE_MODEL,
      usage: generated.usage,
      raw: generated.raw ?? generated.usage,
    });
  }
  const sceneBytes = generated.bytes;

  let composited: Buffer;
  try {
    composited = await overlayCelebrationHebrew({
      imageBytes: sceneBytes,
      encouragement: copy.encouragement,
    });
  } catch (error) {
    recordWhatsAppEvent(
      "delete_celebration_overlay_fail",
      error instanceof Error ? error.message : "unknown",
    );
    composited = sceneBytes;
  }

  // JPEG ~80 keeps WhatsApp uploads small; web uses the same attachment.
  let finalBytes = composited;
  let mimeType = "image/png";
  let fileName = "celebration.png";
  try {
    finalBytes = await sharp(composited).jpeg({ quality: 80 }).toBuffer();
    mimeType = "image/jpeg";
    fileName = "celebration.jpg";
  } catch {
    /* keep PNG composited buffer */
  }

  const caption = copy.tip.slice(0, 1024);
  const row = await ingestUploadedBytes({
    userId: input.userId,
    uploaderId: input.uploaderId,
    bytes: finalBytes,
    mimeType,
    fileName,
    caption,
  });
  if (!row) {
    recordWhatsAppEvent("delete_celebration_store_fail", "ingest");
    return null;
  }
  recordWhatsAppEvent(
    "delete_celebration_ok",
    `removes=${input.removes.length} attachment=${row.id}`,
  );
  return {
    attachment: row,
    ref: toChatAttachmentRef(row),
    encouragement: copy.encouragement,
    tip: copy.tip,
  };
}
