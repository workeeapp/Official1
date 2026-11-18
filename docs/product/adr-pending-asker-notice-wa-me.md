# Architectural Decision: Dual-Purpose `Pending` + `AskerNotice` (`wa.me` Deep-Link)

**Status:** Accepted (product / channel architecture)  
**Date:** 2026-11-18  
**Scope:** WhatsApp outbound + PLG invite UX (Web UI and WhatsApp asker surfaces)  
**Related:** `lucy-wave1-plan-distilled.md` · `lucy-wave1-implementation-plan.md` §2.8 · `lucy-phase2-share-assign-invitation-design.md` §3.2  
**Code (today):** `WhatsAppInvite` `pending` + asker notice / compose URL (`createWhatsAppInvite`, cold partition, Web `whatsappComposeUrl`) — **1:1 cold / out-of-window path shipped**; group distribution is the same mechanism by design, not a separate product.

---

## Decision

Use one channel mechanism — **`Pending` delivery state + `AskerNotice` (forwardable draft + `wa.me` deep link with bound context)** — for two product jobs:

1. **Fallback** when Lucy cannot send 1:1 free-form WhatsApp outbound.  
2. **Primary distribution** for group-scoped actions, where the Cloud API cannot participate inside an existing WhatsApp group.

Do **not** invent a second invite system, a bot-in-group path, or a Marketing-template fan-out as the default for these cases.

---

## Context

### WhatsApp constraints we design around

| Constraint | Implication |
|------------|-------------|
| Meta **24h Customer Service Window** | Free-form business → user messages only while the window is open (user-initiated / service session). |
| **Templates** | Approved Marketing/Utility templates may reopen or message cold users, but are paid, rate-limited, skippable, and not always available. |
| **Cloud API bots cannot join existing WhatsApp groups** | Lucy cannot post into a user’s family/team group as a member. Group presence must be **human-forwarded**. |
| **User-Initiated sessions are $0 (relative to paid template outbound)** | The cheapest reliable reopen is: recipient (or group member) clicks / messages first via `wa.me`, opening a free 24h window with context already bound. |

### Product constraint we keep

Asker UX must stay honest: while delivery/apply is not complete, the asker sees **ממתין** / `Pending` — never a false «שלחתי / שיתפתי / הוטל» claim. The notice is user-visible on **both** WhatsApp and Web (chat bubble + optional share / `wa.me` action), not only an internal event.

---

## Dual purpose (normative)

### 1. Fallback — 1:1 outbound (`Cold Prospects` & out-of-window)

**When:** A Member triggers outbound message / share / task / assign toward a recipient whose WhatsApp 24h window is closed, **and** an approved template is unavailable, skipped, or rate-limited.

**Then:**

1. The outbound action (or invite) lands in **`Pending`** (evolve existing `WhatsAppInvite` / deferred collab path — no parallel store).  
2. The **sender** immediately receives an **`AskerNotice`**: short explanation that Lucy did not send from the business number + a **ready-to-forward** Lucy-branded draft + a **`wa.me` deep link** (compose URL / Web share action).  
3. The asker pastes or opens that link from their personal WhatsApp.  
4. When the recipient initiates (or continues) chat with Lucy, the invite/context binds, a **User-Initiated** 24h window opens, and normal present / join / ack flows continue.

**Economics:** Prefer zero-cost user-initiated reopen over paid template blast for cold 1:1 continuity.

**Asker-facing rule:** Surfacing the notice (draft + link) on the sender’s response is **required** whenever this fallback fires — WhatsApp and Web UI alike.

### 2. Primary — group actions (Cloud API group workaround)

**When:** Group tasks, shared lists, group polls / collections, or any action whose natural home is an existing WhatsApp **group** (not a 1:1 Lucy thread).

**Then:** The **same** `Pending` + `AskerNotice` (`wa.me` deep link **with group-action context payload**) is the **primary** distribution mechanism — not a secondary fallback.

| Anti-pattern (reject as default) | Chosen pattern |
|----------------------------------|----------------|
| Bot joins / posts inside the WhatsApp group | Impossible on Cloud API for arbitrary user groups |
| Fan-out paid **Marketing** templates to each member | Expensive; weak context; not viral |
| Creator pastes **one** `wa.me` invitation into the group | One forward; each clicker enters Lucy with **that group action already bound** and opens a free User-Initiated window |

**PLG loop:** Group paste → member click → contextual Lucy session → free 24h window → optional Explicit Join / accept — a zero-cost viral acquisition path, reusing the cold-invite binder rather than a new campaign product.

---

## What stays the same

- One CORE; one `WhatsAppInvite` (or evolved PendingDelivery) spine — D0 / Wave 1 lock.  
- Intent policy (Send / Share / Assign) and Prospect vs Member authorization unchanged.  
- Honest **ממתין** asker copy; Pending ≠ done.  
- Templates remain optional / later (Wave docs already defer D6 Templates); they are **not** required for this mechanism to work.

## What this decision does *not* claim (yet)

- Exact group payload schema, poll/collection UX, or Web “create group action” UI — product follow-ons; mechanism is locked first.  
- That every closed-window partner always gets a draft (registered partners with closed windows may still follow existing continuity rules — see Phase 2 design).  
- Billing / Meta pricing as an in-app Quota product (U1); this ADR only chooses the **channel pattern** that prefers User-Initiated sessions.

---

## Implementation notes (non-binding pointers)

| Concern | Direction |
|---------|-----------|
| Create / defer | Existing cold partition + `createWhatsAppInvite` / deferred collab |
| Asker text | `AskerNotice` / cold invite notice + Lucy-branded draft |
| Link | `wa.me` compose URL (`whatsappComposeUrl` on Web bubbles; WA-forwardable body) |
| Bind | Inbound resolve + invite token / context payload (1:1 today; group action context when that feature lands) |
| Tests | Cold Prospect E2E must assert the **Member-visible** reply contains the forwardable draft and `wa.me` / compose URL — not only DB pending |

---

## Consequences

| Positive | Trade-off |
|----------|-----------|
| One mechanism for cold 1:1 and future group distribute | Asker must forward once (human-in-the-loop) |
| Avoids paid template fan-out as the default | Depends on asker / group creator cooperation |
| Opens free User-Initiated windows + PLG viral loop | Deep-link context must stay trustworthy (token / payload bind) |
| Fits Cloud API “no bot in user groups” reality | Group Lucy UX is 1:1 after click, not in-group bot chat |

---

*Accepted architectural & product decision. Group-action product build may follow; 1:1 cold AskerNotice path is the living proof of the mechanism.*
