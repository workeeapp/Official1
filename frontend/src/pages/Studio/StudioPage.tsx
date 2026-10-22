import { useCallback, useEffect, useState } from "react";
import {
  studioApi,
  type StudioRunSummary,
  type StudioSafetyReport,
  type StudioTrack,
  type StudioTrackCapabilities,
} from "@/services/studio.service";
import { ApiError } from "@/types";

type TabId = "safety" | "runs" | "drafts" | "cost";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "safety", label: "Safety" },
  { id: "runs", label: "Runs" },
  { id: "drafts", label: "Drafts" },
  { id: "cost", label: "Cost" },
];

function SafetyReportBlock({
  title,
  report,
}: {
  title: string;
  report: StudioSafetyReport | null;
}) {
  if (!report) return null;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <span
          className={`text-xs font-semibold ${
            report.allowed ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {report.allowed ? "allowed" : "blocked"}
        </span>
      </div>
      <ul className="mt-3 space-y-2">
        {report.checks.map((c) => (
          <li key={c.id} className="text-sm text-text-secondary">
            <span
              className={`mr-2 font-semibold ${
                c.ok ? "text-emerald-700" : "text-red-700"
              }`}
            >
              {c.ok ? "OK" : "BLOCK"}
            </span>
            <span className="font-mono text-xs text-text-primary">{c.id}</span>
            <div className="mt-0.5 text-text-secondary">{c.detail}</div>
          </li>
        ))}
      </ul>
      {report.blockers.length > 0 ? (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {report.blockers.join(" · ")}
        </div>
      ) : null}
      {report.notes.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-text-secondary">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function StudioPage() {
  const [tab, setTab] = useState<TabId>("safety");
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<StudioTrackCapabilities[]>([]);
  const [liveFull, setLiveFull] = useState<StudioSafetyReport | null>(null);
  const [liveModel, setLiveModel] = useState<StudioSafetyReport | null>(null);
  const [writeNote, setWriteNote] = useState("");
  const [isolationPolicy, setIsolationPolicy] = useState("");
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<Record<string, unknown> | null>(
    null,
  );
  const [drafts, setDrafts] = useState<Array<{ id: string; path: string }>>([]);
  const [casePreview, setCasePreview] = useState<{
    track: StudioTrack;
    count: number;
  } | null>(null);

  const loadSafety = useCallback(async () => {
    setError(null);
    try {
      const [t, s] = await Promise.all([
        studioApi.tracks(),
        studioApi.safety(),
      ]);
      setTracks(t.tracks);
      setLiveFull(s.liveFull);
      setLiveModel(s.liveModel);
      setWriteNote(s.writeTracksNote);
      setIsolationPolicy(s.isolationPolicy);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load safety");
    }
  }, []);

  const loadRuns = useCallback(async () => {
    setError(null);
    try {
      const res = await studioApi.runs();
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load runs");
    }
  }, []);

  const loadDrafts = useCallback(async () => {
    setError(null);
    try {
      const [d, cases] = await Promise.all([
        studioApi.drafts(),
        studioApi.cases("LIVE_MODEL"),
      ]);
      setDrafts(d.drafts);
      setCasePreview({ track: "LIVE_MODEL", count: cases.count });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load drafts");
    }
  }, []);

  useEffect(() => {
    if (tab === "safety") void loadSafety();
    if (tab === "runs") void loadRuns();
    if (tab === "drafts") void loadDrafts();
  }, [tab, loadSafety, loadRuns, loadDrafts]);

  async function openRun(id: string) {
    setError(null);
    try {
      const res = await studioApi.run(id);
      setSelectedRun(res.run);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load run");
    }
  }

  return (
    <section
      data-testid="studio-page"
      className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
    >
      <p className="text-sm font-medium text-primary">Test Studio</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
        QA operations
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary sm:text-base">
        Layered eval visibility. Write-capable tracks are server-blocked until
        isolation is proven. LIVE_MODEL runs stay disabled unless explicitly
        allowed. Selecting Lucy2 in Chat does not change eval prompt provenance.
      </p>

      <div className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`studio-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`min-h-11 px-3 text-sm font-semibold ${
              tab === t.id
                ? "border-b-2 border-primary text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {tab === "safety" ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {writeNote ||
              "ENGINE / MODEL_APPLY / LIVE_FULL are not exposed via Studio run-start in Phase A."}
          </div>
          {isolationPolicy ? (
            <p className="text-sm text-text-secondary">{isolationPolicy}</p>
          ) : null}
          <SafetyReportBlock
            title="LIVE_FULL isolation probe"
            report={liveFull}
          />
          <SafetyReportBlock
            title="LIVE_MODEL / MT Studio opt-in"
            report={liveModel}
          />
          <div className="rounded-xl border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-text-primary">
              Track capabilities
            </h3>
            <ul className="mt-3 space-y-3">
              {tracks.map((t) => (
                <li key={t.track} className="text-sm text-text-secondary">
                  <div className="font-semibold text-text-primary">
                    {t.track}{" "}
                    <span className="font-normal text-text-secondary">
                      — {t.label}
                    </span>
                  </div>
                  <div className="mt-1 text-xs">
                    executable:{" "}
                    <span
                      className={
                        t.executable ? "text-emerald-700" : "text-red-700"
                      }
                    >
                      {String(t.executable)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs">
                    does not prove: {t.doesNotProve.join(", ")}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {tab === "runs" ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-text-secondary">
            Run start is server-gated. Phase A does not start live evaluations
            from this UI without separate opt-in; use history for prior
            artifacts.
          </p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted/40 text-xs uppercase text-text-secondary">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Track</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Apply</th>
                  <th className="px-3 py-2">Prompt</th>
                  <th className="px-3 py-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-4 text-text-secondary"
                    >
                      No Studio runs recorded yet.
                    </td>
                  </tr>
                ) : (
                  runs.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-b border-border hover:bg-surface-muted/30"
                      onClick={() => void openRun(r.id)}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.createdAt}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.track}</td>
                      <td className="px-3 py-2">{r.status}</td>
                      <td className="px-3 py-2">
                        {r.productionApply ? "yes" : "no"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.promptSource ?? "—"}
                        {(() => {
                          // Prefer final-instructions identity; fall back to legacy systemMessage hash.
                          const displayHash = r.instructionsSha256
                            ? r.instructionsSha256.slice(0, 16)
                            : r.promptHash;
                          return displayHash ? (
                            <span className="ml-1 font-mono text-text-secondary">
                              #{displayHash}
                            </span>
                          ) : null;
                        })()}
                      </td>
                      <td className="px-3 py-2">
                        {r.summary
                          ? `${r.summary.passed}/${r.summary.total}`
                          : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {selectedRun ? (
            <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-surface-muted/20 p-3 text-xs text-text-primary">
              {JSON.stringify(selectedRun, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {tab === "drafts" ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary">
            Drafts live under <code>docs/qa/studio/drafts/</code> and are{" "}
            <strong className="text-text-primary">not</strong> CI until promote
            with <code>confirmPromote: true</code>. Approved corpora:{" "}
            <code>phase-4-corpus.json</code>,{" "}
            <code>phase-4-multi-turn-corpus.json</code>,{" "}
            <code>live-full-corpus.json</code>,{" "}
            <code>regression-suite.json</code>.
          </div>
          {casePreview ? (
            <p className="text-sm text-text-secondary">
              Committed {casePreview.track} cases visible to Studio:{" "}
              {casePreview.count}
            </p>
          ) : null}
          <ul className="space-y-2 text-sm">
            {drafts.length === 0 ? (
              <li className="text-text-secondary">No draft files found.</li>
            ) : (
              drafts.map((d) => (
                <li key={d.id} className="rounded-lg border border-border px-3 py-2">
                  <span className="font-semibold text-text-primary">{d.id}</span>
                  <div className="font-mono text-xs text-text-secondary">
                    {d.path}
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      {tab === "cost" ? (
        <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-secondary">
          Cost visibility is Phase B: eval model spend and Judge spend will
          appear here separately from product Employees usage. Placeholder only.
        </div>
      ) : null}
    </section>
  );
}
