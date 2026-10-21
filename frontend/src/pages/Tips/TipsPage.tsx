import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  PublicEmployee,
  PublicTip,
  TipInput,
  TipUpdateInput,
} from "@workee/shared";
import {
  TIP_AUDIENCES,
  TIP_TIERS,
  TIP_TOPICS,
  TIP_TRIGGER_AREAS,
  TIP_TRIGGER_KINDS,
  TIP_TRIGGER_OPS,
  digitalEmployees,
} from "@workee/shared";
import {
  IconButton,
  PencilIcon,
  PlusIcon,
  SendIcon,
  TrashIcon,
} from "@/components/IconButton";
import { TipFormDialog } from "@/components/TipFormDialog";
import { employeeApi } from "@/services/employee.service";
import { tipsApi } from "@/services/tips.service";
import { ApiError } from "@/types";

type DialogMode = "add" | "update" | null;

const PAGE_SIZES = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];

const filterSelectClass =
  "min-h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-text-primary shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

const filterInputClass =
  "min-h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-text-primary shadow-sm placeholder:text-text-secondary/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

interface TipFilters {
  search: string;
  audience: string;
  digitalEmployeeId: string;
  triggerKind: string;
  triggerArea: string;
  triggerOp: string;
  tier: string;
  topic: string;
  listType: string;
  unlockAfterKey: string;
  systemSeed: string;
  maxShows: string;
  order: string;
  enabled: string;
}

const EMPTY_FILTERS: TipFilters = {
  search: "",
  audience: "",
  digitalEmployeeId: "",
  triggerKind: "",
  triggerArea: "",
  triggerOp: "",
  tier: "",
  topic: "",
  listType: "",
  unlockAfterKey: "",
  systemSeed: "",
  maxShows: "",
  order: "",
  enabled: "",
};

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

function matchesSearch(tip: PublicTip, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const haystack = [
    tip.key,
    tip.text,
    tip.unlockAfterKey ?? "",
    tip.listType ?? "",
    tip.digitalName ?? "",
    tip.audience,
    tip.triggerKind,
    tip.triggerArea ?? "",
    tip.triggerOp ?? "",
    tip.tier,
    tip.topic ?? "",
    tip.order,
    tip.maxShows,
    triggerSummary(tip),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function tipMatchesFilters(tip: PublicTip, filters: TipFilters): boolean {
  if (!matchesSearch(tip, filters.search)) {
    return false;
  }
  if (filters.audience && tip.audience !== filters.audience) {
    return false;
  }
  if (filters.digitalEmployeeId === "__any__") {
    if (tip.digitalEmployeeId != null) {
      return false;
    }
  } else if (
    filters.digitalEmployeeId &&
    tip.digitalEmployeeId !== filters.digitalEmployeeId
  ) {
    return false;
  }
  if (filters.triggerKind && tip.triggerKind !== filters.triggerKind) {
    return false;
  }
  if (filters.triggerArea && tip.triggerArea !== filters.triggerArea) {
    return false;
  }
  if (filters.triggerOp && tip.triggerOp !== filters.triggerOp) {
    return false;
  }
  if (filters.tier && tip.tier !== filters.tier) {
    return false;
  }
  if (filters.topic && tip.topic !== filters.topic) {
    return false;
  }
  if (filters.listType.trim()) {
    const needle = filters.listType.trim().toLowerCase();
    if (!(tip.listType ?? "").toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (filters.unlockAfterKey.trim()) {
    const needle = filters.unlockAfterKey.trim().toLowerCase();
    if (!(tip.unlockAfterKey ?? "").toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (filters.systemSeed === "yes" && !tip.systemSeed) {
    return false;
  }
  if (filters.systemSeed === "no" && tip.systemSeed) {
    return false;
  }
  if (filters.maxShows.trim() !== "") {
    const n = Number(filters.maxShows);
    if (!Number.isFinite(n) || tip.maxShows !== n) {
      return false;
    }
  }
  if (filters.order.trim() !== "") {
    const n = Number(filters.order);
    if (!Number.isFinite(n) || tip.order !== n) {
      return false;
    }
  }
  if (filters.enabled === "yes" && !tip.enabled) {
    return false;
  }
  if (filters.enabled === "no" && tip.enabled) {
    return false;
  }
  return true;
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-[8.5rem] flex-1 flex-col gap-1 text-xs font-medium text-text-secondary">
      <span>{label}</span>
      {children}
    </label>
  );
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
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [filters, setFilters] = useState<TipFilters>(EMPTY_FILTERS);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [page, setPage] = useState(1);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const selectedTip = tips.find((tip) => tip.id === selectedId) ?? null;

  const filteredTips = useMemo(
    () => tips.filter((tip) => tipMatchesFilters(tip, filters)),
    [tips, filters],
  );

  const totalPages = Math.max(1, Math.ceil(filteredTips.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = filteredTips.length === 0 ? 0 : (currentPage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredTips.length);
  const pageTips = filteredTips.slice(pageStart, pageEnd);

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

  function patchFilter<K extends keyof TipFilters>(key: K, value: TipFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  function openAdd() {
    setFormError(null);
    setActionError(null);
    setActionInfo(null);
    setDialogMode("add");
  }

  function openUpdate() {
    if (!selectedTip) {
      setActionError("Select a tip to update.");
      return;
    }
    setFormError(null);
    setActionError(null);
    setActionInfo(null);
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
    setActionInfo(null);
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

  async function handleSend(tip: PublicTip) {
    setActionError(null);
    setActionInfo(null);
    setSendingId(tip.id);
    try {
      await tipsApi.send(tip.id);
      setActionInfo(`Sent «${tip.key}» to preview phone.`);
    } catch (caught) {
      setActionError(
        caught instanceof ApiError ? caught.message : "Unable to send tip.",
      );
    } finally {
      setSendingId(null);
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

  const listTypeOptions = useMemo(() => {
    const values = new Set<string>();
    for (const tip of tips) {
      if (tip.listType) {
        values.add(tip.listType);
      }
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [tips]);

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
                : `${filteredTips.length} of ${tips.length} ${
                    tips.length === 1 ? "tip" : "tips"
                  }`}
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

        {actionInfo ? (
          <p role="status" className="mt-4 text-sm text-primary">
            {actionInfo}
          </p>
        ) : null}

        {status === "ready" ? (
          <div className="mt-5 space-y-3 rounded-xl border border-border bg-background/60 p-3 sm:p-4">
            <div className="flex flex-wrap gap-3">
              <FilterField label="Search">
                <input
                  type="search"
                  value={filters.search}
                  onChange={(e) => patchFilter("search", e.target.value)}
                  placeholder="key, text, topic…"
                  className={`${filterInputClass} min-w-[12rem]`}
                  data-testid="tips-search"
                />
              </FilterField>
              <FilterField label="Audience">
                <select
                  value={filters.audience}
                  onChange={(e) => patchFilter("audience", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  {TIP_AUDIENCES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Digital">
                <select
                  value={filters.digitalEmployeeId}
                  onChange={(e) =>
                    patchFilter("digitalEmployeeId", e.target.value)
                  }
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  <option value="__any__">Any digital (null)</option>
                  {digitals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.nickname?.trim() || d.name}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Trigger kind">
                <select
                  value={filters.triggerKind}
                  onChange={(e) => patchFilter("triggerKind", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  {TIP_TRIGGER_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Trigger area">
                <select
                  value={filters.triggerArea}
                  onChange={(e) => patchFilter("triggerArea", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  {TIP_TRIGGER_AREAS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Trigger op">
                <select
                  value={filters.triggerOp}
                  onChange={(e) => patchFilter("triggerOp", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  {TIP_TRIGGER_OPS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Tier">
                <select
                  value={filters.tier}
                  onChange={(e) => patchFilter("tier", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  {TIP_TIERS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Topic">
                <select
                  value={filters.topic}
                  onChange={(e) => patchFilter("topic", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  {TIP_TOPICS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="List type">
                <input
                  list="tips-list-type-options"
                  value={filters.listType}
                  onChange={(e) => patchFilter("listType", e.target.value)}
                  placeholder="shopping…"
                  className={filterInputClass}
                />
                <datalist id="tips-list-type-options">
                  {listTypeOptions.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </FilterField>
              <FilterField label="Unlock after key">
                <input
                  value={filters.unlockAfterKey}
                  onChange={(e) =>
                    patchFilter("unlockAfterKey", e.target.value)
                  }
                  placeholder="key…"
                  className={filterInputClass}
                />
              </FilterField>
              <FilterField label="System seed">
                <select
                  value={filters.systemSeed}
                  onChange={(e) => patchFilter("systemSeed", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </FilterField>
              <FilterField label="Max shows">
                <input
                  type="number"
                  inputMode="numeric"
                  value={filters.maxShows}
                  onChange={(e) => patchFilter("maxShows", e.target.value)}
                  placeholder="any"
                  className={filterInputClass}
                />
              </FilterField>
              <FilterField label="Order">
                <input
                  type="number"
                  inputMode="numeric"
                  value={filters.order}
                  onChange={(e) => patchFilter("order", e.target.value)}
                  placeholder="any"
                  className={filterInputClass}
                />
              </FilterField>
              <FilterField label="Enabled">
                <select
                  value={filters.enabled}
                  onChange={(e) => patchFilter("enabled", e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="">Any</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </FilterField>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                className="text-sm font-medium text-primary hover:underline"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setPage(1);
                }}
              >
                Clear filters
              </button>
              <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
                <label className="flex items-center gap-2">
                  <span>Per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value) as PageSize);
                      setPage(1);
                    }}
                    className={filterSelectClass}
                    data-testid="tips-page-size"
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <span data-testid="tips-page-range">
                  {filteredTips.length === 0
                    ? "0–0 of 0"
                    : `${pageStart + 1}–${pageEnd} of ${filteredTips.length}`}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="min-h-9 rounded-lg border border-border px-3 disabled:opacity-40"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <span className="px-1">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="min-h-9 rounded-lg border border-border px-3 disabled:opacity-40"
                    disabled={currentPage >= totalPages}
                    onClick={() =>
                      setPage((p) => Math.min(totalPages, p + 1))
                    }
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {status === "ready" && tips.length === 0 ? (
          <p className="mt-4 text-sm text-text-secondary">No tips yet.</p>
        ) : null}

        {status === "ready" && tips.length > 0 && filteredTips.length === 0 ? (
          <p className="mt-4 text-sm text-text-secondary">
            No tips match the current filters.
          </p>
        ) : null}

        {pageTips.length > 0 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-start text-sm">
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
                  <th className="px-2 py-2 font-medium">Send</th>
                </tr>
              </thead>
              <tbody>
                {pageTips.map((tip) => {
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
                        setActionInfo(null);
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
                      <td className="px-2 py-2">
                        <IconButton
                          label={`Send tip ${tip.key}`}
                          disabled={sendingId === tip.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleSend(tip);
                          }}
                        >
                          <SendIcon />
                        </IconButton>
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
