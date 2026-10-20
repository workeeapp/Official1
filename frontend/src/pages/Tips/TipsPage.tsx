import { useCallback, useEffect, useState } from "react";
import type {
  PublicEmployee,
  PublicTip,
  TipInput,
  TipUpdateInput,
} from "@workee/shared";
import { digitalEmployees } from "@workee/shared";
import {
  IconButton,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/IconButton";
import { TipFormDialog } from "@/components/TipFormDialog";
import { employeeApi } from "@/services/employee.service";
import { tipsApi } from "@/services/tips.service";
import { ApiError } from "@/types";

type DialogMode = "add" | "update" | null;

function triggerSummary(tip: PublicTip): string {
  const ladder = [tip.topic, tip.tier].filter(Boolean).join("/");
  if (tip.triggerKind === "general") {
    return ladder ? `general · ${ladder}` : "general";
  }
  if (tip.triggerKind === "model") {
    return ladder ? `model · ${ladder}` : "model";
  }
  const listBit =
    tip.triggerArea === "lists" && tip.listType && tip.listType !== tip.topic
      ? tip.listType
      : tip.triggerArea === "lists" && tip.listType && !tip.topic
        ? tip.listType
        : null;
  const actionParts = [
    tip.triggerArea ?? "?",
    tip.triggerOp ?? "add",
    listBit,
  ].filter(Boolean);
  const action = `action ${actionParts.join("/")}`;
  return ladder ? `${action} · ${ladder}` : action;
}

function truncate(text: string, max = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

export function TipsPage() {
  const [tips, setTips] = useState<PublicTip[]>([]);
  const [digitals, setDigitals] = useState<PublicEmployee[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedTip = tips.find((tip) => tip.id === selectedId) ?? null;

  const reload = useCallback(async () => {
    const [{ tips: nextTips }, { employees }] = await Promise.all([
      tipsApi.list(),
      employeeApi.list(),
    ]);
    setTips(nextTips);
    setDigitals(digitalEmployees(employees));
    setStatus("ready");
    setError(null);
    if (selectedId && !nextTips.some((tip) => tip.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    tipsApi
      .list()
      .then(async ({ tips: nextTips }) => {
        const { employees } = await employeeApi.list();
        if (cancelled) {
          return;
        }
        setTips(nextTips);
        setDigitals(digitalEmployees(employees));
        setStatus("ready");
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setError(
          caught instanceof ApiError ? caught.message : "Unable to load tips.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openAdd() {
    setFormError(null);
    setActionError(null);
    setDialogMode("add");
  }

  function openUpdate() {
    if (!selectedTip) {
      setActionError("Select a tip to update.");
      return;
    }
    setFormError(null);
    setActionError(null);
    setDialogMode("update");
  }

  async function handleDelete() {
    if (!selectedTip) {
      setActionError("Select a tip to delete.");
      return;
    }
    const confirmed = window.confirm(`Delete tip «${selectedTip.key}»?`);
    if (!confirmed) {
      return;
    }
    setActionError(null);
    try {
      await tipsApi.remove(selectedTip.id);
      setSelectedId(null);
      await reload();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError ? caught.message : "Unable to delete tip.",
      );
    }
  }

  async function handleSubmit(input: TipInput | TipUpdateInput) {
    setSubmitting(true);
    setFormError(null);
    try {
      if (dialogMode === "add") {
        await tipsApi.create(input as TipInput);
      } else if (dialogMode === "update" && selectedTip) {
        await tipsApi.update(selectedTip.id, input as TipUpdateInput);
      }
      setDialogMode(null);
      await reload();
    } catch (caught) {
      setFormError(
        caught instanceof ApiError ? caught.message : "Unable to save tip.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section
        data-testid="tips-page"
        className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-primary">Tips</p>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">
              Contextual tips
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Tips the digital workers may append after a reply (once or up to
              max shows).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-text-secondary">
              {status === "loading"
                ? "Loading…"
                : `${tips.length} ${tips.length === 1 ? "tip" : "tips"}`}
            </p>
            <div className="flex items-center rounded-xl border border-border bg-background p-0.5">
              <IconButton label="Add tip" onClick={openAdd}>
                <PlusIcon />
              </IconButton>
              <IconButton
                label="Update tip"
                onClick={openUpdate}
                disabled={!selectedTip}
              >
                <PencilIcon />
              </IconButton>
              <IconButton
                label="Delete tip"
                onClick={() => void handleDelete()}
                disabled={!selectedTip}
              >
                <TrashIcon />
              </IconButton>
            </div>
          </div>
        </div>

        {status === "error" ? (
          <p role="alert" className="mt-4 text-sm text-error">
            {error}
          </p>
        ) : null}

        {actionError ? (
          <p role="alert" className="mt-4 text-sm text-error">
            {actionError}
          </p>
        ) : null}

        {status === "ready" && tips.length === 0 ? (
          <p className="mt-4 text-sm text-text-secondary">No tips yet.</p>
        ) : null}

        {tips.length > 0 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-start text-sm">
              <thead>
                <tr className="border-b border-border text-text-secondary">
                  <th className="px-2 py-2 font-medium">Key</th>
                  <th className="px-2 py-2 font-medium">Audience</th>
                  <th className="px-2 py-2 font-medium">Digital</th>
                  <th className="px-2 py-2 font-medium">Trigger</th>
                  <th className="px-2 py-2 font-medium">Max</th>
                  <th className="px-2 py-2 font-medium">Order</th>
                  <th className="px-2 py-2 font-medium">On</th>
                  <th className="px-2 py-2 font-medium">Text</th>
                </tr>
              </thead>
              <tbody>
                {tips.map((tip) => {
                  const selected = tip.id === selectedId;
                  return (
                    <tr
                      key={tip.id}
                      data-testid={`tip-row-${tip.key}`}
                      className={`cursor-pointer border-b border-border/70 ${
                        selected ? "bg-primary-light/40" : "hover:bg-background"
                      }`}
                      onClick={() => {
                        setSelectedId(tip.id);
                        setActionError(null);
                      }}
                    >
                      <td className="px-2 py-2 font-medium text-text-primary">
                        {tip.key}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {tip.audience}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {tip.digitalName ?? "Any"}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {triggerSummary(tip)}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {tip.maxShows}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {tip.order}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {tip.enabled ? "yes" : "no"}
                      </td>
                      <td className="px-2 py-2 text-text-secondary">
                        {truncate(tip.text)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {dialogMode ? (
        <TipFormDialog
          mode={dialogMode}
          tip={dialogMode === "update" ? selectedTip : null}
          digitals={digitals}
          submitting={submitting}
          error={formError}
          onClose={() => setDialogMode(null)}
          onSubmit={handleSubmit}
        />
      ) : null}
    </>
  );
}
