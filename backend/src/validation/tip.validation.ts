import {
  hasTipFieldErrors,
  normalizeTipInput,
  normalizeTipUpdateInput,
  parseTipAudience,
  parseTipTriggerArea,
  parseTipTriggerKind,
  parseTipTriggerOp,
  validateEmployeeId,
  validateTipInput,
  validateTipUpdateInput,
  type TipInput,
  type TipUpdateInput,
} from "@workee/shared";
import { ValidationError } from "../utils/errors.js";

function compactFieldErrors(
  errors: Record<string, string | undefined> | object,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

export function parseTipIdParam(id: unknown): string {
  const error = validateEmployeeId(id);
  if (error || typeof id !== "string") {
    throw new ValidationError("Tip id is required", { id: error ?? "Invalid id" });
  }
  return id.trim();
}

export function parseTipCreateBody(body: unknown): TipInput {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Tip details are required", {
      key: "Key is required",
    });
  }
  const record = body as Record<string, unknown>;
  const audience = parseTipAudience(record.audience);
  const triggerKind = parseTipTriggerKind(record.triggerKind);
  const triggerArea = parseTipTriggerArea(record.triggerArea);
  const triggerOp =
    record.triggerOp === undefined ||
    record.triggerOp === null ||
    record.triggerOp === ""
      ? "add"
      : parseTipTriggerOp(record.triggerOp);
  const maxShows =
    typeof record.maxShows === "number"
      ? record.maxShows
      : Number(record.maxShows);
  const order =
    typeof record.order === "number" ? record.order : Number(record.order ?? 0);

  const errors = validateTipInput({
    key: record.key,
    audience,
    digitalEmployeeId: record.digitalEmployeeId,
    triggerKind,
    triggerArea: triggerKind === "action" ? triggerArea : null,
    triggerOp: triggerKind === "action" ? triggerOp : null,
    maxShows,
    order,
    text: record.text,
    enabled: record.enabled,
  });
  if (hasTipFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      compactFieldErrors(errors),
    );
  }

  return normalizeTipInput({
    key: String(record.key),
    audience: audience!,
    digitalEmployeeId:
      typeof record.digitalEmployeeId === "string"
        ? record.digitalEmployeeId
        : null,
    triggerKind: triggerKind!,
    triggerArea: triggerKind === "action" ? triggerArea : null,
    triggerOp: triggerKind === "action" ? (triggerOp ?? "add") : null,
    maxShows,
    order,
    text: String(record.text),
    enabled: record.enabled !== false,
  });
}

export function parseTipUpdateBody(body: unknown): TipUpdateInput {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Tip details are required");
  }
  const record = body as Record<string, unknown>;
  const patch: TipUpdateInput = {};

  if (record.audience !== undefined) {
    const audience = parseTipAudience(record.audience);
    if (!audience) {
      throw new ValidationError("Please correct the highlighted fields", {
        audience: "Audience must be guest, member, or any",
      });
    }
    patch.audience = audience;
  }
  if (record.triggerKind !== undefined) {
    const kind = parseTipTriggerKind(record.triggerKind);
    if (!kind) {
      throw new ValidationError("Please correct the highlighted fields", {
        triggerKind: "Trigger must be action, model, or general",
      });
    }
    patch.triggerKind = kind;
  }
  if (record.triggerArea !== undefined) {
    if (record.triggerArea === null || record.triggerArea === "") {
      patch.triggerArea = null;
    } else {
      const area = parseTipTriggerArea(record.triggerArea);
      if (!area) {
        throw new ValidationError("Please correct the highlighted fields", {
          triggerArea: "Invalid trigger area",
        });
      }
      patch.triggerArea = area;
    }
  }
  if (record.triggerOp !== undefined) {
    if (record.triggerOp === null || record.triggerOp === "") {
      patch.triggerOp = null;
    } else {
      const op = parseTipTriggerOp(record.triggerOp);
      if (!op) {
        throw new ValidationError("Please correct the highlighted fields", {
          triggerOp: "Op must be add, remove, or update",
        });
      }
      patch.triggerOp = op;
    }
  }
  if (record.digitalEmployeeId !== undefined) {
    patch.digitalEmployeeId =
      record.digitalEmployeeId === null || record.digitalEmployeeId === ""
        ? null
        : String(record.digitalEmployeeId);
  }
  if (record.maxShows !== undefined) {
    patch.maxShows =
      typeof record.maxShows === "number"
        ? record.maxShows
        : Number(record.maxShows);
  }
  if (record.order !== undefined) {
    patch.order =
      typeof record.order === "number" ? record.order : Number(record.order);
  }
  if (record.text !== undefined) {
    patch.text = String(record.text);
  }
  if (record.enabled !== undefined) {
    patch.enabled = Boolean(record.enabled);
  }

  const errors = validateTipUpdateInput(patch);
  // Action tips after patch must still have an area (checked in service against merged row too).
  if (
    patch.triggerKind === "action" &&
    patch.triggerArea === undefined &&
    record.triggerArea === undefined
  ) {
    // ok — keep existing area on update
  }
  if (hasTipFieldErrors(errors)) {
    throw new ValidationError(
      "Please correct the highlighted fields",
      compactFieldErrors(errors),
    );
  }

  return normalizeTipUpdateInput({ ...patch });
}
