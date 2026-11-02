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
          "Short Hebrew encouragement including the speaker name, gendered correctly. Covers the whole batch of wins.",
      },
      tip: {
        type: "string",
        description:
          "Optional short Hebrew tip grounded in the scene. Empty string when none fits.",
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
export function wrapComicLines(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const max = Math.max(6, maxCharsPerLine);
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
  return lines.slice(0, 3);
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

/** Classic comic lettering: shout bubble + multi-stroke fill (POW-style). */
function comicTextBlock(input: {
  lines: string[];
  cx: number;
  baselineY: number;
  fontSize: number;
  fill: string;
  bubbleFill: string;
  rotateDeg: number;
  fontFamily: string;
  /** Shout bubble points up toward the hero; caption plate has no tail. */
  kind: "shout" | "caption";
  canvasWidth: number;
}): string {
  const lineH = Math.round(input.fontSize * 1.18);
  const longest = Math.max(1, ...input.lines.map((l) => l.length));
  const textW = Math.min(
    input.canvasWidth * 0.86,
    longest * input.fontSize * 0.78,
  );
  const padX = Math.round(input.fontSize * 0.55);
  const padY = Math.round(input.fontSize * 0.42);
  const boxW = Math.min(
    input.canvasWidth * 0.9,
    Math.max(textW + padX * 2, input.fontSize * 4),
  );
  const textBlockH = input.lines.length * lineH;
  const boxH = textBlockH + padY * 2;
  const boxX = input.cx - boxW / 2;
  const boxY = input.baselineY - boxH / 2;
  const r = Math.round(Math.min(boxH * 0.28, input.fontSize * 0.55));
  const border = Math.max(4, Math.round(input.fontSize * 0.12));
  const shadowDx = Math.round(input.fontSize * 0.08);
  const shadowDy = Math.round(input.fontSize * 0.1);

  // Soft rectangle shadow under the bubble (hard comic offset).
  const shadowRect = `<rect x="${boxX + shadowDx}" y="${boxY + shadowDy}" width="${boxW}" height="${boxH}" rx="${r}" ry="${r}" fill="#111111" opacity="0.85"/>`;
  const plate = `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${r}" ry="${r}" fill="${input.bubbleFill}" stroke="#111111" stroke-width="${border}"/>`;

  let tail = "";
  if (input.kind === "shout") {
    // Pointy shout-tail toward the character above the plate.
    const mid = input.cx;
    const tipY = boxY - Math.round(input.fontSize * 0.55);
    const left = mid - Math.round(input.fontSize * 0.55);
    const right = mid + Math.round(input.fontSize * 0.55);
    const baseY = boxY + border;
    tail = `
      <polygon points="${left},${baseY} ${right},${baseY} ${mid},${tipY}" fill="${input.bubbleFill}" stroke="#111111" stroke-width="${border}" stroke-linejoin="round"/>
      <polygon points="${left + border},${baseY + 1} ${right - border},${baseY + 1} ${mid},${tipY + border * 1.2}" fill="${input.bubbleFill}"/>
    `;
  }

  const startY =
    input.baselineY - ((input.lines.length - 1) * lineH) / 2 + input.fontSize * 0.32;
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

  // Triple comic outline: fat black → white halo → colored fill (logo / POW lettering).
  const lettering = `
    <text ${common} fill="none" stroke="#111111" stroke-width="${blackW}" paint-order="stroke">${tspans}</text>
    <text ${common} fill="none" stroke="#FFFFFF" stroke-width="${whiteW}" paint-order="stroke">${tspans}</text>
    <text ${common} fill="${input.fill}" stroke="#111111" stroke-width="${Math.max(2, Math.round(input.fontSize * 0.04))}" paint-order="stroke fill">${tspans}</text>
  `;

  return `
    <g transform="rotate(${input.rotateDeg} ${input.cx} ${input.baselineY})">
      ${shadowRect}
      ${plate}
      ${tail}
      ${lettering}
    </g>
  `;
}

/** Composite Hebrew encouragement (+ optional tip) onto a PNG. Exported for tests. */
export async function overlayCelebrationHebrew(input: {
  imageBytes: Buffer;
  encouragement: string;
  tip?: string;
}): Promise<Buffer> {
  const encouragement = input.encouragement.trim();
  const tip = (input.tip ?? "").trim();
  if (!encouragement && !tip) {
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

  // ~12–16 chars/line keeps titles inside after stroke + bubble padding.
  const titleLines = wrapComicLines(encouragement, 14);
  const tipLines = tip ? wrapComicLines(tip, 22) : [];
  const titleLen = Math.max(1, ...titleLines.map((l) => l.length));
  const tipLen = tipLines.length
    ? Math.max(1, ...tipLines.map((l) => l.length))
    : 1;
  const titleSize = fitComicFontSize(width, titleLen, 0.062, 0.036);
  const tipSize = fitComicFontSize(width, tipLen, 0.032, 0.024);
  const titleLineH = titleSize * 1.18;
  const tipLineH = tipSize * 1.18;
  const titleBoxH =
    titleLines.length * titleLineH + titleSize * 0.84 + titleSize * 0.55;
  const tipBoxH = tipLines.length
    ? tipLines.length * tipLineH + tipSize * 0.84
    : 0;
  const gap = tipLines.length ? Math.round(height * 0.018) : 0;
  const bottomPad = Math.round(height * 0.045);
  const tipBaseline = tipLines.length
    ? height - bottomPad - tipBoxH / 2
    : 0;
  const titleBaseline = tipLines.length
    ? tipBaseline - tipBoxH / 2 - gap - titleBoxH / 2
    : height - bottomPad - titleBoxH / 2;
  const cx = width / 2;

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
      ${
        titleLines.length
          ? comicTextBlock({
              lines: titleLines,
              cx,
              baselineY: Math.round(titleBaseline),
              fontSize: titleSize,
              fill: "#FFE600",
              bubbleFill: "#FFF8E7",
              rotateDeg: -2,
              fontFamily,
              kind: "shout",
              canvasWidth: width,
            })
          : ""
      }
      ${
        tipLines.length
          ? comicTextBlock({
              lines: tipLines,
              cx,
              baselineY: Math.round(tipBaseline),
              fontSize: tipSize,
              fill: "#1E3A8A",
              bubbleFill: "#FFFFFF",
              rotateDeg: 1.5,
              fontFamily,
              kind: "caption",
              canvasWidth: width,
            })
          : ""
      }
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
      temperature: 0.7,
      instructions: [
        "You write one celebration card for a person who just closed shopping items and/or tasks.",
        "Return JSON only matching the schema.",
        "encouragement: short Hebrew, include the speaker first name, gendered correctly, covers the whole batch (not one line per item).",
        "tip: optional short Hebrew tip that fits the scene (one tip max). Empty string if none.",
        "scene_prompt: one English visual scene that can combine multiple wins in a single image (e.g. holding groceries while leaving a garage). Style: comic-book / cartoon superhero energy, but the person must stay recognizable from their photo. No text in the scene. No multiple panels.",
        "Do not invent extra wins beyond the listed items.",
      ].join("\n"),
      textFormat: CELEBRATION_SCHEMA,
      message: [
        `Speaker first name: ${name}`,
        `Address gender: ${gender}`,
        `Closed items this turn:`,
        ...lines,
        "Write encouragement, tip, and one combined scene_prompt now.",
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
      tip: copy.tip,
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
