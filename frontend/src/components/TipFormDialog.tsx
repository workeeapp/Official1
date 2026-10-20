import { FormEvent, useMemo, useState } from "react";
import {
  TIP_AUDIENCES,
  TIP_TRIGGER_AREAS,
  TIP_TRIGGER_KINDS,
  TIP_TRIGGER_OPS,
  hasTipFieldErrors,
  validateTipInput,
  type PublicEmployee,
  type PublicTip,
  type TipAudience,
  type TipInput,
  type TipTriggerArea,
  type TipTriggerKind,
  type TipTriggerOp,
  type TipUpdateInput,
} from "@workee/shared";
import { Button } from "./Button";
import { Input } from "./Input";
import { Textarea } from "./Textarea";

interface TipFormDialogProps {
  mode: "add" | "update";
  tip?: PublicTip | null;
  digitals: PublicEmployee[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: TipInput | TipUpdateInput) => Promise<void>;
}

const selectClass =
  "min-h-11 w-full rounded-xl border border-border bg-surface px-3.5 text-sm text-text-primary shadow-sm transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function TipFormDialog({
  mode,
  tip,
  digitals,
  submitting,
  error,
  onClose,
  onSubmit,
}: TipFormDialogProps) {
  const [key, setKey] = useState(tip?.key ?? "");
  const [audience, setAudience] = useState<TipAudience>(tip?.audience ?? "member");
  const [digitalEmployeeId, setDigitalEmployeeId] = useState(
    tip?.digitalEmployeeId ?? "",
  );
  const [triggerKind, setTriggerKind] = useState<TipTriggerKind>(
    tip?.triggerKind ?? "action",
  );
  const [triggerArea, setTriggerArea] = useState<TipTriggerArea | "">(
    tip?.triggerArea ?? "reminders",
  );
  const [triggerOp, setTriggerOp] = useState<TipTriggerOp>(
    tip?.triggerOp ?? "add",
  );
  const [maxShows, setMaxShows] = useState(String(tip?.maxShows ?? 1));
  const [order, setOrder] = useState(String(tip?.order ?? 0));
  const [text, setText] = useState(tip?.text ?? "");
  const [enabled, setEnabled] = useState(tip?.enabled !== false);
  const [touched, setTouched] = useState(false);

  const fieldErrors = useMemo(() => {
    if (mode === "update") {
      return {};
    }
    return validateTipInput({
      key,
      audience,
      digitalEmployeeId: digitalEmployeeId || null,
      triggerKind,
      triggerArea: triggerKind === "action" ? triggerArea || null : null,
      triggerOp: triggerKind === "action" ? triggerOp : null,
      maxShows: Number(maxShows),
      order: Number(order),
      text,
      enabled,
    });
  }, [
    mode,
    key,
    audience,
    digitalEmployeeId,
    triggerKind,
    triggerArea,
    triggerOp,
    maxShows,
    order,
    text,
    enabled,
  ]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (mode === "add" && hasTipFieldErrors(fieldErrors)) {
      return;
    }
    const maxShowsNum = Number(maxShows);
    const orderNum = Number(order);
    if (
      !Number.isInteger(maxShowsNum) ||
      maxShowsNum < 1 ||
      !Number.isInteger(orderNum) ||
      !text.trim()
    ) {
      return;
    }

    if (mode === "add") {
      await onSubmit({
        key: key.trim(),
        audience,
        digitalEmployeeId: digitalEmployeeId || null,
        triggerKind,
        triggerArea: triggerKind === "action" ? (triggerArea as TipTriggerArea) : null,
        triggerOp: triggerKind === "action" ? triggerOp : null,
        maxShows: maxShowsNum,
        order: orderNum,
        text: text.trim(),
        enabled,
      } satisfies TipInput);
      return;
    }

    await onSubmit({
      audience,
      digitalEmployeeId: digitalEmployeeId || null,
      triggerKind,
      triggerArea: triggerKind === "action" ? (triggerArea as TipTriggerArea) : null,
      triggerOp: triggerKind === "action" ? triggerOp : null,
      maxShows: maxShowsNum,
      order: orderNum,
      text: text.trim(),
      enabled,
    } satisfies TipUpdateInput);
  }

  const title = mode === "add" ? "Add tip" : "Update tip";
  const showErrors = touched;

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tip-dialog-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="tip-dialog-title"
          className="text-lg font-semibold text-text-primary"
        >
          {title}
        </h2>

        <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <Input
            name="tip-key"
            label="Key"
            value={key}
            disabled={mode === "update"}
            error={showErrors ? fieldErrors.key : undefined}
            onChange={(event) => setKey(event.target.value)}
          />

          <div className="flex w-full flex-col gap-1.5">
            <label htmlFor="tip-audience" className="text-sm font-medium text-text-primary">
              Audience
            </label>
            <select
              id="tip-audience"
              className={selectClass}
              value={audience}
              onChange={(event) => setAudience(event.target.value as TipAudience)}
            >
              {TIP_AUDIENCES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="flex w-full flex-col gap-1.5">
            <label htmlFor="tip-digital" className="text-sm font-medium text-text-primary">
              Digital employee
            </label>
            <select
              id="tip-digital"
              className={selectClass}
              value={digitalEmployeeId}
              onChange={(event) => setDigitalEmployeeId(event.target.value)}
            >
              <option value="">Any</option>
              {digitals.map((digital) => (
                <option key={digital.id} value={digital.id}>
                  {digital.nickname?.trim() || digital.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex w-full flex-col gap-1.5">
            <label htmlFor="tip-trigger-kind" className="text-sm font-medium text-text-primary">
              Trigger
            </label>
            <select
              id="tip-trigger-kind"
              className={selectClass}
              value={triggerKind}
              onChange={(event) =>
                setTriggerKind(event.target.value as TipTriggerKind)
              }
            >
              {TIP_TRIGGER_KINDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          {triggerKind === "action" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex w-full flex-col gap-1.5">
                <label htmlFor="tip-trigger-area" className="text-sm font-medium text-text-primary">
                  Area
                </label>
                <select
                  id="tip-trigger-area"
                  className={selectClass}
                  value={triggerArea}
                  onChange={(event) =>
                    setTriggerArea(event.target.value as TipTriggerArea)
                  }
                >
                  {TIP_TRIGGER_AREAS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex w-full flex-col gap-1.5">
                <label htmlFor="tip-trigger-op" className="text-sm font-medium text-text-primary">
                  Op
                </label>
                <select
                  id="tip-trigger-op"
                  className={selectClass}
                  value={triggerOp}
                  onChange={(event) =>
                    setTriggerOp(event.target.value as TipTriggerOp)
                  }
                >
                  {TIP_TRIGGER_OPS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              name="tip-max-shows"
              label="Max shows"
              type="number"
              value={maxShows}
              error={
                showErrors && fieldErrors.maxShows
                  ? fieldErrors.maxShows
                  : undefined
              }
              onChange={(event) => setMaxShows(event.target.value)}
            />
            <Input
              name="tip-order"
              label="Order"
              type="number"
              value={order}
              error={
                showErrors && fieldErrors.order ? fieldErrors.order : undefined
              }
              onChange={(event) => setOrder(event.target.value)}
            />
          </div>

          <Textarea
            name="tip-text"
            label="Text"
            value={text}
            error={showErrors ? fieldErrors.text : undefined}
            onChange={(event) => setText(event.target.value)}
            rows={5}
          />

          <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Enabled
          </label>

          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting} className="sm:w-auto">
              {submitting ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
              className="sm:w-auto"
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
