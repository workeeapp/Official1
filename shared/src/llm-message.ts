import { parseAttachmentIds, SEND_ATTACHMENTS_MAX } from "./attachments.js";
import { parseJobUrgency, type JobUrgency } from "./job-urgency.js";
import {
  parseRecurrence,
  parseRecurrenceException,
  type Recurrence,
  type RecurrenceException,
} from "./recurrence.js";
import { parseReminderInterval } from "./reminder-interval.js";

export interface LlmReplyButton {
  label: string;
  /** Sent back verbatim as the speaker's next message when tapped. */
  command: string;
}

/** One spoken bubble: text plus optional reply buttons and Waze address. */
export interface LlmSpokenBubble {
  text: string;
  buttons?: LlmReplyButton[];
  navigateAddress?: string;
}

export interface ParsedLlmMessage {
  /** All spoken messages joined — for readers that only need the text. */
  response: string;
  /** Spoken messages in send order; each one is its own chat bubble / WhatsApp send. */
  responses: string[];
  /**
   * Per-bubble text + chrome after parse.
   * Object-shaped responses bind buttons/Waze on that entry; legacy string
   * responses + turn-level metadata.buttons use distributeReplyButtons.
   */
  responseBubbles: LlmSpokenBubble[];
  actions: string[];
  /** Flattened unique buttons across bubbles (legacy / ensureSpeakerShowButtons). */
  buttons?: LlmReplyButton[];
  /** First non-empty navigate across bubbles (legacy readers). */
  navigateAddress?: string;
  /** Emoji from metadata.show_icon — attached to the speaker's message. */
  showIcon?: string;
}

export const REPLY_BUTTON_MAX = 3;
export const REPLY_BUTTON_LABEL_MAX = 20;
export const REPLY_BUTTON_COMMAND_MAX = 256;
export const NAVIGATE_ADDRESS_MAX = 300;
export const SHOW_ICON_MAX = 32;

export type LlmListType = "shopping" | "contacts" | "tasks" | "custom";
export type LlmListActionName = "add" | "remove" | "update";
export type LlmFilingActionName = "add_filing" | "remove_filing" | "update_filing";

export interface LlmListAction {
  action: LlmListActionName;
  listType: LlmListType;
  listName: string;
  /** Custom lists: column that names each row; stored only when the list is created. */
  titleField?: string;
  /** Custom lists: declared columns; stored only when the list is created. */
  columns?: string[];
  items: Record<string, unknown>[];
  targets: string[];
  /** Files attached to the list itself (lists[].list_attachment_ids). */
  listAttachmentIds?: string[];
}

export type LlmListOpName = "alter_list" | "delete_list";

export interface LlmColumnRename {
  from: string;
  to: string;
}

/** List-level change. Every field except action/listId is optional; empty = no change. */
export interface LlmListOp {
  action: LlmListOpName;
  /** Copy from this turn's EMPLOYEE_SAVED_DATA lists[].list_id. */
  listId: string;
  newName: string;
  addColumns: string[];
  removeColumns: string[];
  renameColumns: LlmColumnRename[];
  addParticipants: string[];
  removeParticipants: string[];
  addAttachments?: string[];
  removeAttachments?: string[];
}

export interface LlmFilingAction {
  action: LlmFilingActionName;
  itemName: string;
  itemInfo: string;
  /** Human description for retrieval; required on add (may equal itemName). */
  itemDescription: string;
  targets: string[];
  /** Copy from this turn's EMPLOYEE_SAVED_DATA filing[].filing_id on remove/update. */
  filingId: string;
  attachmentIds?: string[];
  detachAttachmentIds?: string[];
  /** update_filing: partner names to drop from visible_to. */
  unshareWith?: string[];
}

export interface LlmMessageAction {
  targets: string[];
  text: string;
  /**
   * The recipient is expected to answer. The server opens a job on the digital
   * worker so the answer can be bound later and reported back to the asker.
   */
  expectsReply?: boolean;
  /** The asker's question in their own words, quoted back when reporting. */
  askSummary?: string;
  /** How hard the speaker stressed the ask; drives the server's follow-up clocks. */
  urgency?: JobUrgency;
  /** The ask is to set up a meeting/call at this slot; a yes books it for both people. */
  book?: LlmMessageBook;
  /**
   * Deferred check-with: activate the job later. Same clock fields as reminders.
   * When any of these is set with expects_reply, the server schedules the job
   * (Lucy task + Reminder) and does not ask/send until fire.
   */
  inSeconds?: number | null;
  /** Deferred check: YYYY-MM-DD */
  date?: string;
  /** Deferred check: HH:mm */
  time?: string;
  /** Deferred check: structured recurrence (same shape as reminders[].recurrence). */
  recurrence?: Recurrence;
}

/** True when a job-opening message should wait for a clock instead of opening now. */
export function messageHasSchedule(action: {
  inSeconds?: number | null;
  date?: string;
  time?: string;
  recurrence?: Recurrence | null;
}): boolean {
  if (typeof action.inSeconds === "number" && action.inSeconds > 0) {
    return true;
  }
  if (action.date?.trim()) {
    return true;
  }
  if (action.time?.trim()) {
    return true;
  }
  return Boolean(action.recurrence);
}

export interface LlmMessageBook {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** HH:mm end of the asked range. */
  endTime?: string;
  /** The range is a window to pick a slot in, not the meeting's length. */
  window?: boolean;
}

export type LlmJobActionName =
  | "answer"
  | "decline"
  | "progress"
  | "counter"
  | "snooze"
  | "clear_clock"
  | "close"
  | "escalate";

/** Lifecycle of an open job the digital worker holds for one person about another. */
export interface LlmJobAction {
  action: LlmJobActionName;
  jobId: string;
  /** What the subject said (answer / decline reason / progress note). */
  answerText: string;
  /** Sentence to deliver to the other person. On answer/decline that is the asker. On counter it is the approval question for whoever must answer next. Empty = server writes a plain line. */
  reportText: string;
  /** Snooze clock: HH:mm. On counter, the proposed meeting time. */
  time: string;
  /** Snooze clock: seconds from now. */
  in: number | null;
  /** Counter only: the proposed meeting date, YYYY-MM-DD. */
  date?: string;
  /** Counter only: HH:mm end of the proposed slot. */
  endTime?: string;
  /** Escalate only: the new urgency (must be higher than the job's current level). Asker only. */
  urgency?: JobUrgency;
}

export type LlmDirectoryActionName =
  | "add"
  | "remove"
  | "update"
  | "share_book";

export interface LlmDirectoryAction {
  action: LlmDirectoryActionName;
  name: string;
  phone: string;
  /** Copy from this turn's SPEAKER_CONTACTS[].contact_id on remove/update. */
  contactId: string;
  /** Co-share (speaker+partners) or assign (partners only) — same as list items. Empty = personal. */
  targets: string[];
  /** update / share_book: partner names to drop from visible_to. */
  unshareWith?: string[];
}

export type LlmReminderActionName = "add" | "remove" | "update";
export type LlmReminderRepeat =
  | "once"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

/** Arithmetic ops for watch expr AST. */
export type WatchExprOp = "add" | "sub" | "mul" | "div" | "pct";

/** Compare ops for watch expr (approx = |left-right| ≤ tol). */
export type WatchExprCompare =
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "eq"
  | "approx";

/** Leaf or binop node in a watch expression (max depth 3). */
export type WatchExprNode =
  | { const: number }
  | {
      field: string;
      place?: string;
      symbol?: string;
      dayOffset?: number;
    }
  | { op: WatchExprOp; args: WatchExprNode[] };

/** Structured gate for conditional watch clocks («תעדכני אותי אם…»). */
export type LlmComposeCondition =
  | {
      type: "market_price";
      op: "lt" | "lte" | "gt" | "gte" | "eq";
      value: number;
    }
  | {
      type: "weather_rain";
      /** 0 = today (default); 1 = tomorrow forecast day. */
      dayOffset?: number;
    }
  | {
      /** Fingerprint weather body; send when it changes vs last_report_sha. */
      type: "weather_changed";
      dayOffset?: number;
    }
  | { type: "mashov_new" }
  | {
      /** Compare daily % change of two tickers (optionally on different day offsets). */
      type: "market_change_compare";
      left: string;
      right: string;
      op: "lt" | "lte" | "gt" | "gte" | "eq";
      metric: "daily_change_pct";
      leftDayOffset: number;
      rightDayOffset: number;
    }
  | {
      /** General arithmetic compare on catalog numeric fields. */
      type: "expr";
      compare: WatchExprCompare;
      left: WatchExprNode;
      right: WatchExprNode;
      /** Absolute tolerance for compare:"approx" (default 0.5). */
      tol?: number;
    }
  | {
      /** Alert when a catalog numeric field value changes. */
      type: "field_changed";
      field: string;
      place?: string;
      symbol?: string;
      dayOffset?: number;
    }
  | {
      /** Poll Google Routes stop→dest; notify when next matching departure ≤ minutes_before. */
      type: "bus_eta";
      origin: string;
      destination: string;
      line: string;
      headsign: string;
      minutesBefore: number;
    }
  | {
      /**
       * Poll AviationStack; notify when minutes until arrival/departure
       * ≤ minutes_before + hours_before*60.
       */
      type: "flight_eta";
      airport: string;
      direction: "arrivals" | "departures";
      flight: string;
      airline: string;
      city: string;
      minutesBefore: number;
      hoursBefore: number;
    }
  | {
      /** Poll AviationStack; notify when flight status fingerprint changes. */
      type: "flight_changed";
      airport: string;
      direction: "arrivals" | "departures";
      flight: string;
    };

export interface LlmReminderAction {
  action: LlmReminderActionName;
  item: string;
  listType: LlmListType;
  date: string;
  time: string;
  repeat: LlmReminderRepeat;
  ping: string[];
  /**
   * Who the clock is about (Known employee names) — e.g. birthday of עמית.
   * Distinct from ping (who gets WhatsApp). Empty / omitted = omit / keep on update.
   */
  about?: string[];
  targets: string[];
  text: string;
  inSeconds: number | null;
  everyCount: number | null;
  everyUnit:
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "weeks"
    | "months"
    | "weekdays"
    | null;
  weekdays: number[] | null;
  /**
   * Structured repeat rule; wins over every_count/every_unit/weekdays when present.
   * null = the model sent {freq:"none"}: stop repeating (undefined = unchanged).
   */
  recurrence?: Recurrence | null;
  confirmed: boolean;
  /** When true, text is a brief; final WhatsApp copy is written at fire time. */
  compose: boolean;
  /**
   * "git_log" = summarize repo commits at fire.
   * "saved_data" = answer the brief from live EMPLOYEE_SAVED_DATA at fire.
   * "weather" / "market" = fixedBody plugins (city or tickers in composePlace).
   */
  composeSource: "" | "git_log" | "saved_data" | "weather" | "market" | "mashov";
  /**
   * Hours of git history for windowed digests.
   * 0 = recurring since-last-report mode (one-shot defaults to 168h at fire).
   */
  composeLookbackHours: number;
  /**
   * Lookup key for compose plugins: weather city, market tickers, mashov
   * child name, or jewish_candles city. Empty otherwise.
   */
  composePlace: string;
  /**
   * Event-relative schedule. Empty / omit = wall clock.
   * jewish_candles = fire from next Hebcal candle lighting + scheduleOffsetMinutes.
   */
  scheduleAnchor?: "" | "jewish_candles";
  /**
   * Minutes relative to scheduleAnchor (negative = before). 10 דקות לפני → -10.
   */
  scheduleOffsetMinutes?: number;
  /**
   * Conditional watch: structured gate evaluated at fire (skip WhatsApp when false).
   * null/omit = always send (normal compose).
   */
  composeCondition?: LlmComposeCondition | null;
  /**
   * One-shot watch: after first successful condition send, settle done and
   * soft-delete the worker task. Quiet skips keep polling.
   * Explicit false = recurring («בכל פעם»). Omit → engine defaults true when
   * compose_condition is set.
   */
  watchOnce?: boolean;
  /**
   * Aspects for compose plugins at fire (esp. mashov): grades, behavior, homework,
   * absences, messages, weather/market aspects. Empty = plugin defaults.
   */
  composeAspects?: string[];
  /** Copy from this turn's EMPLOYEE_SAVED_DATA reminders[].reminder_id on remove/update. */
  reminderId: string;
  /** update only: cancel / move one occurrence of a repeating clock; the rule stays. */
  occurrenceChange?: RecurrenceException;
  /** Files sent together with the reminder when it fires. */
  attachmentIds?: string[];
  detachAttachmentIds?: string[];
}

export interface LlmHandoffAction {
  worker: string;
}

export type ReportSection =
  | "reminders"
  | "sends"
  | "tasks"
  | "shopping"
  | "filings"
  | "contacts"
  | "custom"
  | "history";

/** Mutation kinds for report section "history" (add / update / remove / fire). */
export type ReportHistoryKind = "add" | "update" | "remove" | "fire";

/** Guest onboarding: create a User login + own Lucy; keep host share mirror. */
export interface LlmRegisterAction {
  name: string;
  surname: string;
  username: string;
  password: string;
}

export interface LlmMetadata {
  lists: LlmListAction[];
  /** List-level alter/delete (rename, columns, participants, delete whole list). */
  listOps?: LlmListOp[];
  filing: LlmFilingAction[];
  messages?: LlmMessageAction[];
  reminders?: LlmReminderAction[];
  directory?: LlmDirectoryAction[];
  /** Lifecycle updates for jobs listed in OPEN_JOBS this turn. */
  jobs?: LlmJobAction[];
  handoff?: LlmHandoffAction | null;
  /**
   * לוסי-אורח only: promote WhatsApp guest → new User + human with share mirror.
   * null/omit when not registering this turn.
   */
  register?: LlmRegisterAction | null;
  /** Categories for legacy report sections. Empty/omit = full set. */
  reportSections?: ReportSection[];
  /**
   * When sections includes history: limit audit rows to these kinds.
   * Empty/omit = all kinds. Companion domain sections (shopping/tasks/…)
   * further scope history to that domain.
   */
  reportHistoryKinds?: ReportHistoryKind[];
  confirm?: boolean | null;
  targets?: string[];
  /** Saved files the engine sends to the speaker after the reply. */
  sendAttachments?: string[];
  /**
   * Status dump signal: model understood a show/status ask; engine replaces
   * response with a live DB dump. Values: shopping|tasks|contacts|reminders
   * or a custom list name.
   */
  showDump?: string;
  /**
   * shopping/tasks three-way filter. null/omit = full dump.
   * personal = אישיות only; shared = משותפות only (optional partner below).
   */
  showDumpSection?: "personal" | "shared" | null;
  /**
   * With showDumpSection=shared: partner משותפות bucket(s).
   * string | string[] — multiple = OR.
   */
  showDumpPartner?: string | string[] | null;
  /**
   * Responsibility filter for shopping/tasks dumps: `self` | display name(s).
   * string | string[] — multiple = OR. Combine with section/partner.
   */
  showDumpAssignee?: string | string[] | null;
  /**
   * Dump subject(s) other than the speaker («מה מיכל צריכה לקנות»).
   * string | string[] — multiple = union of dumps.
   */
  showDumpAbout?: string | string[] | null;
  /** Inclusive dump date filter start YYYY-MM-DD (Asia/Jerusalem). */
  showDumpFrom?: string | null;
  /** Inclusive dump date filter end YYYY-MM-DD (Asia/Jerusalem). */
  showDumpTo?: string | null;
  /**
   * Urgency dump filter: urgent = urgent|very_urgent; very_urgent = only that.
   */
  showDumpUrgency?: "urgent" | "very_urgent" | null;
  /**
   * Live weather ask — engine fetches Open-Meteo and replaces response.
   * null/omit when not a weather turn. Missing place → model asks; leave unset.
   */
  weather?: LlmWeatherAction | null;
  /**
   * Live market ask (stocks / indices / crypto) — engine fetches Yahoo Finance
   * and replaces response. Missing queries → model asks; leave unset.
   */
  market?: LlmMarketAction | null;
  /**
   * Live Mashov (משוב) ask — engine logs in from filings and replaces response.
   * Never includes password. Missing filings → model asks; leave unset.
   */
  mashov?: LlmMashovAction | null;
  /**
   * Live local business / places ask — engine fetches Google Places and replaces
   * response. Missing query or place → model asks; leave unset.
   */
  places?: LlmPlacesAction | null;
  /**
   * Live Jewish calendar / Shabbat ask — engine fetches Hebcal and replaces
   * response. Place required for candles/havdalah/summary; optional for
   * parasha/holidays. Missing required place → model asks; leave unset.
   */
  jewish?: LlmJewishAction | null;
  /**
   * Live public-transit trip / leave-by / next departure / stop board via Google.
   * Trip/ETA need origin+destination; stop board (aspects lines) needs origin only.
   * Ambiguous lines-at-stop → model asks clarify; leave unset until answered.
   */
  routes?: LlmRoutesAction | null;
  /**
   * Live airport board / flight status (AviationStack). Default airport TLV.
   * Missing flight/airline/city when needed → model asks; leave unset.
   */
  flights?: LlmFlightsAction | null;
  /**
   * Catalog tip keys the engine may append after responses (exact catalog text).
   * Engine validates audience/digital/quota; model must not rewrite tip copy.
   */
  tips?: string[];
}

export type LlmWeatherAspect =
  | "summary"
  | "temp"
  | "wind"
  | "waves"
  | "humidity";

export interface LlmWeatherAction {
  place: string;
  /** YYYY-MM-DD or empty (= now/today). */
  date: string;
  aspects: LlmWeatherAspect[];
}

export type LlmMarketAspect = "summary" | "price" | "change" | "range";

export interface LlmMarketAction {
  /** Tickers or names (1–5). */
  queries: string[];
  aspects: LlmMarketAspect[];
}

export type LlmMashovAspect =
  | "grades"
  | "homework"
  | "behavior"
  | "timetable";

export interface LlmMashovAction {
  /** Child first name; empty = only child / ask. */
  child: string;
  aspects: LlmMashovAspect[];
}

export type LlmPlacesAspect = "summary" | "phone" | "address" | "hours";

export interface LlmPlacesAction {
  /** What to find (business name or category). */
  query: string;
  /** City / area bias (פתח תקווה, קרית אונו). Empty OK when near=speaker. */
  place: string;
  /** Search around PENDING_LOCATION pin. */
  near: "speaker" | "";
  lat: number | null;
  lng: number | null;
  aspects: LlmPlacesAspect[];
}

export type LlmJewishAspect =
  | "summary"
  | "candles"
  | "havdalah"
  | "parasha"
  | "holidays";

export interface LlmJewishAction {
  /** Israel city for local times; empty OK for parasha/holidays alone. */
  place: string;
  /** YYYY-MM-DD or empty (= this week / now). */
  date: string;
  aspects: LlmJewishAspect[];
}

export type LlmRoutesAspect =
  | "summary"
  | "duration"
  | "steps"
  | "fare"
  | "eta"
  | "frequency"
  | "lines";

export interface LlmRoutesAction {
  /** Origin address / place, or "speaker" for PENDING_LOCATION. */
  origin: string;
  /** Destination address / place / direction city. Empty when aspects includes lines. */
  destination: string;
  /** Leave at (YYYY-MM-DDTHH:mm or RFC3339); empty = now. */
  departure: string;
  /** Arrive by (same formats); mutually exclusive with departure when set. */
  arrival: string;
  /** Optional line filter (51) for stop→dest next-departure asks. */
  line: string;
  /** Optional headsign / direction filter. */
  headsign: string;
  aspects: LlmRoutesAspect[];
}

export type LlmFlightsAspect =
  | "summary"
  | "board"
  | "next"
  | "status"
  | "gate"
  | "delay";

export type LlmFlightsDirection = "arrivals" | "departures" | "both";

export interface LlmFlightsAction {
  /** IATA / city; empty → engine defaults TLV. */
  airport: string;
  /** arrivals | departures | both; empty → both / derived by model. */
  direction: LlmFlightsDirection | "";
  /** Airline name or IATA (אל על / LY). */
  airline: string;
  /** City / IATA of other end (פריז / CDG). */
  city: string;
  /** Flight code as spoken (LY831, 3242CXD, …). */
  flight: string;
  /** YYYY-MM-DD; empty = today / live board. Engine filters client-side. */
  date: string;
  /**
   * Keep only flights with ETA/STA within this many minutes from now
   * (e.g. 30 for «בחצי שעה הקרובה»). 0 / omit = no window filter.
   */
  withinMinutes: number;
  aspects: LlmFlightsAspect[];
}

export type LlmShowDumpSection = "personal" | "shared";
export type LlmShowDumpUrgency = "urgent" | "very_urgent";

const LIST_ACTIONS = new Set<LlmListActionName>(["add", "remove", "update"]);
const LIST_TYPES = new Set<LlmListType>(["shopping", "contacts", "tasks", "custom"]);
const FILING_ACTIONS = new Set<LlmFilingActionName>([
  "add_filing",
  "remove_filing",
  "update_filing",
]);

const JOB_ACTIONS = new Set<LlmJobActionName>([
  "answer",
  "decline",
  "progress",
  "counter",
  "snooze",
  "clear_clock",
  "close",
  "escalate",
]);

const REMINDER_ACTIONS = new Set<LlmReminderActionName>(["add", "remove", "update"]);
const REMINDER_REPEATS = new Set<LlmReminderRepeat>([
  "once",
  "hourly",
  "daily",
  "weekly",
  "monthly",
]);

export function emptyLlmMetadata(): LlmMetadata {
  return {
    lists: [],
    listOps: [],
    filing: [],
    messages: [],
    reminders: [],
    directory: [],
    jobs: [],
    handoff: null,
    register: null,
    reportSections: [],
    reportHistoryKinds: [],
    confirm: null,
    targets: [],
  };
}

export function parseLlmMetadata(metadata: unknown): LlmMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return emptyLlmMetadata();
  }

  const meta = metadata as Record<string, unknown>;
  const defaultTargets = parseTargets(meta);
  const reportSections = parseReportSections(meta);
  const {
    lists,
    listOps: listOpsFromLists,
    filing: filingFromLists,
    reminders: remindersFromLists,
  } = splitUnifiedListEntries(normalizeListsField(meta.lists) ?? [], defaultTargets);
  // Legacy sibling keys still accepted (old chats / fixtures).
  const filingLegacy = Array.isArray(meta.filing)
    ? meta.filing.flatMap((entry) => {
        const action = toFilingAction(entry);
        if (!action) {
          return [];
        }
        return [
          {
            ...action,
            targets: action.targets.length > 0 ? action.targets : defaultTargets,
          },
        ];
      })
    : [];
  const filing = [...filingFromLists, ...filingLegacy];
  const reminders = [...remindersFromLists, ...parseReminderActions(meta)];
  const directory = parseDirectoryActions(meta);
  const messages = parseMessageActions(meta);
  const listOps = [...listOpsFromLists, ...parseListOps(meta)];
  const sendAttachments = parseAttachmentIds(
    meta.send_attachments ?? meta.sendAttachments,
  ).slice(0, SEND_ATTACHMENTS_MAX);
  const showDump = parseShowDump(meta);
  const showDumpSection = parseShowDumpSection(meta);
  const showDumpPartner = parseShowDumpNameList(
    meta.show_dump_partner ?? meta.showDumpPartner,
  );
  const showDumpAssignee = parseShowDumpNameList(
    meta.show_dump_assignee ?? meta.showDumpAssignee,
  );
  const showDumpAbout = parseShowDumpNameList(
    meta.show_dump_about ?? meta.showDumpAbout,
  );
  const showDumpFrom = parseShowDumpDate(meta, "show_dump_from", "showDumpFrom");
  const showDumpTo = parseShowDumpDate(meta, "show_dump_to", "showDumpTo");
  const showDumpUrgency = parseShowDumpUrgency(meta);
  const weather = parseWeatherAction(meta);
  const market = parseMarketAction(meta);
  const mashov = parseMashovAction(meta);
  const places = parsePlacesAction(meta);
  const jewish = parseJewishAction(meta);
  const routes = parseRoutesAction(meta);
  const flights = parseFlightsAction(meta);
  const tips = parseTipKeys(meta);
  return {
    messages,
    reminders,
    directory,
    jobs: parseJobActions(meta),
    handoff: parseHandoff(meta),
    register: parseRegister(meta),
    reportSections,
    reportHistoryKinds: parseReportHistoryKinds(meta, reportSections),
    confirm: parseConfirm(meta),
    targets: defaultTargets,
    lists,
    listOps,
    filing,
    ...(sendAttachments.length > 0 ? { sendAttachments } : {}),
    ...(showDump ? { showDump } : {}),
    ...(showDumpSection ? { showDumpSection } : {}),
    ...(showDumpPartner.length > 0
      ? {
          showDumpPartner:
            showDumpPartner.length === 1
              ? showDumpPartner[0]!
              : showDumpPartner,
        }
      : {}),
    ...(showDumpAssignee.length > 0
      ? {
          showDumpAssignee:
            showDumpAssignee.length === 1
              ? showDumpAssignee[0]!
              : showDumpAssignee,
        }
      : {}),
    ...(showDumpAbout.length > 0
      ? {
          showDumpAbout:
            showDumpAbout.length === 1 ? showDumpAbout[0]! : showDumpAbout,
        }
      : {}),
    ...(showDumpFrom ? { showDumpFrom } : {}),
    ...(showDumpTo ? { showDumpTo } : {}),
    ...(showDumpUrgency ? { showDumpUrgency } : {}),
    ...(weather ? { weather } : {}),
    ...(market ? { market } : {}),
    ...(mashov ? { mashov } : {}),
    ...(places ? { places } : {}),
    ...(jewish ? { jewish } : {}),
    ...(routes ? { routes } : {}),
    ...(flights ? { flights } : {}),
    ...(tips.length > 0 ? { tips } : {}),
  };
}

/** metadata.tips — catalog tip keys (max 5). */
export function parseTipKeys(meta: Record<string, unknown>): string[] {
  const raw = meta.tips;
  if (!Array.isArray(raw)) {
    return [];
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const key = entry.trim().slice(0, 64);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
    if (keys.length >= 5) {
      break;
    }
  }
  return keys;
}

/**
 * Strip one layer of wrapping quotes from a show_dump list name
 * (`"…"`, `״…״`, `«…»`, `'…'`). Builtin kinds are unchanged after trim.
 */
export function normalizeShowDumpListName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["״", "״"],
    ["«", "»"],
    ["'", "'"],
    ["\u201C", "\u201D"],
    ["\u2018", "\u2019"],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return trimmed;
}

/** metadata.show_dump — category or custom list name for engine status dump. */
export function parseShowDump(meta: Record<string, unknown>): string {
  const raw = meta.show_dump ?? meta.showDump;
  if (typeof raw !== "string") {
    return "";
  }
  return normalizeShowDumpListName(raw).slice(0, 100);
}

/** metadata.show_dump_section — personal | shared. */
export function parseShowDumpSection(
  meta: Record<string, unknown>,
): LlmShowDumpSection | null {
  const raw = meta.show_dump_section ?? meta.showDumpSection;
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "personal" || value === "shared") {
    return value;
  }
  return null;
}

/** Normalize dump name filter: string | string[] → deduped trimmed list. */
export function parseShowDumpNameList(raw: unknown): string[] {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim().slice(0, 80);
    if (trimmed && !parts.includes(trimmed)) {
      parts.push(trimmed);
    }
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      push(entry);
    }
  } else {
    push(raw);
  }
  return parts;
}

/** metadata.show_dump_partner — partner display name(s); multiple = OR. */
export function parseShowDumpPartner(meta: Record<string, unknown>): string[] {
  return parseShowDumpNameList(meta.show_dump_partner ?? meta.showDumpPartner);
}

/** metadata.show_dump_assignee — `self` | display name(s); multiple = OR. */
export function parseShowDumpAssignee(meta: Record<string, unknown>): string[] {
  return parseShowDumpNameList(
    meta.show_dump_assignee ?? meta.showDumpAssignee,
  );
}

/** metadata.show_dump_about — other person(s); multiple = union dumps. */
export function parseShowDumpAbout(meta: Record<string, unknown>): string[] {
  return parseShowDumpNameList(meta.show_dump_about ?? meta.showDumpAbout);
}

/** Coerce stored metadata string | string[] to a name list. */
export function showDumpNames(
  value: string | string[] | null | undefined,
): string[] {
  return parseShowDumpNameList(value ?? null);
}

/** metadata.show_dump_urgency — urgent | very_urgent. */
export function parseShowDumpUrgency(
  meta: Record<string, unknown>,
): LlmShowDumpUrgency | null {
  const raw = meta.show_dump_urgency ?? meta.showDumpUrgency;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "urgent" || trimmed === "very_urgent") {
    return trimmed;
  }
  return null;
}

/** metadata.show_dump_from / show_dump_to — YYYY-MM-DD inclusive. */
export function parseShowDumpDate(
  meta: Record<string, unknown>,
  snake: string,
  camel: string,
): string {
  const raw = meta[snake] ?? meta[camel];
  if (typeof raw !== "string") {
    return "";
  }
  const value = raw.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

const LIST_OP_ACTIONS = new Set<LlmListOpName>(["alter_list", "delete_list"]);

export function parseListOps(meta: Record<string, unknown>): LlmListOp[] {
  const raw = meta.list_ops ?? meta.listOps;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const op = toListOp(entry);
    return op ? [op] : [];
  });
}

const FILING_LIST_TYPE = "filing";
const REMINDERS_LIST_TYPE = "reminders";
const FILING_ACTION_BY_ROW: Record<string, LlmFilingActionName> = {
  add: "add_filing",
  remove: "remove_filing",
  update: "update_filing",
  add_filing: "add_filing",
  remove_filing: "remove_filing",
  update_filing: "update_filing",
};

/**
 * Split unified metadata.lists into engine-facing lists / listOps / filing /
 * reminders. Shell ops, list_type filing, and list_type reminders live in the
 * same model-facing array; row mutates stay as LlmListAction.
 */
function splitUnifiedListEntries(
  entries: unknown[],
  defaultTargets: string[],
): {
  lists: LlmListAction[];
  listOps: LlmListOp[];
  filing: LlmFilingAction[];
  reminders: LlmReminderAction[];
} {
  const lists: LlmListAction[] = [];
  const listOps: LlmListOp[] = [];
  const filing: LlmFilingAction[] = [];
  const reminders: LlmReminderAction[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const actionRaw = String(record.action ?? "")
      .trim()
      .toLowerCase();
    if (LIST_OP_ACTIONS.has(actionRaw as LlmListOpName)) {
      const op = toListOp(record);
      if (op) {
        listOps.push(op);
      }
      continue;
    }
    const listTypeRaw = String(record.list_type ?? record.listType ?? "")
      .trim()
      .toLowerCase();
    if (
      listTypeRaw === FILING_LIST_TYPE ||
      actionRaw === "add_filing" ||
      actionRaw === "remove_filing" ||
      actionRaw === "update_filing"
    ) {
      for (const filed of filingActionsFromUnifiedEntry(record, defaultTargets)) {
        filing.push(filed);
      }
      continue;
    }
    if (
      listTypeRaw === REMINDERS_LIST_TYPE ||
      listTypeRaw === "reminder" ||
      listTypeRaw === "clocks" ||
      listTypeRaw === "clock"
    ) {
      for (const clock of reminderActionsFromUnifiedEntry(record)) {
        reminders.push(clock);
      }
      continue;
    }
    const action = toListAction(record);
    if (!action) {
      continue;
    }
    lists.push({
      ...action,
      targets: action.targets.length > 0 ? action.targets : defaultTargets,
    });
  }
  return { lists, listOps, filing, reminders };
}

/** One lists[] entry with list_type reminders → one or more LlmReminderAction. */
function reminderActionsFromUnifiedEntry(
  record: Record<string, unknown>,
): LlmReminderAction[] {
  const actionRaw = String(record.action ?? "")
    .trim()
    .toLowerCase();
  const entryAction = reminderActionName(actionRaw);
  const items = Array.isArray(record.items)
    ? record.items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
  const sources =
    items.length > 0
      ? items
      : // Flat shape: clock fields on the lists entry itself.
        [record];
  const entryPing = record.ping ?? record.notify ?? record.ping_targets;
  const entryTargets = parseTargets(record);
  return sources.flatMap((source) => {
    const sourceAction = reminderActionName(source.action) ?? entryAction;
    if (!sourceAction) {
      return [];
    }
    const merged: Record<string, unknown> = {
      ...source,
      action: sourceAction,
    };
    // Outer list_type is "reminders"; wrapper shopping|tasks lives on the item.
    const wrapperType = String(merged.list_type ?? merged.listType ?? "")
      .trim()
      .toLowerCase();
    if (
      wrapperType === REMINDERS_LIST_TYPE ||
      wrapperType === "reminder" ||
      wrapperType === "clocks" ||
      wrapperType === "clock" ||
      !wrapperType
    ) {
      delete merged.list_type;
      delete merged.listType;
    }
    if (
      !readText(merged, ["reminder_id", "reminderId", "id"]) &&
      readText(merged, ["item_id", "itemId"])
    ) {
      merged.reminder_id = readText(merged, ["item_id", "itemId"]);
    }
    if (
      merged.ping == null &&
      merged.notify == null &&
      merged.ping_targets == null &&
      entryPing != null
    ) {
      merged.ping = entryPing;
    }
    if (parseTargets(merged).length === 0 && entryTargets.length > 0) {
      merged.targets = entryTargets;
    }
    const action = toReminderAction(merged);
    return action ? [action] : [];
  });
}

/** One lists[] entry with list_type filing → one or more LlmFilingAction. */
function filingActionsFromUnifiedEntry(
  record: Record<string, unknown>,
  defaultTargets: string[],
): LlmFilingAction[] {
  const actionRaw = String(record.action ?? "")
    .trim()
    .toLowerCase();
  const filingAction = FILING_ACTION_BY_ROW[actionRaw];
  if (!filingAction) {
    return [];
  }
  const entryTargets = parseTargets(record);
  const targets =
    entryTargets.length > 0 ? entryTargets : defaultTargets;
  const items = Array.isArray(record.items)
    ? record.items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
  const sources =
    items.length > 0
      ? items
      : // Flat shape (legacy-style fields on the lists entry itself).
        [record];
  return sources.flatMap((source) => {
    const merged: Record<string, unknown> = {
      ...source,
      action: filingAction,
      targets:
        parseTargets(source).length > 0 ? parseTargets(source) : targets,
    };
    // Prefer filing_id; allow item_id alias from the unified lists shape.
    if (
      !readText(merged, ["filing_id", "filingId"]) &&
      readText(merged, ["item_id", "itemId"])
    ) {
      merged.filing_id = readText(merged, ["item_id", "itemId"]);
    }
    const action = toFilingAction(merged);
    return action ? [action] : [];
  });
}

function toListOp(value: unknown): LlmListOp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const action = String(record.action ?? "").trim().toLowerCase();
  if (!LIST_OP_ACTIONS.has(action as LlmListOpName)) {
    return null;
  }
  const listId = readText(record, ["list_id", "listId"]);
  if (!listId) {
    return null;
  }
  return {
    action: action as LlmListOpName,
    listId,
    newName: readText(record, ["new_name", "newName"]).slice(0, 100),
    addColumns: readStringList(record.add_columns ?? record.addColumns),
    removeColumns: readStringList(record.remove_columns ?? record.removeColumns),
    renameColumns: readColumnRenames(record.rename_columns ?? record.renameColumns),
    addParticipants: readStringList(record.add_participants ?? record.addParticipants),
    removeParticipants: readStringList(
      record.remove_participants ?? record.removeParticipants,
    ),
    ...optionalIds("addAttachments", record.add_attachments ?? record.addAttachments),
    ...optionalIds(
      "removeAttachments",
      record.remove_attachments ?? record.removeAttachments,
    ),
  };
}

function optionalIds<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string[]>> {
  const ids = parseAttachmentIds(value);
  return ids.length > 0 ? ({ [key]: ids } as Record<K, string[]>) : {};
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const text = entry.trim().slice(0, 100);
    if (text && !out.includes(text)) {
      out.push(text);
    }
  }
  return out;
}

function readColumnRenames(value: unknown): LlmColumnRename[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const from = readText(record, ["from"]).slice(0, 100);
    const to = readText(record, ["to"]).slice(0, 100);
    return from && to && from !== to ? [{ from, to }] : [];
  });
}

export function parseTargets(value: unknown): string[] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const raw = record
    ? (record.targets ?? record.target ?? record.for ?? record.assignees)
    : value;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return [String(raw)];
  }

  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return [String(entry)];
    }
    if (typeof entry === "string" && entry.trim()) {
      return [entry.trim()];
    }
    return [];
  });
}

export function parseReplyMetadata(text: string): LlmMetadata {
  return extractLlmPayload(text)?.metadata ?? emptyLlmMetadata();
}

function toListAction(value: unknown): LlmListAction | null {
  if (!isActionRecord(value) || !LIST_ACTIONS.has(value.action as LlmListActionName)) {
    return null;
  }

  const listType = LIST_TYPES.has(value.list_type as LlmListType)
    ? (value.list_type as LlmListType)
    : "custom";
  let items = Array.isArray(value.items)
    ? value.items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
  // Shape drift: remove/update with item_id on the action (not inside items[]).
  if (
    items.length === 0 &&
    (value.action === "remove" || value.action === "update")
  ) {
    const loneId = readText(value, ["item_id", "itemId", "id"]);
    if (loneId) {
      items = [{ item_id: loneId }];
    }
  }

  let listName =
    listType === "custom" ? readText(value, ["list_name", "רשימה"]) : "";
  if (listType === "custom" && !listName) {
    listName = listNameFromItems(items);
  }
  // Models sometimes copy the new row into list_name (or a hallucinated top-level
  // name). A real row label must not become the list title — keep a distinct
  // list_name from the item when present (e.g. list_name: "בעיות").
  if (listType === "custom" && listName && items.length === 1) {
    const label = itemLabel(items[0]).trim();
    if (
      label &&
      normalizeLooseText(label) === normalizeLooseText(listName) &&
      !isTitleOnlyListItem(items[0])
    ) {
      const fromItem = listNameFromItems(items);
      listName =
        fromItem && normalizeLooseText(fromItem) !== normalizeLooseText(label)
          ? fromItem
          : "";
    }
  }

  // Named custom lists may open/share with columns only (no rows yet).
  // remove/update with only item_id is also valid (jobs-style id mutate).
  if (
    items.length === 0 &&
    !(listType === "custom" && listName) &&
    value.action !== "remove" &&
    value.action !== "update"
  ) {
    return null;
  }
  if (
    items.length === 0 &&
    (value.action === "remove" || value.action === "update")
  ) {
    return null;
  }

  const titleField =
    listType === "custom" ? readText(value, ["title_field"]).slice(0, 100) : "";
  const columns = listType === "custom" ? readStringList(value.columns) : [];

  return {
    action: value.action as LlmListActionName,
    listType,
    listName,
    ...(titleField ? { titleField } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    items,
    targets: parseTargets(value),
    ...optionalIds(
      "listAttachmentIds",
      value.list_attachment_ids ?? value.listAttachmentIds,
    ),
  };
}

function listNameFromItems(items: Record<string, unknown>[]): string {
  for (const item of items) {
    const name = readText(item, ["list_name", "listName", "רשימה"]);
    if (name) {
      return name.slice(0, 100);
    }
  }
  return "";
}

function normalizeLooseText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Sole title-like cell — opening a named list, not a real data row. */
function isTitleOnlyListItem(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as Record<string, unknown>;
  const metaKeys = new Set([
    "list_name",
    "listName",
    "רשימה",
    "list_type",
    "listType",
    "targets",
    "attachment_ids",
    "detach_attachment_ids",
    "linked_list_ids",
    "linked_lists",
    "unlink_list_ids",
  ]);
  const titleKeys = new Set([
    "name",
    "item_name",
    "שם פריט",
    "שם",
    "title",
    "שם רשימה",
    "list_title",
  ]);
  const filled = Object.entries(record).filter(([key, value]) => {
    if (metaKeys.has(key)) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim() !== "";
    }
    return value != null;
  });
  if (filled.length === 0) {
    return true;
  }
  if (filled.length !== 1) {
    return false;
  }
  return titleKeys.has(filled[0][0]);
}

function parseHandoff(meta: Record<string, unknown>): LlmHandoffAction | null {
  const raw = meta.handoff ?? meta.switch ?? meta.talk_to ?? meta.talkTo;
  if (typeof raw === "string" && raw.trim()) {
    return { worker: raw.trim() };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const worker = readText(raw as Record<string, unknown>, [
    "worker",
    "name",
    "to",
    "employee",
  ]);
  return worker ? { worker } : null;
}

const REPORT_SECTION_ALIASES: Record<string, ReportSection> = {
  reminders: "reminders",
  reminder: "reminders",
  clocks: "reminders",
  תזכורות: "reminders",
  תזכורת: "reminders",
  שעונים: "reminders",
  sends: "sends",
  send: "sends",
  scheduled: "sends",
  messages: "sends",
  שליחות: "sends",
  הודעות: "sends",
  tasks: "tasks",
  task: "tasks",
  todos: "tasks",
  מטלות: "tasks",
  משימות: "tasks",
  shopping: "shopping",
  shop: "shopping",
  קניות: "shopping",
  filings: "filings",
  filing: "filings",
  תיוקים: "filings",
  תיוק: "filings",
  contacts: "contacts",
  contact: "contacts",
  directory: "contacts",
  "אנשי קשר": "contacts",
  custom: "custom",
  lists: "custom",
  list: "custom",
  רשימות: "custom",
  history: "history",
  היסטוריה: "history",
};

const REPORT_HISTORY_KIND_ALIASES: Record<string, ReportHistoryKind> = {
  add: "add",
  added: "add",
  adds: "add",
  create: "add",
  created: "add",
  נוסף: "add",
  נוספו: "add",
  התווסף: "add",
  התווספו: "add",
  הוספות: "add",
  update: "update",
  updated: "update",
  updates: "update",
  edit: "update",
  edited: "update",
  עודכן: "update",
  עודכנו: "update",
  עדכונים: "update",
  remove: "remove",
  removed: "remove",
  removes: "remove",
  delete: "remove",
  deleted: "remove",
  deletes: "remove",
  cancel: "remove",
  cancelled: "remove",
  canceled: "remove",
  מחיקות: "remove",
  נמחק: "remove",
  נמחקו: "remove",
  בוטל: "remove",
  בוטלו: "remove",
  fire: "fire",
  fired: "fire",
  sent: "fire",
  נשלח: "fire",
  נשלחו: "fire",
};

function normalizeReportSectionToken(raw: string): ReportSection | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === "all" || value === "הכל" || value === "כולם") {
    return null;
  }
  return REPORT_SECTION_ALIASES[value] ?? REPORT_SECTION_ALIASES[raw.trim()] ?? null;
}

function normalizeReportHistoryKindToken(raw: string): ReportHistoryKind | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  return (
    REPORT_HISTORY_KIND_ALIASES[value] ??
    REPORT_HISTORY_KIND_ALIASES[raw.trim()] ??
    null
  );
}

function collectReportSectionTokens(meta: Record<string, unknown>): string[] {
  const collected: string[] = [];
  const fromFields =
    meta.sections ?? meta.report ?? meta.report_sections ?? meta.reportSections;
  if (Array.isArray(fromFields)) {
    for (const entry of fromFields) {
      if (typeof entry === "string" && entry.trim()) {
        collected.push(entry.trim());
      }
    }
  } else if (typeof fromFields === "string" && fromFields.trim()) {
    collected.push(
      ...fromFields.split(/[,+|]/).map((part) => part.trim()).filter(Boolean),
    );
  }

  const queryRaw = meta.query ?? meta.show ?? meta.list;
  if (typeof queryRaw === "string") {
    const match = queryRaw.trim().match(/^report\s*[=:]\s*(.+)$/i);
    if (match?.[1]) {
      collected.push(
        ...match[1].split(/[,+|]/).map((part) => part.trim()).filter(Boolean),
      );
    }
  }
  return collected;
}

export function parseReportSections(meta: Record<string, unknown>): ReportSection[] {
  const sections: ReportSection[] = [];
  let sawHistoryKindToken = false;
  for (const token of collectReportSectionTokens(meta)) {
    const section = normalizeReportSectionToken(token);
    if (section) {
      if (!sections.includes(section)) {
        sections.push(section);
      }
      continue;
    }
    if (normalizeReportHistoryKindToken(token)) {
      sawHistoryKindToken = true;
    }
  }
  // "מה נמחק" / sections:["מחיקות"] → history with remove filter.
  if (sawHistoryKindToken && !sections.includes("history")) {
    sections.push("history");
  }
  return sections;
}

export function parseReportHistoryKinds(
  meta: Record<string, unknown>,
  sections: ReportSection[] = parseReportSections(meta),
): ReportHistoryKind[] {
  const kinds: ReportHistoryKind[] = [];
  const push = (kind: ReportHistoryKind | null) => {
    if (kind && !kinds.includes(kind)) {
      kinds.push(kind);
    }
  };

  const fromField =
    meta.history_kinds ??
    meta.historyKinds ??
    meta.report_history_kinds ??
    meta.reportHistoryKinds;
  if (Array.isArray(fromField)) {
    for (const entry of fromField) {
      if (typeof entry === "string") {
        push(normalizeReportHistoryKindToken(entry));
      }
    }
  } else if (typeof fromField === "string" && fromField.trim()) {
    for (const part of fromField.split(/[,+|]/)) {
      push(normalizeReportHistoryKindToken(part));
    }
  }

  for (const token of collectReportSectionTokens(meta)) {
    // Kind aliases that are also sections (none today) stay as sections only.
    if (normalizeReportSectionToken(token)) {
      continue;
    }
    push(normalizeReportHistoryKindToken(token));
  }

  if (kinds.length > 0 && !sections.includes("history")) {
    // Defensive: kinds without history section are ignored by the reporter.
    return kinds;
  }
  return kinds;
}

function parseConfirm(meta: Record<string, unknown>): boolean | null {
  const raw = meta.confirm ?? meta.confirmed;
  if (raw === true) {
    return true;
  }
  if (raw === false) {
    return false;
  }
  return null;
}

function parseRegister(meta: Record<string, unknown>): LlmRegisterAction | null {
  const raw = meta.register ?? meta.registration ?? meta.signup;
  if (raw == null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const surname =
    typeof record.surname === "string"
      ? record.surname.trim()
      : typeof record.last_name === "string"
        ? record.last_name.trim()
        : typeof record.lastName === "string"
          ? record.lastName.trim()
          : "";
  const username =
    typeof record.username === "string"
      ? record.username.trim()
      : typeof record.user_name === "string"
        ? record.user_name.trim()
        : "";
  const password =
    typeof record.password === "string"
      ? record.password
      : typeof record.pass === "string"
        ? record.pass
        : "";
  if (!name || !surname || !username || !password) {
    return null;
  }
  return { name, surname, username, password };
}

/** Replace plaintext password in stored chat / audit text. */
export function redactRegisterSecrets(
  text: string,
  register: LlmRegisterAction | null | undefined,
): string {
  if (!register?.password || !text) {
    return text;
  }
  const password = register.password;
  if (!password) {
    return text;
  }
  return text.split(password).join("••••••••");
}

/** Strip password from metadata before persisting LLM raw / audit. */
export function redactMetadataSecrets(metadata: LlmMetadata): LlmMetadata {
  if (!metadata.register?.password) {
    return metadata;
  }
  return {
    ...metadata,
    register: {
      ...metadata.register,
      password: "••••••••",
    },
  };
}

function parseMessageActions(meta: Record<string, unknown>): LlmMessageAction[] {
  const raw = meta.messages ?? meta.relays ?? meta.outbound;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    const action = toMessageAction(entry);
    return action ? [action] : [];
  });
}

function parseReminderActions(meta: Record<string, unknown>): LlmReminderAction[] {
  const raw = meta.reminders ?? meta.schedules;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries.flatMap((entry) => {
    const action = toReminderAction(entry);
    return action ? [action] : [];
  });
}

function parseDirectoryActions(meta: Record<string, unknown>): LlmDirectoryAction[] {
  const raw = meta.directory ?? meta.phonebook ?? meta.saved_contacts;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const action = toDirectoryAction(entry);
    return action ? [action] : [];
  });
}

function toDirectoryAction(value: unknown): LlmDirectoryAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const actionRaw = String(record.action ?? "add")
    .trim()
    .toLowerCase();
  const action: LlmDirectoryActionName | null =
    actionRaw === "add" || actionRaw === "save" || actionRaw === "create"
      ? "add"
      : actionRaw === "remove" || actionRaw === "delete"
        ? "remove"
        : actionRaw === "update" || actionRaw === "edit" || actionRaw === "change"
          ? "update"
          : actionRaw === "share_book" ||
              actionRaw === "share-book" ||
              actionRaw === "set_book_participants"
            ? "share_book"
            : null;
  if (!action) {
    return null;
  }
  const contactId = readText(record, ["contact_id", "contactId", "id"]);
  const name = readText(record, ["name", "שם", "contact", "label"]);
  const phone = readText(record, ["phone", "טלפון", "number", "whatsapp"]);
  const targets = parseTargets(record);
  const unshareWith = readStringList(
    record.unshare_with ?? record.unshareWith,
  );
  if (action === "share_book") {
    return {
      action,
      name: "",
      phone: "",
      contactId: "",
      targets,
      ...(unshareWith.length > 0 ? { unshareWith } : {}),
    };
  }
  if (action === "remove" || action === "update") {
    if (!contactId) {
      return null;
    }
    return {
      action,
      name,
      phone,
      contactId,
      targets,
      ...(unshareWith.length > 0 ? { unshareWith } : {}),
    };
  }
  if (!name || !phone) {
    return null;
  }
  return { action, name, phone, contactId: "", targets };
}

function reminderActionName(value: unknown): LlmReminderActionName | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (REMINDER_ACTIONS.has(raw as LlmReminderActionName)) {
    return raw as LlmReminderActionName;
  }
  if (raw === "create" || raw === "new" || raw === "schedule" || raw === "set") {
    return "add";
  }
  if (raw === "delete" || raw === "cancel") {
    return "remove";
  }
  if (raw === "edit" || raw === "change") {
    return "update";
  }
  return null;
}

function toReminderAction(value: unknown): LlmReminderAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const action = reminderActionName(record.action);
  if (!action) {
    return null;
  }

  const item = readText(record, [
    "item",
    "item_name",
    "title",
    "label",
    "שם פריט",
    "שם מטלה",
    "name",
  ]);
  const reminderId = readText(record, ["reminder_id", "reminderId", "id"]);
  if (action === "remove" || action === "update") {
    if (!reminderId) {
      return null;
    }
  } else if (!item) {
    return null;
  }

  const listRaw = String(record.list_type ?? record.listType ?? "").trim();
  const listType = LIST_TYPES.has(listRaw as LlmListType)
    ? (listRaw as LlmListType)
    : "shopping";
  const interval = parseReminderInterval(record);
  const recurrence = clockRecurrence(record.recurrence);
  const recurrenceRecord =
    record.recurrence && typeof record.recurrence === "object"
      ? (record.recurrence as Record<string, unknown>)
      : null;
  const stopsRecurrence =
    String(recurrenceRecord?.freq ?? "").trim().toLowerCase() === "none";
  const occurrenceChange =
    action === "update"
      ? parseRecurrenceException(record.occurrence_change ?? record.occurrenceChange)
      : null;
  const repeatRaw = String(record.repeat ?? "").trim().toLowerCase();
  const repeat = REMINDER_REPEATS.has(repeatRaw as LlmReminderRepeat)
    ? (repeatRaw as LlmReminderRepeat)
    : recurrence
      ? recurrence.freq === "interval"
        ? "hourly"
        : recurrence.freq === "yearly"
          ? "monthly"
          : recurrence.freq
    : interval
      ? interval.unit === "hours"
        ? "hourly"
        : interval.unit === "days"
          ? "daily"
          : interval.unit === "weeks"
            ? "weekly"
            : interval.unit === "months"
              ? "monthly"
              : interval.unit === "weekdays"
                ? "weekly"
                : "daily"
      : "once";
  const date = readText(record, ["date"]);
  const time = parseClockField(readText(record, ["time"]));
  const inSeconds = parseInSeconds(record);

  const compose =
    record.compose === true ||
    record.compose_at_fire === true ||
    record.composeAtFire === true ||
    record.dynamic === true ||
    parseComposeSource(record) === "git_log" ||
    parseComposeSource(record) === "saved_data" ||
    parseComposeSource(record) === "weather" ||
    parseComposeSource(record) === "market" ||
    parseComposeSource(record) === "mashov";

  return {
    action,
    item,
    listType,
    date,
    time,
    repeat,
    ping: parseTargets({ targets: record.ping ?? record.notify ?? record.ping_targets }),
    about: parseTargets({
      targets: record.about ?? record.about_names ?? record.aboutNames,
    }),
    targets: parseTargets(record),
    text: readText(record, ["text", "message", "body", "תוכן", "sentence"]),
    inSeconds,
    everyCount: interval?.count ?? null,
    everyUnit: interval?.unit ?? null,
    weekdays: interval?.weekdays ?? null,
    ...(recurrence ? { recurrence } : stopsRecurrence ? { recurrence: null } : {}),
    confirmed: record.confirmed === true || record.confirm === true,
    compose,
    composeSource: parseComposeSource(record),
    composeLookbackHours: parseComposeLookbackHours(record),
    composePlace: parseComposePlace(record),
    scheduleAnchor: parseScheduleAnchor(record),
    scheduleOffsetMinutes: parseScheduleOffsetMinutes(record),
    composeCondition: parseComposeCondition(
      record.compose_condition ?? record.composeCondition,
    ),
    watchOnce: parseWatchOnce(record),
    composeAspects: parseComposeAspectsList(
      record.compose_aspects ?? record.composeAspects,
    ),
    reminderId,
    ...(occurrenceChange ? { occurrenceChange } : {}),
    ...optionalIds("attachmentIds", record.attachment_ids ?? record.attachmentIds),
    ...optionalIds(
      "detachAttachmentIds",
      record.detach_attachment_ids ?? record.detachAttachmentIds,
    ),
  };
}

function parseComposeLookbackHours(record: Record<string, unknown>): number {
  const minutesRaw =
    record.compose_lookback_minutes ?? record.composeLookbackMinutes;
  if (typeof minutesRaw === "number" && Number.isFinite(minutesRaw) && minutesRaw > 0) {
    return Math.min(minutesRaw / 60, 24 * 90);
  }
  if (typeof minutesRaw === "string" && /^\d+(\.\d+)?$/.test(minutesRaw.trim())) {
    const minutes = Number(minutesRaw.trim());
    return minutes > 0 ? Math.min(minutes / 60, 24 * 90) : 0;
  }

  const raw =
    record.compose_lookback_hours ??
    record.composeLookbackHours ??
    record.lookback_hours ??
    record.lookbackHours;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(raw, 24 * 90);
  }
  if (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim())) {
    const hours = Number(raw.trim());
    return hours > 0 ? Math.min(hours, 24 * 90) : 0;
  }
  return 0;
}

function parseComposeSource(
  record: Record<string, unknown>,
): "" | "git_log" | "saved_data" | "weather" | "market" | "mashov" {
  const raw = String(
    record.compose_source ??
      record.composeSource ??
      record.source ??
      record.compose_from ??
      "",
  )
    .trim()
    .toLowerCase();
  if (
    raw === "git" ||
    raw === "git_log" ||
    raw === "changelog" ||
    raw === "commits" ||
    raw === "digest"
  ) {
    return "git_log";
  }
  if (
    raw === "saved_data" ||
    raw === "saved" ||
    raw === "employee_saved_data" ||
    raw === "status" ||
    raw === "snapshot"
  ) {
    return "saved_data";
  }
  if (
    raw === "weather" ||
    raw === "meteo" ||
    raw === "forecast" ||
    raw === "open_meteo"
  ) {
    return "weather";
  }
  if (
    raw === "market" ||
    raw === "stocks" ||
    raw === "stock" ||
    raw === "crypto" ||
    raw === "finance" ||
    raw === "yahoo"
  ) {
    return "market";
  }
  if (
    raw === "mashov" ||
    raw === "smart_school" ||
    raw === "smartschool" ||
    raw === "משוב"
  ) {
    return "mashov";
  }
  return "";
}

function parseComposePlace(record: Record<string, unknown>): string {
  return readText(record, [
    "compose_place",
    "composePlace",
    "weather_place",
    "weatherPlace",
    "market_symbols",
    "marketSymbols",
    "symbols",
    "place",
    "city",
    "עיר",
  ]).slice(0, 255);
}

function parseScheduleAnchor(
  record: Record<string, unknown>,
): "" | "jewish_candles" {
  const raw = String(
    record.schedule_anchor ??
      record.scheduleAnchor ??
      record.anchor ??
      "",
  )
    .trim()
    .toLowerCase();
  if (
    raw === "jewish_candles" ||
    raw === "candles" ||
    raw === "candle_lighting" ||
    raw === "shabbat_candles" ||
    raw === "נרות" ||
    raw === "הדלקת נרות"
  ) {
    return "jewish_candles";
  }
  return "";
}

function parseScheduleOffsetMinutes(record: Record<string, unknown>): number {
  const beforeRaw =
    record.minutes_before ??
    record.minutesBefore ??
    record.offset_before_minutes ??
    record.offsetBeforeMinutes;
  if (typeof beforeRaw === "number" && Number.isFinite(beforeRaw)) {
    return -Math.abs(Math.trunc(beforeRaw));
  }
  if (typeof beforeRaw === "string" && /^-?\d+$/.test(beforeRaw.trim())) {
    return -Math.abs(Number(beforeRaw.trim()));
  }

  const raw =
    record.offset_minutes ??
    record.offsetMinutes ??
    record.schedule_offset_minutes ??
    record.scheduleOffsetMinutes;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return 0;
}

const MARKET_PRICE_OPS = new Set(["lt", "lte", "gt", "gte", "eq"]);

function parseDayOffset(raw: unknown): number | undefined {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const n = Math.round(value);
  if (n < -7 || n > 7) {
    return undefined;
  }
  return n;
}

/**
 * Parse reminders[].watch_once.
 * Returns undefined when absent so the engine can default watches to one-shot.
 */
export function parseWatchOnce(
  record: Record<string, unknown>,
): boolean | undefined {
  const raw = record.watch_once ?? record.watchOnce ?? record.once;
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (raw === true || raw === "true" || raw === 1 || raw === "1") {
    return true;
  }
  if (raw === false || raw === "false" || raw === 0 || raw === "0") {
    return false;
  }
  return undefined;
}

/** Parse reminders[].compose_aspects — empty array when absent/invalid. */
export function parseComposeAspectsList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim()) {
      return raw
        .split(/[,;|]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12);
    }
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    const key = String(entry ?? "")
      .trim()
      .toLowerCase();
    if (key && !out.includes(key)) {
      out.push(key.slice(0, 32));
    }
    if (out.length >= 12) {
      break;
    }
  }
  return out;
}

/** Parse reminders[].compose_condition — null when absent or invalid. */
export function parseComposeCondition(raw: unknown): LlmComposeCondition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const type = String(record.type ?? "")
    .trim()
    .toLowerCase();
  if (type === "weather_rain" || type === "rain") {
    const dayOffset = parseDayOffset(
      record.day_offset ?? record.dayOffset ?? record.offset,
    );
    return dayOffset != null && dayOffset !== 0
      ? { type: "weather_rain", dayOffset }
      : { type: "weather_rain" };
  }
  if (
    type === "weather_changed" ||
    type === "weather_change" ||
    type === "weather_diff"
  ) {
    const dayOffset = parseDayOffset(
      record.day_offset ?? record.dayOffset ?? record.offset,
    );
    return dayOffset != null && dayOffset !== 0
      ? { type: "weather_changed", dayOffset }
      : { type: "weather_changed" };
  }
  if (type === "mashov_new" || type === "mashov") {
    return { type: "mashov_new" };
  }
  if (
    type === "market_change_compare" ||
    type === "market_compare" ||
    type === "change_compare"
  ) {
    const left = readText(record, ["left", "a", "first", "דולר"]).slice(0, 64);
    const right = readText(record, ["right", "b", "second", "יורו"]).slice(0, 64);
    const op = String(record.op ?? record.operator ?? "gt")
      .trim()
      .toLowerCase();
    const metricRaw = String(record.metric ?? "daily_change_pct")
      .trim()
      .toLowerCase();
    const metric =
      metricRaw === "daily_change_pct" ||
      metricRaw === "change_pct" ||
      metricRaw === "pct"
        ? "daily_change_pct"
        : null;
    const leftDayOffset =
      parseDayOffset(
        record.left_day_offset ?? record.leftDayOffset ?? record.left_offset,
      ) ?? 0;
    const rightDayOffset =
      parseDayOffset(
        record.right_day_offset ??
          record.rightDayOffset ??
          record.right_offset,
      ) ?? 0;
    if (!left || !right || !MARKET_PRICE_OPS.has(op) || !metric) {
      return null;
    }
    return {
      type: "market_change_compare",
      left,
      right,
      op: op as "lt" | "lte" | "gt" | "gte" | "eq",
      metric,
      leftDayOffset,
      rightDayOffset,
    };
  }
  if (type === "market_price" || type === "market" || type === "price") {
    const op = String(record.op ?? record.operator ?? "")
      .trim()
      .toLowerCase();
    const valueRaw = record.value ?? record.threshold ?? record.price;
    const value =
      typeof valueRaw === "number"
        ? valueRaw
        : typeof valueRaw === "string" && /^-?\d+(\.\d+)?$/.test(valueRaw.trim())
          ? Number(valueRaw.trim())
          : NaN;
    if (!MARKET_PRICE_OPS.has(op) || !Number.isFinite(value)) {
      return null;
    }
    return {
      type: "market_price",
      op: op as "lt" | "lte" | "gt" | "gte" | "eq",
      value,
    };
  }
  if (
    type === "bus_eta" ||
    type === "bus" ||
    type === "transit_eta" ||
    type === "route_eta"
  ) {
    const origin = readText(record, [
      "origin",
      "from",
      "stop",
      "station",
      "תחנה",
    ]).slice(0, 255);
    const destination = readText(record, [
      "destination",
      "to",
      "direction",
      "יעד",
      "כיוון",
    ]).slice(0, 255);
    const line = readText(record, ["line", "route", "קו"])
      .replace(/^קו\s+/u, "")
      .trim()
      .slice(0, 32);
    const headsign = readText(record, [
      "headsign",
      "direction_label",
      "toward",
    ]).slice(0, 255);
    const minutesRaw =
      record.minutes_before ??
      record.minutesBefore ??
      record.offset_minutes ??
      record.offsetMinutes ??
      record.minutes;
    const minutesBefore =
      typeof minutesRaw === "number"
        ? Math.round(minutesRaw)
        : typeof minutesRaw === "string" && /^-?\d+$/.test(minutesRaw.trim())
          ? Number(minutesRaw.trim())
          : NaN;
    if (!origin || !destination || !line || !Number.isFinite(minutesBefore)) {
      return null;
    }
    return {
      type: "bus_eta",
      origin,
      destination,
      line,
      headsign,
      minutesBefore: Math.abs(minutesBefore) || 10,
    };
  }
  if (
    type === "flight_eta" ||
    type === "flight_arrival" ||
    type === "flight_departure" ||
    type === "flight_before"
  ) {
    const airport = readText(record, [
      "airport",
      "hub",
      "from_airport",
      "שדה",
    ]).slice(0, 32);
    const directionRaw = readText(record, [
      "direction",
      "leg",
      "kind",
      "כיוון",
    ])
      .trim()
      .toLowerCase();
    const direction: "arrivals" | "departures" =
      directionRaw === "departures" ||
      directionRaw === "departure" ||
      directionRaw === "dep" ||
      directionRaw === "המראה" ||
      directionRaw === "המראות"
        ? "departures"
        : "arrivals";
    const flight = readText(record, [
      "flight",
      "flight_number",
      "flightNumber",
      "flight_iata",
      "code",
      "טיסה",
    ]).slice(0, 32);
    const airline = readText(record, ["airline", "carrier", "חברה"]).slice(
      0,
      64,
    );
    const city = readText(record, [
      "city",
      "destination",
      "origin_city",
      "עיר",
      "יעד",
    ]).slice(0, 64);
    const minutesRaw =
      record.minutes_before ??
      record.minutesBefore ??
      record.offset_minutes ??
      record.offsetMinutes ??
      record.minutes;
    const hoursRaw =
      record.hours_before ??
      record.hoursBefore ??
      record.offset_hours ??
      record.offsetHours ??
      record.hours;
    const minutesBefore =
      typeof minutesRaw === "number"
        ? Math.round(minutesRaw)
        : typeof minutesRaw === "string" && /^-?\d+$/.test(minutesRaw.trim())
          ? Number(minutesRaw.trim())
          : 0;
    const hoursBefore =
      typeof hoursRaw === "number"
        ? Math.round(hoursRaw)
        : typeof hoursRaw === "string" && /^-?\d+$/.test(hoursRaw.trim())
          ? Number(hoursRaw.trim())
          : 0;
    const mins = Number.isFinite(minutesBefore) ? Math.abs(minutesBefore) : 0;
    const hours = Number.isFinite(hoursBefore) ? Math.abs(hoursBefore) : 0;
    if ((!flight && !airline && !city) || (mins === 0 && hours === 0)) {
      return null;
    }
    return {
      type: "flight_eta",
      airport,
      direction,
      flight,
      airline,
      city,
      minutesBefore: mins,
      hoursBefore: hours,
    };
  }
  if (
    type === "flight_changed" ||
    type === "flight_change" ||
    type === "flight_status"
  ) {
    const airport = readText(record, [
      "airport",
      "hub",
      "from_airport",
      "שדה",
    ]).slice(0, 32);
    const directionRaw = readText(record, [
      "direction",
      "leg",
      "kind",
      "כיוון",
    ])
      .trim()
      .toLowerCase();
    const direction: "arrivals" | "departures" =
      directionRaw === "departures" ||
      directionRaw === "departure" ||
      directionRaw === "dep" ||
      directionRaw === "המראה" ||
      directionRaw === "המראות"
        ? "departures"
        : "arrivals";
    const flight = readText(record, [
      "flight",
      "flight_number",
      "flightNumber",
      "flight_iata",
      "code",
      "טיסה",
    ]).slice(0, 32);
    if (!flight) {
      return null;
    }
    return {
      type: "flight_changed",
      airport,
      direction,
      flight,
    };
  }
  if (type === "expr" || type === "expression" || type === "numeric") {
    return parseExprCondition(record);
  }
  if (
    type === "field_changed" ||
    type === "field_change" ||
    type === "value_changed"
  ) {
    return parseFieldChangedCondition(record);
  }
  return null;
}

const WATCH_EXPR_OPS = new Set<WatchExprOp>([
  "add",
  "sub",
  "mul",
  "div",
  "pct",
]);
const WATCH_EXPR_COMPARE = new Set<WatchExprCompare>([
  "lt",
  "lte",
  "gt",
  "gte",
  "eq",
  "approx",
]);
const WATCH_EXPR_FIELDS = new Set([
  "weather.temp_now",
  "weather.temp_max",
  "weather.temp_min",
  "weather.is_rain",
  "market.price",
  "market.change_pct",
  "market.change_abs",
]);
const WATCH_EXPR_MAX_DEPTH = 3;
const WATCH_EXPR_MAX_LEAVES = 4;

function parseNumberLeaf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

/** Count leaf nodes (const / field) in an expr tree. */
export function countWatchExprLeaves(node: WatchExprNode): number {
  if ("const" in node || "field" in node) {
    return 1;
  }
  if ("op" in node && Array.isArray(node.args)) {
    return node.args.reduce((sum, arg) => sum + countWatchExprLeaves(arg), 0);
  }
  return 0;
}

export function parseWatchExprNode(
  raw: unknown,
  depth = 0,
): WatchExprNode | null {
  if (depth > WATCH_EXPR_MAX_DEPTH) {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const n = parseNumberLeaf(raw);
    return n != null ? { const: n } : null;
  }
  const row = raw as Record<string, unknown>;
  if ("const" in row || "value" in row || "n" in row) {
    const n = parseNumberLeaf(row.const ?? row.value ?? row.n);
    return n != null ? { const: n } : null;
  }
  const fieldRaw = row.field ?? row.path ?? row.name;
  if (typeof fieldRaw === "string" && fieldRaw.trim()) {
    const field = fieldRaw.trim().toLowerCase().replace(/\s+/g, "_");
    const normalized =
      field === "temp_now" || field === "temperature"
        ? "weather.temp_now"
        : field === "temp_max" || field === "tmax"
          ? "weather.temp_max"
          : field === "temp_min" || field === "tmin"
            ? "weather.temp_min"
            : field === "is_rain" || field === "rain"
              ? "weather.is_rain"
              : field === "price"
                ? "market.price"
                : field === "change_pct" || field === "pct_change"
                  ? "market.change_pct"
                  : field === "change_abs"
                    ? "market.change_abs"
                    : field.startsWith("weather.") || field.startsWith("market.")
                      ? field
                      : field;
    if (!WATCH_EXPR_FIELDS.has(normalized)) {
      return null;
    }
    const place = readText(row, ["place", "location", "city", "מקום"]).slice(
      0,
      255,
    );
    const symbol = readText(row, [
      "symbol",
      "ticker",
      "query",
      "סימול",
    ]).slice(0, 64);
    const dayOffset = parseDayOffset(
      row.day_offset ?? row.dayOffset ?? row.offset,
    );
    return {
      field: normalized,
      ...(place ? { place } : {}),
      ...(symbol ? { symbol } : {}),
      ...(dayOffset != null ? { dayOffset } : {}),
    };
  }
  const opRaw = String(row.op ?? row.operator ?? "")
    .trim()
    .toLowerCase();
  const opAlias: Record<string, WatchExprOp> = {
    add: "add",
    "+": "add",
    plus: "add",
    sub: "sub",
    "-": "sub",
    minus: "sub",
    mul: "mul",
    "*": "mul",
    times: "mul",
    multiply: "mul",
    div: "div",
    "/": "div",
    divide: "div",
    pct: "pct",
    percent: "pct",
    "%": "pct",
  };
  const op = opAlias[opRaw];
  if (!op || !WATCH_EXPR_OPS.has(op)) {
    return null;
  }
  const argsRaw = row.args ?? row.operands ?? row.children;
  if (!Array.isArray(argsRaw) || argsRaw.length < 2 || argsRaw.length > 4) {
    return null;
  }
  const args: WatchExprNode[] = [];
  for (const entry of argsRaw) {
    const child = parseWatchExprNode(entry, depth + 1);
    if (!child) {
      return null;
    }
    args.push(child);
  }
  if (countWatchExprLeaves({ op, args }) > WATCH_EXPR_MAX_LEAVES) {
    return null;
  }
  return { op, args };
}

function parseExprCondition(
  record: Record<string, unknown>,
): Extract<LlmComposeCondition, { type: "expr" }> | null {
  const compareRaw = String(
    record.compare ?? record.op ?? record.operator ?? "eq",
  )
    .trim()
    .toLowerCase();
  const compareAlias: Record<string, WatchExprCompare> = {
    lt: "lt",
    "<": "lt",
    lte: "lte",
    "<=": "lte",
    gt: "gt",
    ">": "gt",
    gte: "gte",
    ">=": "gte",
    eq: "eq",
    "=": "eq",
    "==": "eq",
    approx: "approx",
    "~": "approx",
    about: "approx",
  };
  const compare = compareAlias[compareRaw];
  if (!compare || !WATCH_EXPR_COMPARE.has(compare)) {
    return null;
  }
  const left = parseWatchExprNode(record.left ?? record.lhs ?? record.a);
  const right = parseWatchExprNode(record.right ?? record.rhs ?? record.b);
  if (!left || !right) {
    return null;
  }
  if (
    countWatchExprLeaves(left) + countWatchExprLeaves(right) >
    WATCH_EXPR_MAX_LEAVES
  ) {
    return null;
  }
  const tolRaw = record.tol ?? record.tolerance ?? record.epsilon;
  const tol =
    typeof tolRaw === "number" && Number.isFinite(tolRaw) && tolRaw >= 0
      ? tolRaw
      : typeof tolRaw === "string" && /^\d+(\.\d+)?$/.test(tolRaw.trim())
        ? Number(tolRaw.trim())
        : undefined;
  return {
    type: "expr",
    compare,
    left,
    right,
    ...(tol != null ? { tol } : {}),
  };
}

function parseFieldChangedCondition(
  record: Record<string, unknown>,
): Extract<LlmComposeCondition, { type: "field_changed" }> | null {
  const leaf = parseWatchExprNode({
    field: record.field ?? record.path ?? record.name,
    place: record.place ?? record.location ?? record.city,
    symbol: record.symbol ?? record.ticker ?? record.query,
    day_offset: record.day_offset ?? record.dayOffset,
  });
  if (!leaf || !("field" in leaf)) {
    return null;
  }
  return {
    type: "field_changed",
    field: leaf.field,
    ...(leaf.place ? { place: leaf.place } : {}),
    ...(leaf.symbol ? { symbol: leaf.symbol } : {}),
    ...(leaf.dayOffset != null ? { dayOffset: leaf.dayOffset } : {}),
  };
}

const WEATHER_ASPECTS = new Set<LlmWeatherAspect>([
  "summary",
  "temp",
  "wind",
  "waves",
  "humidity",
]);

/** metadata.weather — live Open-Meteo fetch; engine replaces response. */
export function parseWeatherAction(
  meta: Record<string, unknown>,
): LlmWeatherAction | null {
  const raw = meta.weather;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const place = readText(row, ["place", "location", "city", "מקום"]).slice(
    0,
    255,
  );
  if (!place) {
    return null;
  }
  const dateRaw = readText(row, ["date", "day", "on"]);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : "";
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmWeatherAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      const key = String(entry ?? "")
        .trim()
        .toLowerCase() as LlmWeatherAspect;
      if (WEATHER_ASPECTS.has(key) && !aspects.includes(key)) {
        aspects.push(key);
      }
    }
  }
  return {
    place,
    date,
    aspects: aspects.length > 0 ? aspects : ["summary"],
  };
}

const MARKET_ASPECTS = new Set<LlmMarketAspect>([
  "summary",
  "price",
  "change",
  "range",
]);

/** metadata.market — live Yahoo Finance fetch; engine replaces response. */
export function parseMarketAction(
  meta: Record<string, unknown>,
): LlmMarketAction | null {
  const raw = meta.market;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const queriesRaw =
    row.queries ?? row.symbols ?? row.tickers ?? row.query ?? row.symbol;
  const queries: string[] = [];
  if (Array.isArray(queriesRaw)) {
    for (const entry of queriesRaw) {
      const q = String(entry ?? "")
        .trim()
        .slice(0, 80);
      if (q && !queries.includes(q)) {
        queries.push(q);
      }
      if (queries.length >= 5) {
        break;
      }
    }
  } else {
    const single = String(queriesRaw ?? "")
      .trim()
      .slice(0, 80);
    if (single) {
      queries.push(single);
    }
  }
  if (queries.length === 0) {
    return null;
  }
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmMarketAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      const key = String(entry ?? "")
        .trim()
        .toLowerCase() as LlmMarketAspect;
      if (MARKET_ASPECTS.has(key) && !aspects.includes(key)) {
        aspects.push(key);
      }
    }
  }
  return {
    queries,
    aspects: aspects.length > 0 ? aspects : ["summary"],
  };
}

const MASHOV_ASPECTS = new Set<LlmMashovAspect>([
  "grades",
  "homework",
  "behavior",
  "timetable",
]);

/** metadata.mashov — live Mashov fetch from filings; never includes password. */
export function parseMashovAction(
  meta: Record<string, unknown>,
): LlmMashovAction | null {
  const raw = meta.mashov ?? meta.smart_school ?? meta.smartSchool;
  if (raw === null || raw === undefined) {
    return null;
  }
  if (raw === true || raw === "true") {
    return { child: "", aspects: ["grades"] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const child = readText(row, ["child", "student", "name", "ילד"]).slice(0, 80);
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmMashovAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      let key = String(entry ?? "")
        .trim()
        .toLowerCase();
      if (key === "behave" || key === "behaviour") {
        key = "behavior";
      }
      if (key === "schedule") {
        key = "timetable";
      }
      const aspect = key as LlmMashovAspect;
      if (MASHOV_ASPECTS.has(aspect) && !aspects.includes(aspect)) {
        aspects.push(aspect);
      }
    }
  }
  return {
    child,
    aspects: aspects.length > 0 ? aspects : ["grades"],
  };
}

const PLACES_ASPECTS = new Set<LlmPlacesAspect>([
  "summary",
  "phone",
  "address",
  "hours",
]);

function parseOptionalCoord(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

/** metadata.places — live Google Places fetch; engine replaces response. */
export function parsePlacesAction(
  meta: Record<string, unknown>,
): LlmPlacesAction | null {
  const raw = meta.places ?? meta.local_search ?? meta.localSearch;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const query = readText(row, [
    "query",
    "q",
    "what",
    "business",
    "category",
    "חיפוש",
  ]).slice(0, 255);
  const nearRaw = readText(row, ["near", "near_me", "nearMe", "around"])
    .trim()
    .toLowerCase();
  const near: "speaker" | "" =
    nearRaw === "speaker" ||
    nearRaw === "me" ||
    nearRaw === "here" ||
    nearRaw === "כאן" ||
    nearRaw === "שלי"
      ? "speaker"
      : "";
  const place = readText(row, [
    "place",
    "location",
    "city",
    "area",
    "מקום",
    "עיר",
  ]).slice(0, 255);
  const lat = parseOptionalCoord(row.lat ?? row.latitude);
  const lng = parseOptionalCoord(row.lng ?? row.lon ?? row.longitude);
  const hasPin = lat != null && lng != null;
  if (!query || (!place && near !== "speaker" && !hasPin)) {
    return null;
  }
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmPlacesAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      let key = String(entry ?? "")
        .trim()
        .toLowerCase();
      if (key === "tel" || key === "telephone" || key === "טלפון") {
        key = "phone";
      }
      if (
        key === "addr" ||
        key === "postal" ||
        key === "מיקוד" ||
        key === "כתובת"
      ) {
        key = "address";
      }
      if (key === "open" || key === "opening_hours" || key === "שעות") {
        key = "hours";
      }
      const aspect = key as LlmPlacesAspect;
      if (PLACES_ASPECTS.has(aspect) && !aspects.includes(aspect)) {
        aspects.push(aspect);
      }
    }
  }
  return {
    query,
    place,
    near,
    lat,
    lng,
    aspects: aspects.length > 0 ? aspects : ["summary"],
  };
}

const JEWISH_ASPECTS = new Set<LlmJewishAspect>([
  "summary",
  "candles",
  "havdalah",
  "parasha",
  "holidays",
]);

/** Aspects that need a local place (candle / Havdalah times). */
const JEWISH_PLACE_REQUIRED = new Set<LlmJewishAspect>([
  "summary",
  "candles",
  "havdalah",
]);

/** metadata.jewish — live Hebcal Shabbat / parasha / holidays. */
export function parseJewishAction(
  meta: Record<string, unknown>,
): LlmJewishAction | null {
  const raw =
    meta.jewish ??
    meta.shabbat ??
    meta.hebcal ??
    meta.jewish_calendar ??
    meta.jewishCalendar;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const place = readText(row, [
    "place",
    "location",
    "city",
    "מקום",
    "עיר",
  ]).slice(0, 255);
  const date = readText(row, ["date", "day", "תאריך"]).slice(0, 32);
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmJewishAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      let key = String(entry ?? "")
        .trim()
        .toLowerCase();
      if (
        key === "candle" ||
        key === "candle_lighting" ||
        key === "נרות" ||
        key === "הדלקת נרות"
      ) {
        key = "candles";
      }
      if (
        key === "out" ||
        key === "motzei" ||
        key === "יציאת שבת" ||
        key === "מוצאי שבת" ||
        key === "הבדלה"
      ) {
        key = "havdalah";
      }
      if (
        key === "parsha" ||
        key === "parashat" ||
        key === "torah" ||
        key === "פרשה" ||
        key === "פרשת השבוע"
      ) {
        key = "parasha";
      }
      if (
        key === "holiday" ||
        key === "chag" ||
        key === "חג" ||
        key === "חגים"
      ) {
        key = "holidays";
      }
      if (
        key === "shabbat" ||
        key === "שבת" ||
        key === "זמני שבת" ||
        key === "times"
      ) {
        key = "summary";
      }
      const aspect = key as LlmJewishAspect;
      if (JEWISH_ASPECTS.has(aspect) && !aspects.includes(aspect)) {
        aspects.push(aspect);
      }
    }
  }
  const resolved = aspects.length > 0 ? aspects : (["summary"] as LlmJewishAspect[]);
  const needsPlace = resolved.some((a) => JEWISH_PLACE_REQUIRED.has(a));
  if (needsPlace && !place) {
    return null;
  }
  // Parasha / holidays alone with empty place is OK.
  if (!needsPlace && resolved.every((a) => a === "parasha" || a === "holidays")) {
    return { place: place || "", date, aspects: resolved };
  }
  if (!place && needsPlace) {
    return null;
  }
  return {
    place: place || "",
    date,
    aspects: resolved,
  };
}

const ROUTES_ASPECTS = new Set<LlmRoutesAspect>([
  "summary",
  "duration",
  "steps",
  "fare",
  "eta",
  "frequency",
  "lines",
]);

/** metadata.routes — live Google Routes TRANSIT (A→B / leave-by / next departure / stop board). */
export function parseRoutesAction(
  meta: Record<string, unknown>,
): LlmRoutesAction | null {
  const raw =
    meta.routes ??
    meta.route ??
    meta.directions ??
    meta.trip ??
    meta.transit_trip ??
    meta.transitTrip;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  let origin = readText(row, [
    "origin",
    "from",
    "start",
    "מוצא",
    "מ",
  ]).slice(0, 255);
  const originLower = origin.toLowerCase();
  if (
    originLower === "me" ||
    originLower === "here" ||
    originLower === "כאן" ||
    originLower === "מכאן"
  ) {
    origin = "speaker";
  }
  const destination = readText(row, [
    "destination",
    "to",
    "end",
    "יעד",
    "ל",
    "אל",
  ]).slice(0, 255);
  const departure = readText(row, [
    "departure",
    "departure_time",
    "departureTime",
    "leave",
  ]).slice(0, 64);
  const arrival = readText(row, [
    "arrival",
    "arrival_time",
    "arrivalTime",
    "arrive",
    "arrive_by",
    "arriveBy",
  ]).slice(0, 64);
  const line = readText(row, ["line", "route", "קו"])
    .replace(/^קו\s+/u, "")
    .trim()
    .slice(0, 32);
  const headsign = readText(row, [
    "headsign",
    "direction",
    "toward",
    "כיוון",
  ]).slice(0, 255);
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmRoutesAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      let key = String(entry ?? "")
        .trim()
        .toLowerCase();
      if (
        key === "departures" ||
        key === "next" ||
        key === "arrival" ||
        key === "יציאה"
      ) {
        key = "eta";
      }
      if (key === "freq" || key === "headway" || key === "תדירות") {
        key = "frequency";
      }
      if (
        key === "board" ||
        key === "stop_board" ||
        key === "stopboard" ||
        key === "קווים"
      ) {
        key = "lines";
      }
      const aspect = key as LlmRoutesAspect;
      if (ROUTES_ASPECTS.has(aspect) && !aspects.includes(aspect)) {
        aspects.push(aspect);
      }
    }
  }
  const resolvedAspects: LlmRoutesAspect[] =
    aspects.length > 0 ? aspects : ["summary"];
  const linesOnly = resolvedAspects.includes("lines");
  if (!origin) {
    return null;
  }
  if (!destination && !linesOnly) {
    return null;
  }
  return {
    origin,
    destination,
    departure,
    arrival,
    line,
    headsign,
    aspects: resolvedAspects,
  };
}

const FLIGHTS_ASPECTS = new Set<LlmFlightsAspect>([
  "summary",
  "board",
  "next",
  "status",
  "gate",
  "delay",
]);

/** metadata.flights — live AviationStack airport board / flight status. */
export function parseFlightsAction(
  meta: Record<string, unknown>,
): LlmFlightsAction | null {
  const raw =
    meta.flights ??
    meta.flight ??
    meta.airport_board ??
    meta.airportBoard ??
    meta.aviation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const airport = readText(row, [
    "airport",
    "hub",
    "from_airport",
    "שדה",
    "נתבג",
  ]).slice(0, 32);
  const directionRaw = readText(row, [
    "direction",
    "leg",
    "kind",
    "כיוון",
  ])
    .trim()
    .toLowerCase();
  let direction: LlmFlightsDirection | "" = "";
  if (
    directionRaw === "arrivals" ||
    directionRaw === "arrival" ||
    directionRaw === "arr" ||
    directionRaw === "נחיתה" ||
    directionRaw === "נחיתות"
  ) {
    direction = "arrivals";
  } else if (
    directionRaw === "departures" ||
    directionRaw === "departure" ||
    directionRaw === "dep" ||
    directionRaw === "המראה" ||
    directionRaw === "המראות"
  ) {
    direction = "departures";
  } else if (directionRaw === "both" || directionRaw === "all") {
    direction = "both";
  }
  const airline = readText(row, ["airline", "carrier", "חברה"]).slice(0, 64);
  const city = readText(row, [
    "city",
    "destination",
    "origin_city",
    "עיר",
    "יעד",
  ]).slice(0, 64);
  const flight = readText(row, [
    "flight",
    "flight_number",
    "flightNumber",
    "flight_iata",
    "code",
    "טיסה",
  ]).slice(0, 32);
  const date = readText(row, ["date", "day", "flight_date", "flightDate"]).slice(
    0,
    32,
  );
  const withinRaw =
    row.within_minutes ??
    row.withinMinutes ??
    row.window_minutes ??
    row.windowMinutes ??
    row.minutes;
  const withinMinutes =
    typeof withinRaw === "number" && Number.isFinite(withinRaw)
      ? Math.max(0, Math.round(withinRaw))
      : typeof withinRaw === "string" && /^\d+$/.test(withinRaw.trim())
        ? Number(withinRaw.trim())
        : 0;
  const aspectsRaw = row.aspects ?? row.aspect ?? row.fields;
  const aspects: LlmFlightsAspect[] = [];
  if (Array.isArray(aspectsRaw)) {
    for (const entry of aspectsRaw) {
      const key = String(entry ?? "")
        .trim()
        .toLowerCase() as LlmFlightsAspect;
      if (FLIGHTS_ASPECTS.has(key) && !aspects.includes(key)) {
        aspects.push(key);
      }
    }
  } else if (typeof aspectsRaw === "string" && aspectsRaw.trim()) {
    for (const part of aspectsRaw.split(/[,;|]+/)) {
      const key = part.trim().toLowerCase() as LlmFlightsAspect;
      if (FLIGHTS_ASPECTS.has(key) && !aspects.includes(key)) {
        aspects.push(key);
      }
    }
  }
  // Need at least one filter or board intent (aspects board/next/summary alone OK for hub board).
  if (!airline && !city && !flight && aspects.length === 0) {
    // Still allow empty board ask — model may set only airport/direction.
  }
  return {
    airport,
    direction,
    airline,
    city,
    flight,
    date,
    withinMinutes,
    aspects: aspects.length > 0 ? aspects : ["summary"],
  };
}

function parseInSeconds(value: Record<string, unknown>): number | null {
  const raw = value.in_seconds ?? value.inSeconds ?? value.in ?? value.delay;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const seconds = Number(raw.trim());
    return seconds > 0 ? seconds : null;
  }
  return null;
}

function parseClockField(time: string): string {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return "";
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return "";
  }
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function toMessageAction(value: unknown): LlmMessageAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const targets = parseTargets(record);
  const text = readText(record, ["text", "message", "body", "תוכן"]);
  // Allow targets + empty text so the engine can ask what to send instead of dropping the recipient.
  if (!text && targets.length === 0) {
    return null;
  }

  const rawExpectsReply = record.expects_reply ?? record.expectsReply;
  const expectsReply =
    rawExpectsReply === true ? true : rawExpectsReply === false ? false : undefined;
  const askSummary = readText(record, [
    "ask_summary",
    "askSummary",
    "question",
    "שאלה",
  ]);
  const book = toMessageBook(record.book);
  const urgency = parseJobUrgency(record.urgency);
  const inSeconds = parseInSeconds(record);
  const date = readText(record, ["date"]);
  const time = parseClockField(readText(record, ["time"]));
  const recurrence = clockRecurrence(record.recurrence);
  return {
    text,
    targets,
    ...(expectsReply !== undefined ? { expectsReply } : {}),
    ...(askSummary ? { askSummary } : {}),
    ...(urgency !== "normal" ? { urgency } : {}),
    ...(book ? { book } : {}),
    ...(inSeconds ? { inSeconds } : {}),
    ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}),
    ...(time ? { time } : {}),
    ...(recurrence ? { recurrence } : {}),
  };
}

/** Clocks fire at a point in time; an `end_time` on their rule is dropped. */
function clockRecurrence(value: unknown): Recurrence | null {
  const rule = parseRecurrence(value);
  if (!rule?.endTime) {
    return rule;
  }
  const { endTime: _dropped, ...rest } = rule;
  return rest;
}

function toMessageBook(value: unknown): LlmMessageBook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const date = readText(record, ["date"]);
  const time = parseClockField(readText(record, ["time"]));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) {
    return null;
  }
  const endTime = parseClockField(readText(record, ["end_time", "endTime"]));
  const window = record.window === true || record.window === "true";
  return {
    title: readText(record, ["title", "name"]),
    date,
    time,
    ...(endTime ? { endTime } : {}),
    ...(endTime && window ? { window: true } : {}),
  };
}

function parseJobActions(meta: Record<string, unknown>): LlmJobAction[] {
  if (!Array.isArray(meta.jobs)) {
    return [];
  }
  return meta.jobs.flatMap((entry) => {
    const action = toJobAction(entry);
    return action ? [action] : [];
  });
}

function toJobAction(value: unknown): LlmJobAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.action === "string" ? record.action.trim() : "";
  if (!JOB_ACTIONS.has(name as LlmJobActionName)) {
    return null;
  }
  const jobId = readText(record, ["job_id", "jobId", "id"]);
  const endTime = parseClockField(readText(record, ["end_time", "endTime"]));
  const urgency =
    record.urgency !== undefined && record.urgency !== null && record.urgency !== ""
      ? parseJobUrgency(record.urgency)
      : undefined;
  return {
    action: name as LlmJobActionName,
    jobId,
    answerText: readText(record, [
      "answer_text",
      "answerText",
      "answer",
      "text",
      "תשובה",
    ]),
    reportText: readText(record, ["report_text", "reportText", "report"]),
    time: parseClockField(readText(record, ["time", "at", "שעה"])),
    in: parseInSeconds(record),
    date: calendarDate(readText(record, ["date", "on", "תאריך"])),
    ...(endTime ? { endTime } : {}),
    ...(urgency && name === "escalate" ? { urgency } : {}),
  };
}

function calendarDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : "";
}

function toFilingAction(value: unknown): LlmFilingAction | null {
  if (!isActionRecord(value) || !FILING_ACTIONS.has(value.action as LlmFilingActionName)) {
    return null;
  }

  const filingId = readText(value, ["filing_id", "filingId", "id"]);
  const itemName = readText(value, ["item_name", "שם הפריט", "name"]);
  const action = value.action as LlmFilingActionName;
  if (action === "remove_filing" || action === "update_filing") {
    if (!filingId) {
      return null;
    }
  } else if (!itemName) {
    return null;
  }

  const unshareWith = readStringList(
    value.unshare_with ?? value.unshareWith,
  );
  return {
    action,
    itemName,
    itemInfo: readText(value, ["item_info", "מידע נוסף", "info"]),
    itemDescription: readText(value, [
      "item_description",
      "description",
      "תיאור",
      "תיאור הפריט",
    ]),
    targets: parseTargets(value),
    filingId,
    ...optionalIds("attachmentIds", value.attachment_ids ?? value.attachmentIds),
    ...optionalIds(
      "detachAttachmentIds",
      value.detach_attachment_ids ?? value.detachAttachmentIds,
    ),
    ...(unshareWith.length > 0 ? { unshareWith } : {}),
  };
}

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

/** True when a responses[] entry declares its own buttons or navigate_address. */
function entryDeclaresBubbleChrome(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return "buttons" in entry || "navigate_address" in entry;
}

function parseBubbleButtons(raw: unknown): LlmReplyButton[] {
  return toReplyButtons({ buttons: raw });
}

function parseBubbleNavigate(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const address = raw.trim().slice(0, NAVIGATE_ADDRESS_MAX).trim();
  return address || undefined;
}

/**
 * Unwrap one spoken entry: string, {text, buttons?, navigate_address?},
 * or stringified {"text":"..."}.
 */
function normalizeSpokenBubble(entry: unknown): LlmSpokenBubble | null {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }
    // Model sometimes embeds a stringified {"text":"..."} inside responses[].
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const nested = parseObject(trimmed);
      if (nested) {
        const fromNested = normalizeSpokenBubble(nested);
        if (fromNested) {
          return fromNested;
        }
      }
    }
    return { text: trimmed };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as {
      text?: unknown;
      buttons?: unknown;
      navigate_address?: unknown;
    };
    const text =
      typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      return null;
    }
    const bubble: LlmSpokenBubble = { text };
    if ("buttons" in record) {
      const buttons = parseBubbleButtons(record.buttons);
      if (buttons.length > 0) {
        bubble.buttons = buttons;
      }
    }
    if ("navigate_address" in record) {
      const address = parseBubbleNavigate(record.navigate_address);
      if (address) {
        bubble.navigateAddress = address;
      }
    }
    return bubble;
  }
  return null;
}

/** Unwrap one spoken entry to plain text (legacy helpers). */
function normalizeSpokenEntry(entry: unknown): string | null {
  return normalizeSpokenBubble(entry)?.text ?? null;
}

function looksLikeLlmReplyPayload(parsed: Record<string, unknown>): boolean {
  return (
    "responses" in parsed ||
    "response" in parsed ||
    "text" in parsed ||
    "metadata" in parsed ||
    "lists" in parsed
  );
}

/** Read spoken bubbles from a parsed reply record (preserves per-entry chrome). */
export function readSpokenBubbles(
  parsed: Record<string, unknown>,
): LlmSpokenBubble[] | null {
  if (Array.isArray(parsed.responses)) {
    const bubbles = parsed.responses
      .map(normalizeSpokenBubble)
      .filter((entry): entry is LlmSpokenBubble => Boolean(entry));
    return bubbles;
  }
  if (typeof parsed.response === "string") {
    const legacy = normalizeSpokenBubble(parsed.response);
    return legacy ? [legacy] : [];
  }
  if (
    parsed.response &&
    typeof parsed.response === "object" &&
    !Array.isArray(parsed.response)
  ) {
    const fromObject = normalizeSpokenBubble(parsed.response);
    return fromObject ? [fromObject] : [];
  }
  if (typeof parsed.text === "string") {
    const fromText = normalizeSpokenBubble(parsed.text);
    return fromText ? [fromText] : [];
  }
  return null;
}

export function readSpokenResponses(
  parsed: Record<string, unknown>,
): string[] | null {
  const bubbles = readSpokenBubbles(parsed);
  return bubbles ? bubbles.map((bubble) => bubble.text) : null;
}

export function joinSpokenResponses(responses: string[]): string {
  return responses.join("\n\n");
}

/** Serialize bubbles for JSON replies (objects when any entry has chrome). */
export function serializeSpokenBubbles(
  bubbles: LlmSpokenBubble[],
): Array<string | Record<string, unknown>> {
  const anyChrome = bubbles.some(
    (bubble) =>
      (bubble.buttons && bubble.buttons.length > 0) ||
      Boolean(bubble.navigateAddress),
  );
  if (!anyChrome) {
    return bubbles.map((bubble) => bubble.text);
  }
  return bubbles.map((bubble) => {
    const entry: Record<string, unknown> = { text: bubble.text };
    if (bubble.buttons && bubble.buttons.length > 0) {
      entry.buttons = bubble.buttons.map(({ label, command }) => ({
        label,
        command,
      }));
    } else {
      // Keep the key so re-parse stays in per-bubble mode (tips stay buttonless).
      entry.buttons = [];
    }
    if (bubble.navigateAddress) {
      entry.navigate_address = bubble.navigateAddress;
    }
    return entry;
  });
}

function flattenBubbleButtons(bubbles: LlmSpokenBubble[]): LlmReplyButton[] {
  const out: LlmReplyButton[] = [];
  const seen = new Set<string>();
  for (const bubble of bubbles) {
    for (const button of bubble.buttons ?? []) {
      if (seen.has(button.command)) {
        continue;
      }
      seen.add(button.command);
      out.push(button);
    }
  }
  return out;
}

function firstBubbleNavigate(bubbles: LlmSpokenBubble[]): string | undefined {
  for (const bubble of bubbles) {
    if (bubble.navigateAddress) {
      return bubble.navigateAddress;
    }
  }
  return undefined;
}

/**
 * Bind turn-level metadata.buttons / navigate_address onto bubbles when the
 * model used plain string responses (legacy). Object entries that already
 * declare chrome are left as-is; turn-level navigate fills the first empty slot.
 */
export function bindTurnChromeToBubbles(
  bubbles: LlmSpokenBubble[],
  options: {
    turnButtons: LlmReplyButton[];
    turnNavigate?: string;
    /** True when at least one raw responses entry declared buttons/navigate. */
    perBubbleChrome: boolean;
  },
): LlmSpokenBubble[] {
  let next = bubbles.map((bubble) => ({
    ...bubble,
    ...(bubble.buttons ? { buttons: [...bubble.buttons] } : {}),
  }));
  if (!options.perBubbleChrome && options.turnButtons.length > 0) {
    const distributed = distributeReplyButtons(next.length, options.turnButtons);
    next = next.map((bubble, index) => {
      const buttons = distributed[index] ?? [];
      if (buttons.length === 0) {
        const { buttons: _drop, ...rest } = bubble;
        return rest;
      }
      return { ...bubble, buttons };
    });
  }
  if (options.turnNavigate && !firstBubbleNavigate(next) && next.length > 0) {
    next = next.map((bubble, index) =>
      index === 0
        ? { ...bubble, navigateAddress: options.turnNavigate }
        : bubble,
    );
  }
  return next;
}

/**
 * After ensureSpeakerShowButtons: put show taps on the first bubble; keep each
 * bubble's non-show (choice) buttons where the model placed them.
 */
export function applyShowButtonsToBubbles(
  bubbles: LlmSpokenBubble[],
  speakerButtons: LlmReplyButton[],
): LlmSpokenBubble[] {
  if (bubbles.length === 0) {
    return [];
  }
  const show = speakerButtons.filter(isShowListReplyButton);
  return bubbles.map((bubble, index) => {
    const choices = (bubble.buttons ?? []).filter(
      (button) => !isShowListReplyButton(button),
    );
    const buttons =
      index === 0
        ? uniqueReplyButtons([...show, ...choices]).slice(0, REPLY_BUTTON_MAX)
        : choices.slice(0, REPLY_BUTTON_MAX);
    if (buttons.length === 0) {
      const { buttons: _drop, ...rest } = bubble;
      return rest;
    }
    return { ...bubble, buttons };
  });
}

function uniqueReplyButtons(buttons: LlmReplyButton[]): LlmReplyButton[] {
  const out: LlmReplyButton[] = [];
  const seen = new Set<string>();
  for (const button of buttons) {
    if (seen.has(button.command)) {
      continue;
    }
    seen.add(button.command);
    out.push(button);
  }
  return out;
}

/** Clear reply buttons from every bubble (bare show_dump). */
export function clearBubbleButtons(
  bubbles: LlmSpokenBubble[],
): LlmSpokenBubble[] {
  return bubbles.map((bubble) => {
    const { buttons: _drop, ...rest } = bubble;
    return rest;
  });
}

const LIST_BUCKET_ACTIONS = new Set(["add", "remove", "update"]);

/**
 * Shape drift: `lists` as `{ remove: [{ item_id }], add: [...] }` instead of
 * `[{ action: "remove", items: [...] }, …]`.
 */
export function normalizeListsField(lists: unknown): unknown[] | null {
  if (Array.isArray(lists)) {
    return lists;
  }
  if (!lists || typeof lists !== "object") {
    return null;
  }
  const record = lists as Record<string, unknown>;
  const out: unknown[] = [];
  for (const action of LIST_BUCKET_ACTIONS) {
    const entries = record[action];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        out.push({ ...(entry as Record<string, unknown>), action });
      } else if (typeof entry === "string" && entry.trim()) {
        out.push({ action, item_id: entry.trim() });
      }
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Shape drift: model sometimes puts `lists` on the payload root instead of
 * `metadata.lists`, or uses `{ remove: […] }` object buckets.
 * Prefer non-empty metadata.lists; else rescue top-level.
 */
export function coerceMetadataFromPayload(
  parsed: Record<string, unknown>,
): unknown {
  const base =
    parsed.metadata &&
    typeof parsed.metadata === "object" &&
    !Array.isArray(parsed.metadata)
      ? { ...(parsed.metadata as Record<string, unknown>) }
      : {};
  const fromMeta = normalizeListsField(base.lists);
  const fromTop = normalizeListsField(parsed.lists);
  if (fromMeta && fromMeta.length > 0) {
    base.lists = fromMeta;
  } else if (fromTop && fromTop.length > 0) {
    base.lists = fromTop;
  }
  if (Object.keys(base).length > 0) {
    return base;
  }
  return parsed.metadata;
}

function extractLlmPayload(text: string): {
  responses: string[];
  responseBubbles: LlmSpokenBubble[];
  perBubbleChrome: boolean;
  rawMetadata: unknown;
  metadata: LlmMetadata;
} | null {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return null;
  }

  const spokenBubbles = readSpokenBubbles(parsed);
  // Never leak raw JSON when we parsed an LLM-shaped payload but got no spoken text.
  const responseBubbles =
    spokenBubbles ??
    (looksLikeLlmReplyPayload(parsed) ? [] : text.trim() ? [{ text }] : []);
  const perBubbleChrome = Array.isArray(parsed.responses)
    ? parsed.responses.some(entryDeclaresBubbleChrome)
    : entryDeclaresBubbleChrome(parsed.response);

  const rawMetadata = coerceMetadataFromPayload(parsed);
  return {
    responses: responseBubbles.map((bubble) => bubble.text),
    responseBubbles,
    perBubbleChrome,
    rawMetadata,
    metadata: parseLlmMetadata(rawMetadata),
  };
}

const LIST_TYPE_LABELS: Record<string, string> = {
  shopping: "shopping list",
  contacts: "contacts list",
  tasks: "tasks list",
  custom: "custom list",
};

const ACTION_LABELS: Record<string, string> = {
  add: "Add to",
  remove: "Remove from",
  update: "Update",
  add_filing: "File",
  remove_filing: "Remove filing",
  update_filing: "Update filing",
};

export function parseLlmReply(text: string): ParsedLlmMessage {
  const payload = extractLlmPayload(text);
  if (!payload) {
    const bubbles = text.trim() ? [{ text }] : [];
    return {
      response: text,
      responses: text.trim() ? [text] : [],
      responseBubbles: bubbles,
      actions: [],
    };
  }

  const turnButtons = toReplyButtons(payload.rawMetadata);
  const turnNavigate = toNavigateAddress(payload.rawMetadata);
  const showIcon = toShowIcon(payload.rawMetadata);
  const responseBubbles = bindTurnChromeToBubbles(payload.responseBubbles, {
    turnButtons,
    ...(turnNavigate ? { turnNavigate } : {}),
    perBubbleChrome: payload.perBubbleChrome,
  });
  const buttons = flattenBubbleButtons(responseBubbles);
  const navigateAddress = firstBubbleNavigate(responseBubbles);
  return {
    response: joinSpokenResponses(responseBubbles.map((bubble) => bubble.text)),
    responses: responseBubbles.map((bubble) => bubble.text),
    responseBubbles,
    actions: collectActionDescriptions(payload.rawMetadata),
    ...(buttons.length > 0 ? { buttons } : {}),
    ...(navigateAddress ? { navigateAddress } : {}),
    ...(showIcon ? { showIcon } : {}),
  };
}

export function toNavigateAddress(rawMetadata: unknown): string | undefined {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    return undefined;
  }
  const raw = (rawMetadata as { navigate_address?: unknown }).navigate_address;
  if (typeof raw !== "string") {
    return undefined;
  }
  const address = raw.trim().slice(0, NAVIGATE_ADDRESS_MAX).trim();
  return address || undefined;
}

export function toShowIcon(rawMetadata: unknown): string | undefined {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    return undefined;
  }
  const raw = (rawMetadata as { show_icon?: unknown }).show_icon;
  if (typeof raw !== "string") {
    return undefined;
  }
  const icon = raw.trim().slice(0, SHOW_ICON_MAX).trim();
  return icon || undefined;
}

export function wazeNavigateUrl(address: string): string {
  return `https://waze.com/ul?q=${encodeURIComponent(address.trim())}&navigate=yes`;
}

export function toReplyButtons(rawMetadata: unknown): LlmReplyButton[] {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    return [];
  }
  const raw = (rawMetadata as { buttons?: unknown }).buttons;
  if (!Array.isArray(raw)) {
    return [];
  }
  const buttons: LlmReplyButton[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { label, command } = entry as { label?: unknown; command?: unknown };
    if (typeof label !== "string" || typeof command !== "string") {
      continue;
    }
    const cleanLabel = label.trim().slice(0, REPLY_BUTTON_LABEL_MAX);
    const cleanCommand = command.trim().slice(0, REPLY_BUTTON_COMMAND_MAX);
    if (!cleanLabel || !cleanCommand) {
      continue;
    }
    if (buttons.some((button) => button.command === cleanCommand)) {
      continue;
    }
    buttons.push({ label: cleanLabel, command: cleanCommand });
    if (buttons.length === REPLY_BUTTON_MAX) {
      break;
    }
  }
  return buttons;
}

/**
 * Closed-choice vocabulary (כן/לא, domain picks, …) — stays on the bubble
 * the model assigned. Also: short label≈command covers invented complex-event
 * axes (e.g. «איזה סרט»). Everything else can be confirm show chrome
 * (classic «הצג» or content-aware natural asks with a longer command).
 */
const CLOSED_CHOICE_REPLY_TOKENS = new Set(
  [
    "כן",
    "לא",
    "yes",
    "no",
    "ברכב",
    "תחב״צ",
    "תחב\"צ",
    "בתחבורה ציבורית",
    "המטלה",
    "רק תזכורות",
    "יעד",
    "קווים",
    "1",
    "2",
    "3",
    "קניות",
    "מטלות",
    "תיוק",
    "תזכורות",
    "כיבוד",
    "מי מגיע",
    "מה להביא",
  ].map((token) => token.toLowerCase()),
);

/** Max length for invented closed-choice axes (label≈command). */
const CLOSED_CHOICE_SHORT_MAX = 20;

/** Closed choice taps (כן/לא / domain / invented axis…) — not post-mutate show chrome. */
export function isClosedChoiceReplyButton(button: LlmReplyButton): boolean {
  const label = button.label.trim().toLowerCase();
  const command = button.command.trim().toLowerCase();
  if (
    CLOSED_CHOICE_REPLY_TOKENS.has(label) ||
    CLOSED_CHOICE_REPLY_TOKENS.has(command)
  ) {
    return true;
  }
  // Invented parallel choices (complex-event axes): short label equals command.
  return (
    label.length > 0 &&
    label === command &&
    label.length <= CLOSED_CHOICE_SHORT_MAX
  );
}

/**
 * Post-mutate show taps — sit on the first spoken bubble.
 * Classic «הצג» / «show …», or content-aware suggestions where the command
 * is a longer natural ask than the short label (POST-MUTATE SHOW shape).
 */
export function isShowListReplyButton(button: LlmReplyButton): boolean {
  const label = button.label.trim();
  const command = button.command.trim();
  if (label === "הצג" || label.toLowerCase() === "show") {
    return true;
  }
  if (
    command.startsWith("הצג") ||
    command.toLowerCase().startsWith("show ")
  ) {
    return true;
  }
  return !isClosedChoiceReplyButton(button);
}

/**
 * Legacy placement when the model used plain string `responses` + turn-level
 * `metadata.buttons`. Single entry → all buttons there. Multi: «הצג» on first,
 * choice (כן/לא/…) on last. Prefer per-bubble `responses[].buttons` instead.
 */
export function distributeReplyButtons(
  responseCount: number,
  buttons: LlmReplyButton[],
): LlmReplyButton[][] {
  const n = Math.max(0, Math.floor(responseCount));
  const out: LlmReplyButton[][] = Array.from({ length: n }, () => []);
  if (n === 0 || buttons.length === 0) {
    return out;
  }
  const capped = buttons.slice(0, REPLY_BUTTON_MAX * 2);
  if (n === 1) {
    out[0] = capped.slice(0, REPLY_BUTTON_MAX);
    return out;
  }
  const show = capped.filter(isShowListReplyButton).slice(0, REPLY_BUTTON_MAX);
  const choice = capped
    .filter((button) => !isShowListReplyButton(button))
    .slice(0, REPLY_BUTTON_MAX);
  out[0] = show;
  out[n - 1] = choice;
  return out;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const raw = parseObject(candidate);
  if (raw) {
    return raw;
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return parseObject(candidate.slice(start, end + 1));
  }

  return null;
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function collectActionDescriptions(metadata: unknown): string[] {
  if (metadata == null) {
    return [];
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }

  const meta = metadata as Record<string, unknown>;
  const descriptions: string[] = [];

  if (meta.action != null && meta.action !== "") {
    if (typeof meta.action === "string") {
      descriptions.push(describeStandaloneAction(meta.action, meta));
    } else if (typeof meta.action === "object" && !Array.isArray(meta.action)) {
      const actionRecord = meta.action as Record<string, unknown>;
      if (actionRecord.action != null) {
        descriptions.push(describeUnknownAction(actionRecord));
      }
    }
  }

  const unified = splitUnifiedListEntries(
    normalizeListsField(meta.lists) ?? [],
    [],
  );
  for (const list of unified.lists) {
    descriptions.push(
      describeListAction({
        action: list.action,
        list_type: list.listType,
        items: list.items,
        targets: list.targets,
      }),
    );
  }
  for (const op of [...unified.listOps, ...parseListOps(meta)]) {
    descriptions.push(describeListOp(op));
  }
  for (const filed of unified.filing) {
    descriptions.push(
      describeFilingAction({
        action: filed.action,
        item_name: filed.itemName,
        item_info: filed.itemInfo,
        item_description: filed.itemDescription,
      }),
    );
  }
  if (Array.isArray(meta.filing)) {
    for (const filing of meta.filing) {
      if (isActionRecord(filing)) {
        descriptions.push(describeFilingAction(filing));
      }
    }
  }
  for (const clock of unified.reminders) {
    const when = [clock.date, clock.time].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    );
    descriptions.push(
      `${clock.compose ? "Compose" : "Remind"} ${when.join(" ") || "later"}${clock.item ? `: ${clock.item}` : ""}`.trim(),
    );
  }

  if (Array.isArray(meta.messages)) {
    for (const item of meta.messages) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        descriptions.push(describeMessageAction(item as Record<string, unknown>));
      }
    }
  }

  if (Array.isArray(meta.directory)) {
    for (const item of meta.directory) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const name = readText(row, ["name", "שם"]);
      const action = String(row.action ?? "add").toLowerCase();
      descriptions.push(
        action === "remove"
          ? `Remove contact${name ? `: ${name}` : ""}`
          : `Save contact${name ? `: ${name}` : ""}`,
      );
    }
  }

  if (meta.handoff != null || meta.switch != null || meta.talk_to != null) {
    const handoff = parseHandoff(meta);
    if (handoff) {
      descriptions.push(`Handoff to ${handoff.worker}`);
    }
  }

  if (Array.isArray(meta.reminders)) {
    for (const item of meta.reminders) {
      if (isActionRecord(item)) {
        const name = readText(item, ["item", "item_name", "name"]);
        const when = [item.date, item.time, item.when].filter(
          (part): part is string => typeof part === "string" && part.trim().length > 0,
        );
        descriptions.push(
          `${item.compose === true ? "Compose" : "Remind"} ${when.join(" ") || "later"}${name ? `: ${name}` : ""}`.trim(),
        );
      }
    }
  }

  return descriptions;
}

function isActionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).action != null &&
      (value as Record<string, unknown>).action !== "",
  );
}

function describeStandaloneAction(
  action: string,
  meta: Record<string, unknown>,
): string {
  const details = [meta.description, meta.list_type, meta.item_name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  if (details.length > 0) {
    return `Action: ${action} — ${details.join(" · ")}`;
  }

  return `Action: ${action}`;
}

function describeUnknownAction(record: Record<string, unknown>): string {
  if (record.list_type != null || Array.isArray(record.items)) {
    return describeListAction(record);
  }

  if (record.item_name != null || record.item_info != null) {
    return describeFilingAction(record);
  }

  return describeStandaloneAction(String(record.action), record);
}

function describeListAction(list: Record<string, unknown>): string {
  const action = String(list.action);
  const verb = ACTION_LABELS[action] ?? `Action ${action} on`;
  const listName = LIST_TYPE_LABELS[String(list.list_type ?? "")] ?? "list";
  const names = Array.isArray(list.items)
    ? list.items.map(itemLabel).filter(Boolean).join(", ")
    : "";

  const targetSuffix = describeTargets(list);
  return names
    ? `${verb} ${listName}${targetSuffix}: ${names}`
    : `${verb} ${listName}${targetSuffix}`;
}

function describeListOp(op: LlmListOp): string {
  if (op.action === "delete_list") {
    return "Delete list";
  }
  const parts = [
    op.newName ? `rename to ${op.newName}` : "",
    op.addColumns.length > 0 ? `add columns ${op.addColumns.join(", ")}` : "",
    op.removeColumns.length > 0 ? `remove columns ${op.removeColumns.join(", ")}` : "",
    ...op.renameColumns.map((row) => `rename column ${row.from} → ${row.to}`),
    op.addParticipants.length > 0 ? `share with ${op.addParticipants.join(", ")}` : "",
    op.removeParticipants.length > 0
      ? `unshare ${op.removeParticipants.join(", ")}`
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? `Alter list: ${parts.join("; ")}` : "Alter list";
}

function describeTargets(record: Record<string, unknown>): string {
  const targets = parseTargets(record);
  if (targets.length === 0) {
    return "";
  }

  if (targets.some((target) => /^(all|everyone|\*|כולם|כל אחד|כל העובדים)$/i.test(target))) {
    return " for everyone";
  }

  return ` for ${targets.join(", ")}`;
}

function describeMessageAction(record: Record<string, unknown>): string {
  const text = readText(record, ["text", "message", "body", "תוכן"]);
  const targetSuffix = describeTargets(record);
  return text
    ? `Send message${targetSuffix}: ${text}`
    : `Send message${targetSuffix}`;
}

function describeFilingAction(filing: Record<string, unknown>): string {
  const action = String(filing.action);
  const verb = ACTION_LABELS[action] ?? `Action: ${action}`;
  const name =
    typeof filing.item_name === "string" && filing.item_name.trim()
      ? filing.item_name.trim()
      : "";
  const info =
    typeof filing.item_info === "string" && filing.item_info.trim()
      ? filing.item_info.trim()
      : "";
  const description =
    typeof filing.item_description === "string" && filing.item_description.trim()
      ? filing.item_description.trim()
      : typeof filing["תיאור"] === "string" &&
          String(filing["תיאור"]).trim()
        ? String(filing["תיאור"]).trim()
        : "";

  if (name && (info || description)) {
    const extras = [info, description].filter(Boolean).join(" / ");
    return `${verb}: ${name} — ${extras}`;
  }

  if (name) {
    return `${verb}: ${name}`;
  }

  return verb;
}

export function llmItemLabel(item: unknown): string {
  return itemLabel(item);
}

function itemLabel(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }

  const record = item as Record<string, unknown>;
  const keys = [
    "name",
    "item_name",
    "שם פריט",
    "שם מטלה",
    "שם פרטי",
    "task",
    "תיאור",
    "description",
  ];

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const metaKeys = new Set([
    "list_name",
    "listName",
    "רשימה",
    "list_type",
    "listType",
    "targets",
    "item_id",
    "itemId",
    "reminder_id",
    "filing_id",
    "contact_id",
  ]);
  const firstText = Object.entries(record).find(
    ([key, value]) =>
      !metaKeys.has(key) && typeof value === "string" && value.trim(),
  );

  return firstText && typeof firstText[1] === "string" ? firstText[1].trim() : "";
}
