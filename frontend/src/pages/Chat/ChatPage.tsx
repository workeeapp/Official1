import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { chatThreadKey, isGuestEmployee, wazeNavigateUrl } from "@workee/shared";
import { Button } from "@/components/Button";
import { WazeIcon } from "@/components/WazeIcon";
import { useChat } from "@/hooks/useChat";
import { useEmployees } from "@/hooks/useEmployees";
import { attachmentApi } from "@/services/attachment.service";
import { employeeDisplayName } from "@/services/employee.service";
import { ChatAttachments } from "./ChatAttachments";
import {
  chatDayKey,
  formatChatDate,
  formatChatTime,
  formatDurationMs,
  sortChatMessages,
} from "./chatTime";
import { renderChatText } from "./formatChatText";

export function ChatPage() {
  const { chatAsEmployees, digitalEmployees, status } = useEmployees();
  const {
    chatAsId,
    setChatAsId,
    chatWithId,
    setChatWithId,
    threads,
    rawResponses,
    rawRequests,
    sendingEmployeeId,
    historyLoadingId,
    error,
    send,
    resetConversation,
    stop,
    resetting,
  } = useChat();
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const keepComposerFocusRef = useRef(false);
  const pinToBottomRef = useRef(true);

  useEffect(() => {
    if (!chatAsId && chatAsEmployees.length > 0) {
      setChatAsId(chatAsEmployees[0].id);
    }
  }, [chatAsId, setChatAsId, chatAsEmployees]);

  useEffect(() => {
    if (!chatWithId && digitalEmployees.length > 0) {
      const preferred =
        digitalEmployees.find((employee) => employee.protected) ?? digitalEmployees[0];
      setChatWithId(preferred.id);
    }
  }, [chatWithId, digitalEmployees]);

  const selectedEmployee =
    chatAsEmployees.find((employee) => employee.id === chatAsId) ??
    chatAsEmployees[0];
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
  const messages = sortChatMessages(threadId ? (threads[threadId] ?? []) : []);
  const sending = Boolean(sendingEmployeeId);
  const sendingThisThread = sendingEmployeeId === threadId;
  const loadingHistory = historyLoadingId === threadId;
  const completeResponse = formatCompletePayload(
    threadId ? rawResponses[threadId] : undefined,
  );
  const completeRequest = formatCompletePayload(
    threadId ? rawRequests[threadId] : undefined,
  );
  const lastMessageId = messages.at(-1)?.id ?? "";
  const messageCount = messages.length;

  useEffect(() => {
    pinToBottomRef.current = true;
  }, [threadId]);

  useEffect(() => {
    if (sendingThisThread) {
      pinToBottomRef.current = true;
    }
    if (!pinToBottomRef.current) {
      return;
    }

    const list = listRef.current;
    if (!list) {
      return;
    }
    if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }, [lastMessageId, messageCount, sendingThisThread, threadId]);

  useEffect(() => {
    if (keepComposerFocusRef.current) {
      composerRef.current?.focus();
    }
  });

  function handleMessagesScroll() {
    const list = listRef.current;
    if (!list) {
      return;
    }

    pinToBottomRef.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <= 96;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && pendingFiles.length === 0) || sending || !selectedEmployee) {
      return;
    }

    setDraft("");
    const files = pendingFiles;
    setPendingFiles([]);
    setAttachError(null);
    await sendText(text || "📎", files);
  }

  async function sendText(text: string, files: File[] = []) {
    if ((!text && files.length === 0) || sending || !selectedEmployee) {
      return;
    }

    keepComposerFocusRef.current = true;
    composerRef.current?.focus();
    let attachmentIds: string[] | undefined;
    if (files.length > 0) {
      try {
        const uploaded = await Promise.all(
          files.slice(0, 5).map((file) =>
            attachmentApi.upload({
              employeeId: selectedEmployee.id,
              file,
            }),
          ),
        );
        attachmentIds = uploaded.map((row) => row.id);
      } catch {
        setAttachError("לא הצלחתי להעלות את הקובץ. נסה שוב.");
        keepComposerFocusRef.current = false;
        return;
      }
    }
    await send({
      employeeId: selectedEmployee.id,
      speaker: employeeDisplayName(selectedEmployee),
      text: text || "📎",
      digitalEmployeeId: selectedDigital?.id,
      assistantSpeaker: chatWithName,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
    });
    keepComposerFocusRef.current = false;
    composerRef.current?.focus();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section data-testid="chat-page" className="flex flex-col gap-6">
      <div
        data-testid="chat-dialog"
        className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
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
              disabled={status === "loading" || chatAsEmployees.length === 0 || sending}
              onChange={(event) => setChatAsId(event.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-text-primary shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            >
              {status === "loading" ? (
                <option value="">Loading employees…</option>
              ) : chatAsEmployees.length === 0 ? (
                <option value="">No employees</option>
              ) : (
                chatAsEmployees.map((employee) => {
                  const guest = isGuestEmployee(employee);
                  return (
                    <option
                      key={employee.id}
                      value={employee.id}
                      className={guest ? "font-bold" : undefined}
                      style={guest ? { fontWeight: 700 } : undefined}
                    >
                      {guest
                        ? `אורח — ${employee.phone?.trim() || employeeDisplayName(employee)}`
                        : employeeDisplayName(employee)}
                    </option>
                  );
                })
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
        onScroll={handleMessagesScroll}
        className="flex h-[22.5rem] shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain px-6 py-1 sm:px-8"
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
                  <div
                    className={`relative ${
                      message.author === "you" && message.showIcon ? "mb-3" : ""
                    }`}
                  >
                  <p
                    className={`rounded-2xl px-3.5 pt-2.5 pb-1.5 text-sm leading-6 ${
                      message.author === "you"
                        ? "bg-primary text-white"
                        : "bg-primary-light text-text-primary"
                    }`}
                  >
                    <span className="block whitespace-pre-wrap" dir="auto">
                      {renderChatText(message.text)}
                    </span>
                    {time ||
                    message.llmMs != null ||
                    message.afterLlmMs != null ? (
                      <span
                        className={`mt-1 flex items-baseline justify-between gap-2 text-[11px] leading-4 ${
                          message.author === "you"
                            ? "text-white/70"
                            : "text-text-secondary"
                        }`}
                      >
                        {message.author === "assistant" &&
                        (message.llmMs != null || message.afterLlmMs != null) ? (
                          <span data-testid="chat-llm-timing">
                            {[
                              message.llmMs != null
                                ? `LLM ${formatDurationMs(message.llmMs)}`
                                : "",
                              message.afterLlmMs != null
                                ? `שרת ${formatDurationMs(message.afterLlmMs)}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : (
                          <span />
                        )}
                        {time ? (
                          <span data-testid="chat-time">{time}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </p>
                  {message.author === "you" && message.showIcon ? (
                    <span
                      data-testid="chat-show-icon"
                      aria-hidden="true"
                      className="absolute -bottom-2 end-2 flex h-7 min-w-7 items-center justify-center rounded-full border border-border bg-surface px-1 text-base leading-none shadow-sm"
                    >
                      {message.showIcon}
                    </span>
                  ) : null}
                  </div>
                  {message.attachments?.length ? (
                    <ChatAttachments attachments={message.attachments} />
                  ) : null}
                  {message.author === "assistant" &&
                  (message.buttons?.length || message.navigateAddress) ? (
                    <div
                      data-testid="chat-reply-buttons"
                      className="mt-2 flex flex-wrap gap-2"
                    >
                      {message.navigateAddress ? (
                        <a
                          data-testid="chat-waze-button"
                          href={wazeNavigateUrl(message.navigateAddress)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="נווט עם Waze"
                          title={message.navigateAddress}
                          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-primary/40 bg-surface px-3 shadow-sm transition-colors hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/20"
                        >
                          <WazeIcon />
                        </a>
                      ) : null}
                      {(message.buttons ?? []).map((button) => (
                        <button
                          key={button.command}
                          type="button"
                          dir="auto"
                          title={button.command}
                          disabled={sending || !selectedEmployee}
                          onClick={() => void sendText(button.command)}
                          className="min-h-11 rounded-xl border border-primary/40 bg-surface px-4 text-sm font-medium text-primary shadow-sm transition-colors hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                        >
                          {button.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
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
        <div className="flex w-full flex-col gap-2">
          {pendingFiles.length > 0 ? (
            <p className="text-xs text-text-secondary" data-testid="chat-pending-files">
              {pendingFiles.map((f) => f.name).join(", ")}
              <button
                type="button"
                className="ms-2 text-primary underline"
                onClick={() => setPendingFiles([])}
              >
                הסר
              </button>
            </p>
          ) : null}
          {attachError ? (
            <p role="alert" className="text-xs text-red-600">
              {attachError}
            </p>
          ) : null}
          <textarea
            ref={composerRef}
            id="chat-message"
            name="message"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Write a message…"
            dir="auto"
            className="min-h-11 w-full resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-text-primary shadow-sm placeholder:text-text-secondary/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt"
          onChange={(event) => {
            const list = event.target.files;
            if (!list?.length) return;
            setPendingFiles((prev) => [...prev, ...Array.from(list)].slice(0, 5));
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="ghost"
          className="sm:w-auto"
          disabled={sending || !selectedEmployee}
          onClick={() => fileInputRef.current?.click()}
        >
          קובץ
        </Button>
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
            disabled={
              (!draft.trim() && pendingFiles.length === 0) || !selectedEmployee
            }
          >
            Send
          </Button>
        )}
      </form>
      </div>

      <div
        data-testid="llm-complete-response"
        className="rounded-2xl border border-border bg-surface px-4 py-4 shadow-sm sm:px-5"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Complete response
        </p>
        {completeResponse ? (
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-3 text-xs leading-5 text-text-primary">
            {completeResponse}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            The complete LLM response will appear here after Send.
          </p>
        )}
      </div>

      <div
        data-testid="llm-complete-request"
        className="rounded-2xl border border-border bg-surface px-4 py-4 shadow-sm sm:px-5"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Complete request
        </p>
        {completeRequest ? (
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-3 text-xs leading-5 text-text-primary">
            {completeRequest}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            The complete OpenAI request will appear here after Send.
          </p>
        )}
      </div>
    </section>
  );
}

function formatCompletePayload(raw: unknown): string {
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
