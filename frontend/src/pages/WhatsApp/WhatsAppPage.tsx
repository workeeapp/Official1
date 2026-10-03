import { useCallback, useEffect, useState } from "react";
import type { WhatsAppStatusResponse } from "@workee/shared";
import { Button } from "@/components/Button";
import { whatsappApi } from "@/services/whatsapp.service";
import { ApiError } from "@/types";

function formatWhen(value: string | null): string {
  if (!value) {
    return "none yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function WhatsAppPage() {
  const [status, setStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    setError(null);
    if (!silent) {
      setLoading(true);
    }
    try {
      setStatus(await whatsappApi.status(signal));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "ABORTED") {
        return;
      }
      setError(
        caught instanceof ApiError ? caught.message : "Unable to load WhatsApp status.",
      );
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      void load(undefined, true);
    }, 8000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <section
      data-testid="whatsapp-page"
      className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-primary">WhatsApp</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Channel flow
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary sm:text-base">
            Same path used to find a dead webhook override: Meta callback vs{" "}
            {status?.expectedWebhook ?? "the named tunnel"}, last inbound, then
            send.
          </p>
        </div>
        <Button type="button" className="w-auto" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-error" role="alert">
          {error}
        </p>
      ) : null}

      {status ? (
        <div className="mt-6 space-y-4 text-sm">
          {status.webhookMismatch ? (
            <p
              className="rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-error"
              role="alert"
            >
              Meta still points the WABA or phone webhook away from wa.workee.site.
              Inbound will never reach this API.
            </p>
          ) : null}

          {status.hasAccessToken &&
          !status.metaWabaWebhook &&
          !status.metaAppWebhook ? (
            <p className="rounded-lg border border-border px-3 py-2 text-text-secondary">
              Could not read Meta webhook URLs. Check the system-user token and WABA
              id.
            </p>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-text-secondary">Expected webhook</dt>
              <dd className="mt-1 break-all font-medium text-text-primary">
                {status.expectedWebhook}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Meta WABA override</dt>
              <dd className="mt-1 break-all font-medium text-text-primary">
                {status.metaWabaWebhook ?? "unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Meta phone webhook</dt>
              <dd className="mt-1 break-all font-medium text-text-primary">
                {status.metaAppWebhook ?? "unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Last inbound</dt>
              <dd className="mt-1 font-medium text-text-primary">
                {formatWhen(status.lastInboundAt)}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Access token</dt>
              <dd className="mt-1 font-medium text-text-primary">
                {status.hasAccessToken ? "configured" : "missing"}
              </dd>
            </div>
          </dl>

          <div>
            <h2 className="text-base font-semibold text-text-primary">Flow log</h2>
            {status.events.length === 0 ? (
              <p className="mt-2 text-text-secondary">
                No webhook events since this API process started.
              </p>
            ) : (
              <ol className="mt-3 max-h-[28rem] space-y-2 overflow-auto">
                {status.events.map((event) => (
                  <li
                    key={`${event.at}-${event.step}-${event.detail}`}
                    className="rounded-lg border border-border px-3 py-2"
                  >
                    <p className="font-medium text-text-primary">{event.step}</p>
                    <p className="text-xs text-text-secondary">
                      {formatWhen(event.at)}
                    </p>
                    {event.detail ? (
                      <p className="mt-1 break-all text-text-secondary">{event.detail}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ) : loading ? (
        <p className="mt-6 text-sm text-text-secondary">Loading channel status…</p>
      ) : null}
    </section>
  );
}
