import type { WhatsAppStatusResponse } from "@workee/shared";

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

interface WhatsAppChannelPanelProps {
  status: WhatsAppStatusResponse | null;
  error: string | null;
  loading: boolean;
}

/** Channel diagnostics previously on /whatsapp — now Admin-only ops. */
export function WhatsAppChannelPanel({
  status,
  error,
  loading,
}: WhatsAppChannelPanelProps) {
  return (
    <section
      data-testid="admin-whatsapp-channel"
      className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
    >
      <h2 className="text-lg font-semibold text-text-primary">
        WhatsApp channel
      </h2>
      <p className="mt-1 text-sm text-text-secondary">
        Meta callback vs {status?.expectedWebhook ?? "the named tunnel"}, last
        inbound, then send — same path used to find a dead webhook override.
      </p>

      {error ? (
        <p className="mt-4 text-sm text-error" role="alert">
          {error}
        </p>
      ) : null}

      {status ? (
        <div className="mt-4 space-y-4 text-sm">
          {status.webhookMismatch ? (
            <p
              className="rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-error"
              role="alert"
            >
              Meta still points the WABA or phone webhook away from
              wa.workee.site. Inbound will never reach this API.
            </p>
          ) : null}

          {status.hasAccessToken &&
          !status.metaWabaWebhook &&
          !status.metaAppWebhook ? (
            <p className="rounded-lg border border-border px-3 py-2 text-text-secondary">
              Could not read Meta webhook URLs. Check the system-user token and
              WABA id.
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
            <h3 className="text-base font-semibold text-text-primary">
              Flow log
            </h3>
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
                    <p className="font-medium text-text-primary">
                      {event.step}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {formatWhen(event.at)}
                    </p>
                    {event.detail ? (
                      <p className="mt-1 break-all text-text-secondary">
                        {event.detail}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ) : loading ? (
        <p className="mt-4 text-sm text-text-secondary">
          Loading channel status…
        </p>
      ) : null}
    </section>
  );
}
