# Lucy — Security Closure Audit (pre-pilot)

**Date:** 2026-11-23
**Mode:** Read-only code audit — **no fixes in this step**
**Locks preserved:** P2a EIS; clarifyBind off without `trusted_control`; Class V unchanged; no O2/ACP; P0 baseline mismatch = **PI-2** only; FP-2/FP-3 = documented UX limits

**Pointers:** Gate `high-risk-action-gate.ts` · EIS `high-risk-instruction-channel.ts` · Bind `clarify-bind.service.ts` · Turn `chat.service.ts` · WA `whatsapp.service.ts` · V `pending-high-risk-confirm.service.ts` · Fire `reminder-fire.ts` + `reminder-high-risk-auth.ts` · Status `lucy-high-risk-gate-p0-p1-status.md` · Spec `lucy-prompt-injection-m1m3-closure.md`

---

## 1. Enforcement architecture (as implemented)

```text
Inbound (WA webhook | Web POST /api/chat | consult nested turn)
  → identity / session / phone bind
  → [WA] extractInboundTexts + batch; buildWhatsAppSendChatFields
        message = full spoken (forwards/cards/captions/transcripts)
        gateInstructionText = channel-cleaned EIS (P2a)
  → sendChatMessage
        Class V ingest (opaque button → immutable snapshot replace metadata)
        OR LLM → parse metadata ACTION
        dump / intent / show-turn guards
        ★ HighRiskActionGate (signal EIS + known targets)  ★  [skipped: guest/prospect paths as coded]
        ProspectWriteGate (prospects)
        CORE apply (lists / filing / reminders / directory / jobs …) + ACL
        secondary: relays, phones, notices, job reports, shared-item notifies
        [WA] deliver after reply
  → later: reminder-fire (suppress foreign clock without highRiskAuthorizedAt)
```

### 1.1 What the Gate actually enforces

| Policy | Covers | Allow mode (default `signal`) |
|--------|--------|-------------------------------|
| **P-Out** | `messages` to others; foreign reminder ping; some job outbound | Known target **and** outbound/remind verb in **EIS** (not name-only — PI-8 closed) |
| **P-Share** | list/filing/directory share/assign; `share_book` / unshare | Known target **and** share/unshare verb in EIS |
| **P-Mass** | multi-id remove / multi remove-actions / `delete_list` | Mass-delete verb in EIS |

**Not provenance:** EIS = channel-cleaned text (Forward/cards stripped). Paste without Forward metadata remains in EIS.
**Not Gate-authorized by:** model `awaiting`, clarifyBind (production `none`), prompt promises.
**Class V:** server-staged immutable snapshot + opaque commands; execute replaces turn metadata; `allowAuthorizedSnapshot` bypasses re-strip; reminder create can stamp `highRiskAuthorizedAt`.

### 1.2 ACTION path map (sensitive classes)

| Action class | Input | ACTION source | Gate | ACL / auth at apply | Side effect | Ungated path? |
|--------------|-------|---------------|------|---------------------|-------------|---------------|
| Personal list/task/filing add/update | WA/Web utterance (+ ESD) | Model metadata | Not P-* (passes) | Ownership / visibility at apply | DB rows | Expected — low blast if PI only mutates own book |
| Reminder self | Same | Model | Allow (self) | Actor clocks | DB + fire to self | OK |
| Reminder foreign / messages to other | Same | Model | P-Out signal or Class V | Resolve targets; fire needs `highRiskAuthorizedAt` for human→human | DB; WA at fire/relay | **Create may allow under PI-2-like EIS; fire fail-closed if unstamped (Gap A)** |
| Share / assign | Same | Model | P-Share or V | Collab / invite flows | DB + invites + WA | Gated |
| Multi remove / delete list | Same | Model | P-Mass or V | Dump/id + ACL | Soft-delete | Gated; FP-3 UX → V |
| Directory add/update/remove (personal) | Same | Model | **Fall-through** (non-collab directory rows kept) | Speaker phone-book rules | Contacts DB | **PI-7: phone update not P-*** |
| Directory share_book / targets collab | Same | Model | P-Share | Same | Share | Gated |
| Jobs answer / progress | Same + OPEN_JOBS | Model | answer mostly pass; outbound jobs gated | Job ownership | Reports / close | Mostly OK; reports post-Gate |
| Consult digital worker | Nested `sendChatMessage` | Second model | **Gate runs again** on consult turn | Speaker remains human for permissions | Reply text into parent | Nested Gate — see finding on consult text as EIS |
| Handoff | Model handoff | Conversation switch only | N/A | — | Sticky partner | Not a mutate engine |
| Reminder fire (scheduler) | Clock row | No new ACTION | No chat Gate; **fire suppress** legacy foreign sans stamp | Marker check | WA ping | Fail-closed for unstamped foreign |
| Site UI `notifySharedItemEvents` | Employee API session | No chat ACTION | **Outside chat Gate** | Session user ACL | WA notice | Documented out-of-chat; not PI from model |
| Register → `continueInviteAfterRegister` | Register success | Lifecycle | Constrained O11 (not free P-Out) | Invite consume-once | Asker/guest notices | Spec’d exception |

### 1.3 clarifyBind (P1) — production posture

Infrastructure + Gate allow hooks exist; **`bindAuthority: "none"` on all user paths** → no bind created. Not a live bypass and not a live UX fix for FP-2/FP-3.

---

## 2. Findings table

| ID | Severity | Title | Evidence | Type | Impact | Mitigations already present | Minimal fix | Cost |
|----|----------|-------|----------|------|--------|----------------------------|-------------|------|
| **F0** | **Critical** | **WhatsApp webhook POST unauthenticated** | ~~open~~ **Fixed 2026-11-23:** `X-Hub-Signature-256` HMAC over raw body + `WHATSAPP_APP_SECRET`; production startup fail-closed when WA token set without secret | Was proven; now gated | — | — | Done | — |
| **F1** | **High** | **PI-2: unmarked paste/summary in EIS allows P-Out** | Corpus PI-2 desired strip, locked mismatch; `signalAllowsOutbound` uses EIS verbs+known names; paste without Forward stays in EIS | **Proven** (Gate unit) | Unsolicited WA message / outbound if model emits matching ACTION | Model must still emit ACTION; known-target only; Class C name-only closed (PI-8); Forward stripped | Prefer: treat summary-envelope / mixed instruction as empty or non-allowing for P-Out (narrow heuristic) **or** require Class V for outbound when EIS looks like envelope+payload — without O2 | M |
| **F2** | **High** | **PI-7: directory phone ungated (+ redirect/plant)** | Gate fall-through; `applyDirectoryActions` writes phone; phones feed `collectKnownTargetNames` | **Proven** (code) | Hijack “אמא”/plant contact → later “תגידי ל…” to attacker (employees resolve first) | Model ACTION; owner/`visibleTo` | Gate/V phone field changes | M |
| **F3** | **Medium** | **Gap A: signal-allowed foreign remind creates clock without `highRiskAuthorizedAt` → fire suppress** | Stamp only when `highRiskAuthorized`; `shouldSuppressLegacyForeignClock` | **Proven** | UX: user thinks remind scheduled; ping never sends. Security: **fail-closed** (no unauthorized ping) | Fire suppress | Stamp on signal allow **or** don’t persist foreign clock unless V; product choice | M |
| **F4** | **Medium** | **EIS ≠ authorship; paste ≡ typed for Gate** | P2a docs + audit; no paste metadata from Meta | **Proven** (architecture) | Same as F1 class of attacks | Forward/cards stripped; clarifyBind disabled so no bind from paste | Accept residual **or** future `trusted_control` for high-risk completions only | — |
| **F5** | **Medium** | **FP-2 / FP-3 UX friction** | Status doc; no production bind | **Proven** UX limit | Extra Class V confirms on legitimate follow-ups | Class V works | Deferred: interactive `trusted_control` (not now) | H if built |
| **F6** | **Medium** | **Captions / transcripts / full WA message reach model; only EIS cleaned** | `buildWhatsAppSendChatFields`: message=full, gateInstructionText=EIS | **Proven** | Model may invent high-risk ACTION from caption/forward body; Gate checks EIS not model prose | Gate strips if EIS lacks verb/known pattern; V for strip path | Keep; optionally empty EIS when message is media-only with caption-as-data (product) | L–M |
| **F7** | **High** | **Consult nested turn: EIS = first-model relay text** | Nested `sendChatMessage` without human `gateInstructionText`; Gate re-runs on model-authored consult text; `consultFrom` blocks re-consult/handoff only — ordinary delivery still possible | **Proven** (call chain) | Asking worker can author verbs+known names → consulted worker may allow P-Out/P-Share under signal | Speaker ACL; no second consult; digital-target quirks | Strict/empty EIS on consult turns; or force V for nested high-risk | M |
| **F8** | **Low** | **Site UI notifies outside chat Gate** | `employee.controller` → `notifySharedItemEvents` | **Documented** | Not model-PI; session auth | Session + employee ACL | Keep classified; no chat Gate required | — |
| **F9** | **Low** | **In-process outbound memory / at-least-once fire** | M1–M3 closure notes | **Documented** residual | Duplicate WA on crash | DeliveryAttempt on confirm paths (partial) | Outbox later if pilot needs stronger exactly-once | H |
| **F10** | **Low** | **Indirect PI via ESD titles** | Prompt UNTRUSTED + Gate on ACTION; no engine “do what title says” | **Suspicion** mitigated | Model might emit high-risk from poisoned shared title | Gate+ACL; many PI corpus cases strip | Maintain prompt+Gate; add eval if pilot shares heavily | L |
| **F11** | **Info** | **Class V snapshot not expandable by model on Accept** | Ingest replaces metadata with stored snapshot; hash | **Proven good** | — | Opaque commands | Keep | — |
| **F12** | **Info** | **clarifyBind cannot activate from model/EIS** | `bindAuthority` none; resolve rejects forge | **Proven good** | — | — | Keep | — |
| **F13** | **Critical** | **`isButtonCommand` true on opaque *prefix* even when ingest fails** | `isButtonCommand: isOpaqueConfirmCommand(utterance)` independent of successful V ingest; `hasOutboundIntentSignal` / share / mass short-circuit to true | **Proven** (code) | Any same-turn model high-risk ACTION to **known** targets can pass signal Gate without EIS verbs if speaker text starts with `hrc:ok:` / `hrc:no:` (forged, expired, or phoneless) | Ingest still required for snapshot execute; known-target still required | Set `isButtonCommand` only after successful pending ingest (or never use prefix alone for intent) | L |
| **F14** | **High** | **Site record mutate lacks item ACL** | `updateOwnedListItem` / delete update by `employeeId`+`itemId` without `humanItemAccessAllowed`; controller only checks account membership via `getEmployeeForUser` | **Proven** (code) | Same-account non-owner (or wrong actor) can mutate another human’s personal rows via REST + trigger WA notifies | Session auth; must know item id; multi-human household | Call same ACL as chat apply before mutate | L–M |
| **F15** | **High** | **Class V / fire: labels re-resolved; auth marker not re-bound to phone** | Snapshot hash-protects JSON; execute + `fireDueReminders` resolve names/phones live; updates can keep old `highRiskAuthorizedAt` | **Proven** (architecture) | After Accept/stage, rename/repoint contact or mutate clock row → different recipient still “authorized” | TTL; hash; household trust | Freeze employeeId/phone (and ping dests) at stage/stamp time; clear stamp on dest change | M |
| **F16** | **Medium** | **Nested `items[].remind` not inspected by Gate top-level reminders loop** | Gate walks `metadata.reminders`; nested remind applied in list package / txn | **Proven** | Foreign nested clock can persist (joins/visibility) without stamp; WA fire still suppress for unstamped human→human | Fire suppress (Gap A family) | Gate or apply: treat nested remind like top-level P-Out / stamp rules | M |
| **F17** | **Medium** | **Partner notification fanout not re-authorized as P-Out** | Post-apply `notifySharedItemEvents` / list-op relays derived from mutate | **Proven** | Watchers get WA on rename/update/remove without separate outbound Gate | Originating mutate was Gate/ACL’d | Accept as secondary notice **or** cap/consent for notify | L |
| **F18** | **Medium** | **DeliveryAttempt ledger throw → direct WA fallback** | Reminder / O11 paths catch ledger errors and send anyway | **Proven** (code paths) | Lose durable dedupe → duplicate sends under failure | Ledger success path OK | Fail closed on ledger error for pilot-critical sends | L |
| **F19** | **Medium** | **`removeVisibleCustomItems` equates visibility with delete authority** | Recovery fallback soft-deletes any visible shared custom item | **Proven** | Co-viewer can delete shared custom content without owner check | Only after chat Gate/H path | Require owner/account-owner (or explicit share-mutate) | L |
| **F20** | **Medium** | **Tips `POST /api/tips/:id/send` → preview phone** | Session owns tip → `sendTipForUser` to configured preview number; no Gate | **Proven** | Authenticated user can push arbitrary tip text to global preview phone | Preview-only env; not household P-Out | Disable in prod / admin-only / remove arbitrary body | L |
| **F21** | **High** | **Engine NL shortcuts ignore EIS/Forward** | `parseBlockSenderFreeText` (whole-line block); `messageLooksLikeAskerInviteCancel` on raw `input.message` (incl. quote/forward body) | **Proven** | Paste/forward “תחסמי את אמא” / “תבטל את ההזמנה…” can block sender or cancel invite without model/Gate | Block is single-line anchored; cancel needs both cancel+invite lexemes | Run only on trusted spoken/EIS; never on forward/quote; confirm for cancel | L |
| **F22** | **High** | **Gate intent regexes are loose substrings** | `hasShareIntentSignal` ORs `/שתפ|קצ/`; `OUTBOUND_INTENT_RE` bare `שלח` / English `ask\b`; `MASS_INTENT_RE` bare `תמחק` | **Proven** (literals) | Widens PI-2 / share / mass allow on innocent paste (“קצת”, “שלחתי”, “task”) | Known-target still required; Class V on strip path | Tighten Hebrew with safer boundaries; drop bare `קצ`; fix `ask\b` | L |
| **F23** | **Medium** | **`jobs.answer` always allowed (no EIS)** | Gate pushes `answer` unconditionally; asker report delivered; DOC claims Gate/V for some reports | **Proven** + **doc gap** | Poisoned OPEN_JOBS ask / “answer” content can WA the asker | Open job must exist; product “check-with” | Bound answer to job + EIS or strip `reportText` without signal | M |
| **F24** | **Medium** | **Relay text stored as assistant turns in recipient model history** | `pushRelayMessage` → `appendAssistantMessage(relay.text)` | **Proven** channel | Cross-user words look like Lucy’s prior turn; soft PI on later mutates | High-risk still needs Gate verbs for P-*; single-id/directory residual | Mark relays as untrusted data / user-role; never assistant | M |
| **F25** | **Low–Med** | **Web has no Forward flag; voice transcripts not in EIS** | Web omits `gateInstructionText` → full utterance EIS; voice-only → empty EIS → Class V | **Proven** | Web paste always instruction; voice high-risk always V (safe, friction) | P2a WA Forward OK | Document; optional web paste policy later | — |
| **F26** | **High** | **Gate fuzzy “self/Lucy” vs exact delivery resolvers** | `isSpeakerName` / Lucy-internal use substring (≥2); `matchEmployee` / ping resolve exact | **Proven** (code; construction) | Target `טלי` treated as speaker `טל` → P-Out skipped → relay to טלי; `לוסי כהן` as Lucy-internal then assign to human | Tests cover exact names only | Gate must use same exact identity as resolvers (or resolve-to-id before Gate) | M |
| **F27** | **High** | **Reminder update with empty ping treated as self; stamp kept** | `isSelfReminderAction` true when ping/targets empty; update keeps existing dest + `highRiskAuthorizedAt` | **Proven** | Rewrite text/compose/attachments on Class-V-approved foreign clock without new Gate/V | Fire still goes to prior dest | Gate on effective ping set; clear stamp on content/compose/attachment change | M |
| **F28** | **High** | **Prospects skip HighRisk Gate; ProspectWriteGate omits `messages`** | `!recipientIsProspect` skips Gate; `prospectMetadataHasDurableWrites` has no messages | **Proven** | Prospect model can WA arbitrary phones/contacts with no P-Out | Join/durable writes still blocked | Run Gate for Prospects **or** block `messages` in ProspectWriteGate | L–M |
| **F29** | **Medium** | **Class V user summary truncated / incomplete** | Summary ≤6 lines; message bodies ≤120 chars; omits compose/attachments | **Proven** | User Approves ops/compose not shown in summary | Full snapshot hashed | Non-truncating / “+N more”; include compose fields | L |
| **F30** | **Medium** | **Prospect Explicit Join replay applies staged snapshot without Gate** | `replayProspectPendingWrites` after one Join accept | **Proven** | Bulk lists/share/directory from staged pending; foreign remind still fire-suppressed | One consent tap; jobs/missions dropped | Re-Gate or narrow staged kinds; freeze targets | M |

*Also confirmed: `awaiting` cannot mint bind; collab V / `delete_list` gated; handoff re-Gates same utterance; W1 UNTRUSTED banners not in `src`.*

---

## 3. Problematic / noteworthy execution paths

### 3.0 Critical — unauthenticated WhatsApp webhook (F0)

```text
POST /api/whatsapp/webhook (no signature)
  → extractInboundTexts(req.body)  // attacker-controlled from + text
  → handleInboundWhatsAppTexts → full sendChatMessage as that phone
```

GET verify-token only. No `X-Hub-Signature-256` in repo.

### 3.1 Proven concern — PI-2 style allow

```text
User pastes / “תסכמי:” + “תשלחי לעמית …” (no Forward flag)
  → EIS retains send verb + name
  → Model emits messages[{targets:עמית,…}]
  → signalAllowsOutbound → ALLOW
  → relay WA
```

**Bypass of intent?** Not of ACL (speaker may message Amit). Bypass of **“untrusted paste ≠ instruction”** bar. **Proven** in P0 corpus.

### 3.2 Proven ungated field — directory phone

```text
Mundane ask + model directory.update{phone}
  → Gate keeps row (no collab targets)
  → applyDirectoryActions writes phone
```

### 3.3 Fail-closed delivery — Gap A

```text
EIS “תזכירי למאיה…” → Gate allow foreign remind (signal)
  → clock persisted WITHOUT highRiskAuthorizedAt
  → fire → shouldSuppressLegacyForeignClock → no ping
```

Security OK (no send); product broken for frictionless foreign remind.

### 3.4 Not a Gate bypass — Class V execute

Opaque Accept → snapshot only → CORE. Model cannot widen snapshot.

### 3.5 Not a chat PI path — employee UI notify

Authenticated site mutation notices; out of HighRiskActionGate by design.

### 3.6 Critical — opaque prefix without successful V ingest

```text
Speaker text starts with hrc:ok:… (forged / expired / no phone → ingest null)
  → isButtonCommand = true
  → Gate signal intent short-circuit (outbound/share/mass)
  → If model also emits high-risk ACTION to known targets → ALLOW without EIS verbs
```

Does **not** by itself restore a snapshot; it weakens intent gating for the LLM turn.

### 3.7 Site REST item mutate (F14)

```text
PATCH employee/:id/records/:itemId
  → getEmployeeForUser(account, :id) only
  → updateOwnedListItem without humanItemAccessAllowed
```

### 3.8 Consult authorizes from model relay (F7)

```text
Human turn → model messages digital worker
  → nested sendChatMessage(consult text)
  → Gate EIS = consult text (not human utterance)
  → consulted worker may P-Out / mutate under signal
```

### 3.9 Nested remind bypasses top-level reminder Gate loop (F16)

```text
lists.add/update items[].remind (foreign ping)
  → not in metadata.reminders Gate loop
  → persist clock (± joins); fire suppress if unstamped
```

---

## 4. Proven vs hypothesis vs doc

| Bucket | Items |
|--------|--------|
| **Proven weakness / gap** | **F0** webhook; **F13**; **F26** fuzzy identity; **F28** prospect messages; **F27** remind update; **F21**; **F22**; **F1** PI-2; **F2** PI-7; **F14**; **F7**; **F15**; **F3**/F16; **F23–F25**; **F29–F30**; F4–F6; F17–F20 |
| **Suspicion** | F10 ESD indirect PI |
| **Documented residual / OK** | F8 UI notify; F9/F18 delivery (partial); F11–F12 bind/V good parts; collab V / delete_list gated |
| **Doc gaps** | UNTRUSTED banners; jobs.answer vs O5; voice/web EIS |
| **Not claimed closed** | FP-2/FP-3 UX; O2/ACP; trusted_control |

---

## 5. Closure plan (minimal)

### A — Required before pilot (security)

0. **F0 — WhatsApp webhook signature verification (Critical)**
   - Verify `X-Hub-Signature-256` with app secret over **raw** body before `handleInboundWhatsAppTexts`.

1. **F13 — Fix `isButtonCommand` binding**
   - True only after successful pending ingest — never prefix alone.

2. **F26 — Align Gate identity with exact resolvers**
   - No substring self/Lucy-internal that delivery does not use; add `טל`/`טלי` regressions.

3. **F28 — Prospects: Gate messages or include `messages` in ProspectWriteGate**
   - Close P-Out hole for WA-only prospects.

4. **F27 — Reminder update: effective ping + clear auth stamp on sensitive field change**

5. **F21 — Engine NL shortcuts only on trusted spoken/EIS** (not Forward/quote).

6. **F22 + F1 — Tighten Gate lexicons + PI-2 envelope reject for P-Out**

7. **F2 — Gate directory phone (PI-7 redirect/plant)**

8. **F14 — Site record item ACL**

9. **F3 / F16 — Gap A + nested remind consistency**

10. **F7 — Consult EIS policy** (not first-model relay as human EIS)

### B — Recommended after pilot start

- **F15** / **F29** freeze Class V targets + complete non-truncating summaries (compose fields).
- **F30** narrow/re-Gate Explicit Join replay.
- **F23** bound `jobs.answer` / reportText; **F24** relay ≠ assistant history.
- **F17–F20**, **F25**; W1 untrusted banners; optional `trusted_control`.

### C — Accepted residual (document for pilot)

- Paste without Forward metadata ≡ typed for EIS (**F4**).
- FP-2/FP-3 Class V friction (**F5**).
- clarifyBind off until trusted_control.
- Site UI notifies outside chat Gate (**F8**) — distinct from **F14** ACL hole.
- At-least-once fire (**F9**); strengthen via F18 if needed.
- Model can still *propose* bad ACTION; Gate+ACL+V enforce — residual on personal low-risk mutates.

**Do not** add blanket confirms, second Gate engines, or O2/ACP for pilot closure.

---

## 6. Pilot readiness verdict

### **Not ready for pilot from a security-closure standpoint until group A is done.**

**What blocks a clean yes:**

| Blocker | Why |
|---------|-----|
| **F0 (Critical)** | Unauthenticated WA webhook → full impersonation / forged EIS |
| **F13 (Critical)** | Opaque prefix alone disables intent checks |
| **F26** | Fuzzy Gate self/Lucy ≠ exact delivery → wrong recipient allow |
| **F28** | Prospects skip Gate; messages not in ProspectWriteGate |
| **F27** | Foreign clock content rewrite without re-Gate / stamp clear |
| **F21 / F22 / F1** | NL shortcuts + loose lexicons + PI-2 |
| **F2 / F14 / F7 / F3–F16** | As before |

**What does *not* block** (after A):

- P2a Forward/card stripping; clarifyBind off; Class V hash/CAS/TTL; PI-8; FP-2/FP-3 UX limits

### Unambiguous recommendation

- **Not security-ready for pilot until A0–A10 are fixed** (especially **F0 webhook** and **F13**).
- Prefer **narrow enforcement fixes** — not O2/ACP/clarifyBind/global confirms.
- **F15, F23, F24, F29, F30, F17–F20, F25** → B unless profile pulls them forward.

---

## 7. Locks (unchanged by this audit)

- No code changes in this step.
- No commit / push / deploy.
- P0 baseline remains PI-2 mismatch until a deliberate baseline update after a real PI-2 fix.
- FP-2/FP-3 remain documented UX limits.

---

*End of audit. Awaiting product/security decision on group A before implementation.*
