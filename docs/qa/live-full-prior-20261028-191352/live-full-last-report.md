# LIVE eval report — live-full-corpus

- **Track:** LIVE_FULL
- **Generated:** 2026-10-28T16:15:50.576Z
- **Prompt:** config:LLM.config.json+buildLucyModelEvalInstructions
- **Instructions SHA-256:** 9d94bafe28465900bfc01da625067967c6f7989222301d1dc7be0cc4e341c76b
- **Envelope:** lucy_eval (attachLucyRuntimeEngine=true)
- **Model:** gpt-6-luna (temp=0, reasoning=medium)
- **Worker:** לוסי (protected=true)
- **Production apply:** yes
- **Case filter:** full-filing-add-simple, full-mt-event-clarify-then-link
- **Score:** 0/2 passed (passRate=0.00, required=0.7)
- **Gates:** softOk=false criticalOk=false failed=[full-filing-add-simple, full-mt-event-clarify-then-link]
- **Suite:** FAIL

---

## 1. FAIL `full-filing-add-simple`
*tag:* happy
*tags:* filing, full-live, single-turn

### Scenario
File address persists
`תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב`

### Expectation
- **turn 0:** filing.add_filing

### Observed
- **turn 0** `תייקי שהכתובת שלי היא רחוב הרצל 1 תל אביב`
  - response: כדי לשמור את הכתובת, איך לפנות אליך — בלשון זכר או נקבה?
  - ACTION: (no mutations)
  - apply: no — state FAIL (facts~הרצל)
  - failures: expected filing.add_filing; facts: expected to include "הרצל"

### Verdict
**FAIL** — turn 0 constraints: expected filing.add_filing; turn 0 facts: expected to include "הרצל"

---

## 2. FAIL `full-mt-event-clarify-then-link`
*tag:* continuity
*tags:* events, mt-clarify, mt-complex, full-live, multi-turn, core-pack

### Scenario
Event clarify→link persists host + כיבוד
`תוסיפי רשימת כיבוד? → עוגה ושתיה`

### Expectation
- **turn 0:** no mutations + ask
- **turn 1:** lists_custom_create_and_link + lists.update:tasks + no_lists_add + no list_ops

### Observed
- **turn 0** `תוסיפי רשימת כיבוד?`
  - response: בטח — מה תרצי לכלול ברשימת הכיבוד לערב יום ההולדת?
  - ACTION: (no mutations)
  - apply: no — state ok (facts~ערב יום הולדת)
- **turn 1** `עוגה ושתיה`
  - response: עדכנתי את «ערב יום הולדת» ברשימת «הרשימה». לא הצלחתי להוסיף את הפריט.
  - ACTION: lists.add:custom[עוגה,שתייה]; lists.update:tasks[6be3b22f-47ef-4a4b-a32…]
  - apply: yes — state FAIL (facts~כיבוד|עוגה|ערב יום הולדת)
  - failures: lists_custom_create_and_link: custom lists.add with items requires non-empty list_name; facts: expected to include "כיבוד"; facts: expected to include "עוגה"

### Verdict
**FAIL** — turn 1 constraints: lists_custom_create_and_link: custom lists.add with items requires non-empty list_name; turn 1 facts: expected to include "כיבוד"; turn 1 facts: expected to include "עוגה"

---
