# Wave 0 — Decision memo (cross-user communication)

**Status:** Decisions locked for final confirmation — **no implementation**  
**Updated:** 2026-11-17 (Prospect read-gate + CORE mediation principle)  
**Parent:** `lucy-cross-user-communication-audit.md`  
**Constraint:** Do not change code, schema, prompts, tests, or config in this step. Do not start Wave 1 implementation until this memo is finally approved.

---

## Architectural principle (D0 — Approved)

**Wave 1 is not a project to change or rebuild Lucy’s existing CORE.**

The goal is to add a **Cross-user Communication / Authorization mediation layer** that connects users, while **reusing** existing CORE mechanisms.

### CORE to preserve (reuse; do not fork or parallelize)

| CORE area | Keep using |
|-----------|------------|
| Conversation engine & chat management | Existing conversation / context paths |
| ACTION JSON, validation, apply pipeline | Existing `sendChatMessage` apply loop |
| Tasks, Lists, Filing, Reminders | Existing records / list-ops / reminder services |
| Jobs | Existing `jobs.service` / OPEN_JOBS |
| Existing permissions & outbound send | Existing share-assign / `visibleTo` / WhatsApp send / session window |

### What the mediation layer owns

- Identify **asker** and **recipient**  
- Manage **invitations** and **pending deliveries**  
- Check **eligibility, consent stage, and intent authorization**  
- **Route** work into the existing CORE executor that already performs it  

### What the mediation layer must not do

- Create **parallel** engines for Tasks, Lists, Filing, Reminders, Jobs, or conversation apply  
- Re-implement domain writes beside CORE apply paths  
- Expand into CORE refactors without explicit approval  

### If a CORE change appears necessary

Stop and present before any CORE edit:

1. The **exact** need  
2. Why it **cannot** be solved in the mediation layer  
3. **Scope** of the CORE change and **regression risk**  
4. An alternative that **keeps** CORE intact, if one exists  

**No CORE scope expansion without explicit approval.**  
This principle governs Wave 1.0 and later invite waves unless explicitly amended.

---

## Final decisions table

| ID | Topic | Status | Lock |
|----|-------|--------|------|
| **D0** | CORE vs mediation layer | **Approved** | Wave 1 = cross-user mediation on existing CORE; no CORE rebuild; no parallel domain engines; CORE changes only via explicit escalation |
| **D1** | Account / consent | **Approved** | **R1:** early `User` + `consentPending` until **explicit** join; not presented as registered member before consent |
| **D1b** | Exact Hebrew consent / button copy | **Open** | Needed before prompt/UI copy; giving a name or continuing the chat is **not** join consent |
| **D2** | Auto-apply by intent | **Approved** | Send + Share access auto when eligible; Assign requires explicit ack; Check-with + Coordinate interactive; **Share while Prospect = read-only scoped access** (see §1–2) |
| **D2b** | Decline / leave a Share after auto-apply | **Open** | Whether recipient can self-unshare / decline after access was granted |
| **D3** | Cold Check-with for independent recipient | **Deferred** | **Wave 1.1**, including cross-account jobs feasibility spike |
| **D3b** | Job topology J1 vs J2 | **Deferred** | Decided with Wave 1.1 spike |
| **D4** | First-session beats | **Approved** | Wave 1: context + original value + identity/consent only; soft try → **Wave 2** |
| **D4b / D8** | Invite TTL + expiry + asker cancel | **Approved** | TTL **14 days**; **lazy expiry**; **asker cancel of pending contextual invite in Wave 1** |
| **D5** | Contextual pending model | **Approved** | Evolve `WhatsAppInvite` with **payload v2**; no parallel contextual invite system |
| **D5b / D7** | Shell-list deferred invite | **Deferred** | **Wave 1.1** |
| **D6** | WhatsApp Templates | **Approved (out of invite track)** | Not invitations/acquisition; future infra for **existing** users only |
| **D9** | Share permission model (members) | **Approved** | **Co-mutate** remains the Share model after join; product-wide **view-only Share deferred**; Prospect temporary read-gate is **not** D9 view-only |
| **D11** | Brand in user-facing copy | **Approved** | **Lucy** in invite drafts / recipient copy |
| **D12** | Generic ReferralCampaign | **Deferred** | Separate from PendingDelivery; **Wave 2** (or 1.5 if later prioritized) |
| **D13** | Referral code shape | **Approved** (when D12 ships) | One durable code per user; named campaigns later optional |
| **D14** | Referrer blurb | **Approved** (when D12 ships) | Optional short personal sentence from inviter |
| **D15** | First Template use-cases | **Deferred** | Future Template workstream only |

**Open items — do not close by assumption:** **D1b**, **D2b**.

---

## Three product tracks (do not mix)

| Track | Meaning | Data | Current phase |
|-------|---------|------|---------------|
| **Contextual Invitation** | Invite from a specific act; may include **PendingDelivery** | Evolve `WhatsAppInvite` (+ payload v2) | Wave 1 |
| **Generic Referral** | Meet Lucy; **no** pending business action | **ReferralCampaign** (separate) | Wave 2 / 1.5 |
| **WhatsApp Templates** | Future Lucy → **existing** members around/after 24h window | Not invite tables | Future workstream |

Acquisition transport now: **user prepares and sends** drafts. Templates are not used for acquisition.

---

## 1. Account creation & consent (D1 — Approved R1)

### Today (verified)

1. Unknown WhatsApp number → `createIndependentWhatsAppAccount` (own `User` + Lucy) with **no** consent step.  
2. Same turn may auto-apply pending collab share/assign with full mutate semantics.  
3. Legacy guest→host promote is not the happy path for new phones.

### Lock

**R1:** Early `User` / employee for phone continuity, with **`consentPending`** until **explicit** join.

| Phase | Presentation | Allowed | Not allowed |
|-------|--------------|---------|-------------|
| **Prospect** (`consentPending`) | Not a registered Lucy member | Original invite **value** under boundaries below; collect preferred name + address gender; show terms; chat to open WhatsApp window | Full member framing; personal durable workspace as “your Lucy account”; **mutating** the sharer’s shared data |
| **Member** (explicit consent only) | Independent Lucy user | Full personal saves; normal Share **co-mutate** (D9); Assign ack flows; Wave 2 growth tips | — |

### Consent is explicit only (D1b remains Open for copy)

The following are **not** join consent:

- Providing or confirming a preferred **name**  
- Choosing address gender  
- Continuing the conversation / asking questions  
- Viewing the invited content  

Only an **explicit join / terms acceptance** action (wording = **D1b Open**) moves Prospect → Member.

### Prospect boundaries

**Do not** require registration merely to receive the original invite value.  
**Do not** expose unrelated private data or act on the invitee’s behalf from link-open alone.

Access requires **intent kind** + **verified inbound from the intended phone** (token + phone match). Link-open without send does not grant access.

| Intent | Prospect (before explicit join) | Member (after explicit join) |
|--------|----------------------------------|------------------------------|
| **Send / Forward** | Read/see transferred content in chat | May save into **their** personal workspace |
| **Share** | **Secure, scoped read-only** view of the specific shared item/list — **no edit/update/remove** of the sharer’s data | Normal Share **co-mutate** per existing CORE (D9) |
| **Assign** | See ask + context | Explicit accept/decline (D2), then responsibility on their book |
| **Check-with / Coordinate** | Wave 1.1 | Interactive participation |
| **Generic Referral** | Meet Lucy (Wave 2 track) | Full member workspace after consent |

**Private data rule:** Only the invitation’s scoped content — never the asker’s other private lists, unrelated filings, or owner-wide views.

**Prospect Share read-gate vs D9:** This is a **temporary mediation authorization** while `consentPending`. It does **not** introduce product-wide View-only Share and does **not** change the member Share model (still co-mutate). Prefer enforcing the gate in the **mediation layer** (block mutate while Prospect) rather than forking CORE Share — per D0. If CORE must change to enforce it, escalate under D0.

### Still open

- **D1b:** Exact Hebrew consent / button labels (not name collection).

---

## 2. Pending action & apply policy (D2 — Approved)

### Lock by intent

| Intent | When eligible | Recipient extra step? | Meaning |
|--------|---------------|------------------------|---------|
| **Send / Forward** | Auto show/deliver | No | One-way content transfer |
| **Share** | Auto grant **scoped access** when eligible | No hard “participate” gate | **Access**, not Assign / Collaborate consent |
| **Share + Prospect** | Access = **read-only** on that scoped content | Join still required for co-mutate | Temporary Prospect gate (§1) |
| **Share + Member** | Normal **co-mutate** via existing Share CORE | — | D9 |
| **Assign** | Present obligation | **Yes — accept / decline** | Responsibility |
| **Check-with** | Interactive (cold independent → Wave 1.1) | Answering is the act | Reply obligation |
| **Coordinate** | Interactive | Confirm / counter | Coordination |
| **Collaborate** | Distinct from Share | Not auto “you joined the process” | Keep separate |

### Share vs Collaborate vs Assign

| | Share | Collaborate | Assign |
|--|-------|-------------|--------|
| Primary effect | **Access** to invited content | Joint process participation | **Responsibility** |
| Prospect | Read-only scoped view | N/A as auto | See context only; ack when Member-eligible |
| Member | Co-mutate (D9) | Separate product semantics | Explicit ack |
| Asker UX | ממתין / גישה — not “אישר להשתתף” | Separate when productized | ממתין לאישור אחריות |

**Asker-facing rule:** Pending reads as **ממתין** until delivery/apply rules are met — never false completion.

### Still open

- **D2b:** After Share access is granted, may the recipient decline / self-remove access?

---

## 3. Check-with (D3 — Deferred to Wave 1.1)

Cold independent check-with is **not** in Wave 1.0.  
Wave 1.1: recipient Lucy continues the check; answer returns to asker; includes cross-account jobs spike (**D3b** deferred).  
Existing registered + open-session check-with remains as today.

---

## 4. Invitation experience (D4 — Approved)

Wave 1 recipient sequence:

1. Orient + original value (who / why / content; Share = read-only if Prospect).  
2. Identity fields as needed + **explicit** consent (D1 / D1b).  

Not in Wave 1: soft capability try-ons → **Wave 2**.

Asker draft: Lucy brand (D11), intent-specific CTA, pending until recipient writes / rules complete.

24h window: after inbound, useful conversation — not marketing drips; Templates irrelevant to acquisition (D6).

---

## 5. OutboundIntent / PendingDelivery (D5 — Approved)

- Contextual PendingDelivery = evolve **`WhatsAppInvite`** payload **v2**.  
- No parallel contextual invite system.  
- Generic Referral = separate entity when D12 ships.  
- Templates ≠ this acquisition model.  
- Apply via existing CORE executors only (D0).  
- Shell-list deferred invite → **Wave 1.1** (D7).

```text
payload?: {
  v: 2
  intentKind: "send" | "share" | "assign" | "check_with" | "coordinate"
  contentRef: { type, … }
  requireRecipientAck?: boolean  // assign
}
```

---

## 6. Generic invitations & Templates

### Tracks

Keep Contextual / Generic / Templates separate (table above).

### Generic (D12–D14)

| ID | Lock |
|----|------|
| D12 | ReferralCampaign ≠ PendingDelivery; **Wave 2** (or 1.5 if later prioritized) |
| D13 | One durable code per user; named campaigns later |
| D14 | Optional short referrer blurb |

User forwards group drafts; Lucy cannot post as the user into personal groups.

### Templates (D6)

Not part of invitations or acquisition. Future **existing-user** messaging only.

| Timing | Effect |
|--------|--------|
| Before window closes | May encourage a reply; **does not** extend/reset the window by itself |
| After window closed | Allowed template/service traffic if policy + consent; **user reply** opens a new window |

No Template system design/implementation in the invite track. Preserve session detection (`whatsapp-window.ts`) for a later channel router.

---

## TTL, expiry, cancel (D4b / D8 — Approved)

| Rule | Wave 1 |
|------|--------|
| TTL | **14 days** |
| Expiry | **Lazy** on read/accept/apply |
| Asker cancel pending contextual invite | **Yes** |
| Assign decline | Yes (D2) |
| Share decline-after-grant | **D2b Open** |

---

## Brand (D11 — Approved)

User-facing invite/recipient copy: **Lucy**.

---

## Share permission model (D9 — Approved) — no contradiction with Prospect

| Audience | Share behavior |
|----------|----------------|
| **Member** | Existing Share model = **co-mutate** (unchanged product Share) |
| **Prospect** | Temporary **read-only** scoped access to the invited content only — mediation gate, not a new Share product type |
| Product-wide **view-only Share** | **Deferred** (not Wave 1) |

D9 does **not** mean Prospects co-mutate. D9 means we are **not** building a general View-only Share feature for members in Wave 1.

---

## What approved Wave 0 allows Wave 1 to implement

*(Only after final confirmation of this memo.)*

1. Mediation layer for contextual invites / pending / eligibility (**D0** — route into CORE, do not rebuild CORE).  
2. Honest **ממתין** drafts, Lucy brand, user-forward compose.  
3. `consentPending` Prospect vs Member; **explicit** join only (D1); Prospect Share = **read-only** scoped value.  
4. `WhatsAppInvite` payload **v2** for send/share/assign.  
5. Member Share = existing co-mutate CORE; Assign = explicit ack; asker cancel + 14-day lazy expiry.  
6. Closed-session registered partner continuity without Templates.  

**Not Wave 1:** Check-with cold path (1.1), shell deferred invite (1.1), Generic ReferralCampaign (2), soft-try (2), Templates, product view-only Share, Household, unapproved CORE rewrites.

---

## Consistency checklist

| Topic | Rule in this memo |
|-------|-------------------|
| D0 CORE | Mediation on top of CORE; no parallel domain engines; escalate CORE edits |
| Templates vs invites | Separated; Templates do not acquire users |
| Template vs 24h window | Template send does **not** extend/reset window; user reply opens a new one |
| Prospect vs Member | Invite value without forced signup; no private leakage; no full personal workspace before **explicit** join |
| Name / chat ≠ consent | D1b Open; name or continued conversation is not join |
| Prospect Share vs D9 | Prospect = temporary read-only gate; Member Share = co-mutate; product view-only deferred |
| Share auto-apply | Access ≠ Assign / Collaborate consent |
| Generic vs Contextual | Separate entities and metrics |
| Check-with | Deferred 1.1 |
| Open decisions | **D1b**, **D2b** only |

---

## Remaining open / contradictions

**Open:** **D1b**, **D2b** only.

**Contradictions:** None intended after this pass. Prospect read-only Share is explicitly reconciled with D9 (member co-mutate unchanged; no product view-only Share in Wave 1).

**Note for Wave 1 planning (not a new decision):** Enforcing Prospect mutate-block should prefer the mediation layer (D0). If impossible without CORE changes, escalate per D0 — do not silently broaden CORE scope.

---

*End of Wave 0 lock memo. Awaiting final confirmation before any Wave 1 implementation.*
