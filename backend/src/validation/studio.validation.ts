import { z } from "zod";
import { ValidationError } from "../utils/errors.js";

const studioTrackSchema = z.enum(["LIVE_MODEL", "LIVE_MODEL_MT", "LIVE_FULL"]);

export function parseStudioTrackQuery(raw: unknown): z.infer<typeof studioTrackSchema> {
  const parsed = studioTrackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("track must be LIVE_MODEL, LIVE_MODEL_MT, or LIVE_FULL");
  }
  return parsed.data;
}

export function parseStudioStartRunBody(body: unknown): {
  track: z.infer<typeof studioTrackSchema>;
  caseIds?: string[];
  tags?: string[] | null;
} {
  const schema = z.object({
    track: studioTrackSchema,
    caseIds: z.array(z.string().trim().min(1)).optional(),
    tags: z.array(z.string().trim().min(1)).nullable().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid studio run body");
  }
  return parsed.data;
}

export function parseStudioDraftId(raw: unknown): string {
  const parsed = z.string().trim().min(1).max(120).safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Invalid draft id");
  }
  return parsed.data;
}

export function parseStudioPromoteBody(body: unknown): {
  confirmPromote: boolean;
  track: "model" | "mt" | "full";
  caseRow: Record<string, unknown>;
} {
  const schema = z.object({
    confirmPromote: z.literal(true),
    track: z.enum(["model", "mt", "full"]),
    caseRow: z.record(z.string(), z.unknown()),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      "promote requires confirmPromote:true, track model|mt|full, and caseRow",
    );
  }
  return parsed.data;
}
