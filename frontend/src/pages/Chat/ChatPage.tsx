import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { chatThreadKey } from "@workee/shared";
import { Button } from "@/components/Button";
import { useChat } from "@/hooks/useChat";
import { useEmployees } from "@/hooks/useEmployees";
import { employeeDisplayName } from "@/services/employee.service";
import { chatDayKey, formatChatDate, formatChatTime } from "./chatTime";

export function ChatPage() {
  const { tableEmployees, digitalEmployees, status } = useEmployees();
  const {
    chatAsId,
    setChatAsId,
    chatWithId,
    setChatWithId,
    threads,
    rawResponses,
    sendingEmployeeId,
    historyLoadingId,
    error,
    send,
    resetConversation,
    stop,
    resetting,
  } = useChat();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatAsId && tableEmployees.length > 0) {
      setChatAsId(tableEmployees[0].id);
    }
  }, [chatAsId, setChatAsId, tableEmployees]);

  useEffect(() => {
    if (!chatWithId && digitalEmployees.length > 0) {
      const preferred =
        digitalEmployees.find((employee) => employee.protected) ?? digitalEmployees[0];
      setChatWithId(preferred.id);
    }
  }, [chatWithId, digitalEmployees]);

  const selectedEmployee =
    tableEmployees.find((employee) => employee.id === chatAsId) ??
    tableEmployees[0];
  const selectedDigital =
    digitalEmployees.find((employee) => employee.id === chatWithId) ??
    digitalEmployees[0];
  const chatWithName = selectedDigital
    ? employeeDisplayName(selectedDigital)
    : "Assistant";
  const threadId =
    selectedEmployee && selectedDigital
      ? chatThreadKey(selectedEmployee.id, selectedDigital.id)
      : "";
  const messages = threadId ? (threads[threadId] ?? []) : [];
  const sending = Boolean(sendingEmployeeId);
  const sendingThisThread = sendingEmployeeId === threadId;
  const loadingHistory = historyLoadingId === threadId;
  const completeResponse = formatCompleteResponse(
    threadId ? rawResponses[threadId] : undefined,
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages, sendingThisThread, threadId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || !selectedEmployee) {
      return;
    }

    setDraft("");
    await send({
      employeeId: selectedEmployee.id,
      speaker: employeeDisplayName(selectedEmployee),
      text,
      digitalEmployeeId: selectedDigital?.id,
      assistantSpeaker: chatWithName,
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section
      data-testid="chat-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
    >
      <div className="shrink-0 border-b border-border px-6 py-5 sm:px-8">
        <h1 className="sr-only">Chat</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="max-w-xs w-full">
            <label
              htmlFor="chat-as"
              className="text-sm font-medium text-text-primary"
            >
              Chat As
            </label>
            <select
              id="chat-as"
              name="chatAs"
              data-testid="chat-as"
              value={chatAsId}
              disabled={status === "loading" || tableEmployees.length === 0 || sending}
              onChange={(event) => setChatAsId(event.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-text-primary shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            >
              {status === "loading" ? (
                <option value="">Loading employees…</option>
              ) : tableEmployees.length === 0 ? (
                <option value="">No employees</option>
              ) : (
                tableEmployees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employeeDisplayName(employee)}
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="max-w-xs w-full">
            <label
              htmlFor="chat-with"
              className="text-sm font-medium text-text-primary"
            >
              Chat With
            </label>
            <select
              id="chat-with"
              name="chatWith"
              data-testid="chat-with"
              value={chatWithId}
              disabled={status === "loading" || digitalEmployees.length === 0 || sending}
              onChange={(event) => setChatWithId(event.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-text-primary shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            >
              {status === "loading" ? (
                <option value="">Loading employees…</option>
              ) : digitalEmployees.length === 0 ? (
                <option value="">No digital employees</option>
              ) : (
                digitalEmployees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employeeDisplayName(employee)}
                  </option>
                ))
              )}
            </select>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="border border-border bg-background text-text-primary hover:bg-primary-light sm:w-auto"
            disabled={!selectedEmployee || sending || resetting || loadingHistory}
            loading={resetting}
            busyLabel="Resetting…"
            onClick={() => void resetConversation()}
          >
            Reset Conversation
          </Button>
        </div>
      </div>

      <div
        ref={listRef}
        data-testid="chat-messages"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-6 py-5 sm:px-8"
      >
        {loadingHistory && messages.length === 0 ? (
          <p
            data-testid="chat-history-loading"
            className="m-auto max-w-sm text-center text-sm text-text-secondary"
          >
            Loading conversation…
          </p>
        ) : messages.length === 0 && !sendingThisThread ? (
          <div
            data-testid="new-conversation"
            className="m-auto max-w-sm rounded-2xl border border-primary/25 bg-primary-light px-5 py-6 text-center"
          >
            <p className="text-sm font-semibold text-primary">New conversation</p>
            <p className="mt-2 text-sm leading-6 text-text-primary">
              This is a new conversation. Previous chat messages are not included.
            </p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              Lists, tasks, and filings will be sent to {chatWithName} with the first
              message.
            </p>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              const previousDay = chatDayKey(messages[index - 1]?.createdAt);
              const currentDay = chatDayKey(message.createdAt);
              const showDate = Boolean(currentDay && currentDay !== previousDay);
              const time = message.createdAt ? formatChatTime(message.createdAt) : "";

              return (
              <div key={message.id} className="flex flex-col gap-3">
                {showDate && message.createdAt ? (
                  <p
                    data-testid="chat-date"
                    className="self-center rounded-full bg-background px-3 py-1 text-xs font-medium text-text-secondary"
                  >
                    {formatChatDate(message.createdAt)}
                  </p>
                ) : null}
              <div
                className={`flex max-w-[85%] flex-col gap-2 ${
                  message.author === "you" ? "self-end" : "self-start"
                }`}
              >
                <div>
                  <p className="mb-1 px-1 text-xs font-medium text-text-secondary">
                    {message.author === "assistant" ? chatWithName : message.speaker}
                  </p>
                  <p
                    className={`rounded-2xl px-3.5 pt-2.5 pb-1.5 text-sm leading-6 ${
                      message.author === "you"
                        ? "bg-primary text-white"
                        : "bg-primary-light text-text-primary"
                    }`}
                  >
                    <span className="block whitespace-pre-wrap">{message.text}</span>
                    {time ? (
                      <span
                        data-testid="chat-time"
                        className={`mt-1 block text-end text-[11px] leading-4 ${
                          message.author === "you"
                            ? "text-white/70"
                            : "text-text-secondary"
                        }`}
                      >
                        {time}
                      </span>
                    ) : null}
                  </p>
                </div>
                {message.actions?.map((action) => (
                  <p
                    key={action}
                    data-testid="chat-action"
                    className="rounded-2xl border border-primary/20 bg-surface px-3.5 py-2.5 text-sm leading-6 text-text-primary"
                  >
                    {action}
                  </p>
                ))}
              </div>
              </div>
              );
            })}
            {sendingThisThread ? (
              <p
                data-testid="chat-pending"
                className="self-start px-1 text-sm text-text-secondary"
              >
                {chatWithName} is typing…
              </p>
            ) : null}
          </>
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="shrink-0 border-t border-border px-6 py-3 text-sm text-red-600 sm:px-8"
        >
          {error}
        </p>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="flex shrink-0 flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-end sm:p-5"
      >
        <label className="sr-only" htmlFor="chat-message">
          Message
        </label>
        <textarea
          id="chat-message"
          name="message"
          rows={2}
          value={draft}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder="Write a message…"
          className="min-h-11 w-full resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-text-primary shadow-sm placeholder:text-text-secondary/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
        />
        {sending ? (
          <Button
            type="button"
            variant="danger"
            className="sm:w-auto"
            onClick={stop}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            className="sm:w-auto"
            disabled={!draft.trim() || !selectedEmployee}
          >
            Send
          </Button>
        )}
      </form>

      <div
        data-testid="llm-complete-response"
        className="min-h-0 shrink-0 border-t border-border bg-background/70 px-4 py-3 sm:px-5"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Complete response
        </p>
        {completeResponse ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 text-xs leading-5 text-text-primary">
            {completeResponse}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            The complete LLM response will appear here after Send.
          </p>
        )}
      </div>
    </section>
  );
}

function formatCompleteResponse(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return "";
  }

  if (typeof raw === "string") {
    return raw;
  }

  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}
