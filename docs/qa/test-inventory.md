# QA test inventory

**Branch:** `test/qa-phase-2-ui`  
**Total cases:** 250

Coverage grids stay in the phase matrices. This file is the full numbered list of every `it(...)`.

## Contents

| # | Area | File | Cases |
|---|------|------|------:|
| 1.1 | Engine | [`employee-records.test.ts`](../../backend/tests/employee-records.test.ts) | 40 |
| 1.2 | Engine | [`directory-apply.test.ts`](../../backend/tests/directory-apply.test.ts) | 3 |
| 1.3 | Engine | [`contact.test.ts`](../../backend/tests/contact.test.ts) | 5 |
| 1.4 | Engine | [`reminders.test.ts`](../../backend/tests/reminders.test.ts) | 42 |
| 1.5 | Engine | [`pending-action.test.ts`](../../backend/tests/pending-action.test.ts) | 17 |
| 1.6 | Engine | [`jobs.test.ts`](../../backend/tests/jobs.test.ts) | 36 |
| 1.7 | Channel | [`whatsapp.test.ts`](../../backend/tests/whatsapp.test.ts) | 22 |
| 1.8 | Channel | [`whatsapp-session.test.ts`](../../backend/tests/whatsapp-session.test.ts) | 4 |
| 1.9 | API path | [`chat.test.ts`](../../backend/tests/chat.test.ts) | 27 |
| 1.10 | Schema | [`llm-config.test.ts`](../../backend/tests/llm-config.test.ts) | 2 |
| 2.1 | UI | [`LoginPage.test.tsx`](../../frontend/src/pages/Login/LoginPage.test.tsx) | 9 |
| 2.2 | UI | [`DashboardPage.test.tsx`](../../frontend/src/pages/Dashboard/DashboardPage.test.tsx) | 5 |
| 2.3 | UI | [`ChatPage.test.tsx`](../../frontend/src/pages/Chat/ChatPage.test.tsx) | 17 |
| 2.4 | UI | [`chatTime.test.ts`](../../frontend/src/pages/Chat/chatTime.test.ts) | 2 |
| 2.5 | UI | [`EmployeesPage.test.tsx`](../../frontend/src/pages/Employees/EmployeesPage.test.tsx) | 15 |
| 2.6 | UI | [`WhatsAppPage.test.tsx`](../../frontend/src/pages/WhatsApp/WhatsAppPage.test.tsx) | 4 |

---

## 1. Phase 1 — engine / backend

### 1.1 `employee-records.test.ts` — 40

1. builds an identity key from Hebrew shopping and task fields
2. collapses update-draft keys onto the real column
3. on lists update, stores only the new name (not שם + שם חדש)
4. snapshot hides leftover שם חדש draft keys
5. guest snapshot excludes personal shopping and keeps shared partner lists
6. ignores list_name when identifying a custom row
7. fills a spoken fallback when remove applied but model left response empty
8. removes a custom row found on another list name for the same owner
9. prefers the saved list type when the model guesses wrong
10. resolves filing remove names with slight Hebrew wording drift
11. updates a filing when update_filing uses slight Hebrew name drift
12. does not create a filing when update_filing matches nothing
13. soft-deletes a filing when remove_filing uses slight Hebrew name drift
14. does not soft-delete when remove_filing matches nothing
15. refuses add_filing when item_description is empty
16. derives a custom list title from item list_name when the list row name is empty
17. treats list-title placeholders as phantom custom items
18. rewrites shopping wording when the remove was from tasks
19. removes a task even when the model labeled it shopping
20. parses assignment notes for another employee's shopping
21. formats saved employee data for a new LLM conversation
22. formats dated team schedules for meeting conflict checks
23. scopes team schedules with the same ownership gate as saved data
24. ties worker items to a speaker via addedBy, visibleTo, or reminder owner/ping
25. scopes WORKER_SAVED_DATA items to the current human viewer
26. applies add, update, and remove actions for lists, tasks, and filings
27. updates the only task when the new name does not match the stored key
28. notifies watchers and clears assignment tasks when the owner buys a shared item
29. returns a snapshot of saved lists and filings
30. includes empty shared custom lists with shared_with partners
31. derives list_name from שם הרשימה when the list row name is empty
32. returns owned records with creator and created time
33. hides leftover assignment tasks when the shopping item is gone
34. emits watcher events when a shared item is added
35. removes a shared custom row even when the model repeats list_name on the item
36. updates a shared custom row matched by תיאור, not list_name
37. matches a shorter bought name to the saved shared item
38. notifies assignment watchers when a bought item was not marked shared
39. notifies watchers when a shared item is updated from employee records
40. notifies watchers when a shared item is deleted from employee records

### 1.2 `directory-apply.test.ts` — 3

1. adds a contact via upsert on phone
2. removes a contact by phone or name
3. skips remove when no row matched

### 1.3 `contact.test.ts` — 5

1. matches contacts by name or phone
2. formats empty and filled speaker contacts
3. plans WhatsApp phone relays from a saved contact name
4. parses metadata.directory actions
5. formats a save notice

### 1.4 `reminders.test.ts` — 42

1. uses an in-seconds delay instead of a clock hour
2. uses the interval as the first ping when there is no clock
3. uses weekdays numbers plus 13:30, not a weekday word in date
4. does not treat date שני as Monday
5. returns null when neither a delay nor a clock is present
6. fires on an ISO date when the clock is present
7. does not treat date tomorrow as the next calendar day
8. rolls a clock that already passed today to tomorrow
9. keeps a clock that is still later today
10. shows Israel local time instead of UTC for saved reminders
11. keeps a phone number when it is not an employee
12. does not fall back to the speaker when only a non-employee name is given
13. does not harvest digits from item or mixed ping tokens
14. uses reminder targets as ping when ping is empty
15. maps a stored employee phone to that employee
16. shows the employee name, not masked phone digits
17. replaces an existing clock in the worker task name
18. appends a clock when the task name has none
19. links one new clock to one worker task even when labels differ
20. pairs by matching item text when there are several clocks
21. treats מיכל as an unknown name and asks for the number
22. holds a delete until the speaker confirms
23. cancels a pending delete
24. asks only for the named items the model listed
25. applies the held deletes when they confirm even if remove is sent again
26. does not expand item all into other reminders
27. times out a stale pending delete
28. abandons pending delete when unrelated work arrives
29. does not treat a finished clock as sent when WhatsApp failed
30. lists only active rows from the database snapshot
31. lists shopping, tasks, and self-reminders, not a send to someone else
32. speaks as Lucy about her own task
33. reuses the clock on update even without a new time
34. reuses the clock for a text-only add-shaped edit of an existing send
35. does not reuse when there is no existing clock
36. does not treat a new timed add as text-only reuse
37. matches across owners by label
38. returns undefined when nothing matches
39. says when a reminder was stored or skipped
40. notes another active clock at the same time without blocking
41. notes a compose-at-fire brief was stored
42. matches a short name to the stored label

### 1.5 `pending-action.test.ts` — 17

1. stores a directory hold and reinjects context for the missing field
2. holds a missing WhatsApp body and fills it from the short reply
3. applies confirm_share list drafts on yes even if the model emits private shopping
4. applies confirm hold with a custom list remove draft on כן
5. aligns empty shopping targets with same-turn message recipients
6. fills a git-digest time hold when the speaker says עכשיו
7. recognizes cancel phrases for awaiting message holds
8. clears all draft domains and picks a cancel reply per hold kind
9. keeps the hold until the directory add is completed
10. lets a fresh hold replace a previous incomplete draft
11. lets reminder delete confirm win over a hold
12. holds two or more list removes until confirm
13. applies held list removes after confirm=true
14. cancels held list deletes on confirm=false
15. applies a single list remove immediately
16. applies model hold removes on confirm=true without delete_lists pending
17. round-trips delete_lists through pending storage

### 1.6 `jobs.test.ts` — 36

1. reads a job row and hides the reserved key from saved data
2. ignores rows that are not jobs
3. tells the subject it is theirs to answer and quotes the original ask
4. marks a scheduled job as not raisable and stays empty with no jobs
5. keeps a no-clock deferral raisable for the subject
6. shows the asker they are waiting, not that they owe the answer
7. opens one shared job row on the worker, visible to both people
8. falls back to the relayed text when the worker gave no ask summary
9. opens a second job when the same people already have a different ask
10. skips a second row when the same ask is already open
11. updates the existing job when this turn already progressed that row
12. does not open a second job when the same ask is already open in the other direction
13. opens a new job when the reverse pair is open with a different ask
14. stores the booking slot on the job so a plain yes can book it
15. never opens a job on the asker themselves
16. keeps job rows for the asker and subject and drops nudges and outsiders
17. replaces a reply that is the line written to the other person
18. replaces a reply that is the report meant for the asker
19. leaves a real confirmation and a real ack alone
20. closes an answered job and reports back to the asker
21. writes a plain report that quotes the ask when the model gave none
22. does not echo a progress report back to the asker who just spoke
23. keeps the job open on progress and stores the note
24. flips who must answer on a counter and asks them to approve
25. applies a counter that omitted the job id when only one job is open
26. binds a missing job id to the one task this speaker still owes, among several
27. asks which task when this speaker owes more than one and the id is missing
28. saves the approved counter as a shared meeting for both people
29. books the titled meeting for both people on a plain yes
30. ignores a counter that names no new slot
31. snoozes with a clock plus its own nudge task, linked both ways
32. defers without a clock when no time was named
33. leaves someone else's job open when the subject cancels only the clock
34. closes the job when its own asker cancels the clock
35. tells the other person when a job is cancelled outright
36. ignores actions for jobs that were not shown this turn

### 1.7 `whatsapp.test.ts` — 22

1. returns the hub challenge when the verify token matches
2. rejects a wrong verify token
3. acknowledges inbound text messages
4. redacts tokens in the flow log
5. keeps WhatsApp status behind auth
6. matches local and WhatsApp phone numbers
7. treats a 24h inbound window as open only while it lasts
8. applies an LLM handoff to a digital worker
9. extracts inbound text messages and ignores status updates
10. returns 503 when the verify token is not configured
11. sends a Hebrew fallback when the real reply keeps failing
12. retries transient Graph failures then succeeds
13. does not retry permanent no_session Graph errors
14. classifies Meta #2 as transient and 131047 as permanent
15. marks the inbound message read and shows typing
16. does not call Meta for typing in test
17. does not call Meta when delivering relays in test
18. explains a skipped WhatsApp send without a 24h window
19. keeps the model response and only appends an engine notice
20. replaces a false sent claim when WhatsApp delivery failed
21. appends partner notify skips without erasing a shared-list delete reply
22. serves privacy, data-deletion, and terms HTML

### 1.8 `whatsapp-session.test.ts` — 4

1. claims a new inbound message id
2. skips a duplicate inbound message id
3. persists the active digital worker for a phone
4. loads the active digital worker id for a phone

### 1.9 `chat.test.ts` — 27

1. rejects unauthenticated chat
2. rejects unauthenticated history
3. sends a message to the LLM and returns the reply
4. stores LLM usage for the speaker, worker, and conversation
5. lets Lucy save a reminder without handing off to David
6. follows a handoff when the speaker asks to talk to David
7. asks a digital co-worker now and adds her answer to Lucy's reply
8. rotates the OpenAI conversation when the request is too large
9. reuses the same conversation for the same user and employee
10. reuses the saved conversation after logout and login
11. returns saved history for an employee
12. returns empty history when the employee has no conversation
13. rejects unauthenticated reset
14. resets the conversation id and stored history
15. resets an idle conversation when history is loaded
16. starts a new OpenAI conversation after a day of idle chat
17. starts a separate conversation for each employee
18. starts a separate conversation per digital employee using that worker's DB prompt
19. includes current employee records in every LLM turn
20. saves list, task, and filing actions from the LLM onto the employee
21. saves a targeted action on the other employee and pushes an assistant notification
22. saves a task for Tal only when the LLM set targets
23. notifies the person who added a shared item when the owner buys it
24. notifies the other employee when a shared item is updated
25. relays an LLM-phrased message to Tal's Lucy thread
26. does not relay when the LLM omitted messages
27. delivers a pure-info message to a digital employee on the speaker thread

### 1.10 `llm-config.test.ts` — 2

1. loads Lucy json_schema from LLM.action.json
2. attaches the schema when loading Lucy config

---

## 2. Phase 2 — UI / frontend

### 2.1 `LoginPage.test.tsx` — 9

1. renders the login form
2. shows validation errors for empty fields
3. shows a validation error for an unsupported username
4. stays on the login page when credentials are invalid
5. redirects to the dashboard after a successful login
6. uses a responsive centered card layout
7. redirects unauthenticated users from the dashboard to login
8. renders the dashboard for an authenticated user
9. redirects authenticated users away from login

### 2.2 `DashboardPage.test.tsx` — 5

1. displays a greeting with the authenticated username
2. opens the employees screen from the Employees tab
3. opens the chat screen from the Chat tab
4. opens the WhatsApp screen from the WhatsApp tab
5. logs the user out and returns to login

### 2.3 `ChatPage.test.tsx` — 17

1. shows saved chat history when opening a conversation
2. keeps the speaker message before the assistant when history timestamps tie
3. only refreshes the selected Chat As and Chat With pair
4. sends the typed message to the API and shows the reply
5. shows only the JSON response in the dialog and an action when present
6. sends the message when Enter is pressed
7. keeps a separate thread for each Chat As employee
8. keeps a separate thread for each Chat With digital employee
9. shows an error when the chat API fails
10. turns Send red into Stop and cancels the request
11. keeps each employee conversation after changing tabs
12. shows a pushed assistant notification when switching to the target employee
13. shows a relayed Lucy message when switching to the target employee
14. refetches the other employee's thread so saved notifications appear
15. shows a live notification pushed from another session
16. resets the dialog to a new conversation
17. shows a new conversation when the server expires an idle thread

### 2.4 `chatTime.test.ts` — 2

1. shows milliseconds under one second
2. shows one decimal second from 1000ms

### 2.5 `EmployeesPage.test.tsx` — 15

1. lists employees and keeps default actions disabled until a row is selected
2. enables update and delete after selecting an employee
3. shows the team total and the human-only total next to Team
4. shows conversation count and total LLM cost for the selected employee
5. shows saved lists, tasks, and filings with creator and time
6. shows email and phone fields after choosing a person
7. shows model, temperature, and instructions for a digital employee
8. lets Inherit from Lucy overwrite the digital prompt fields
9. lets Lucy be edited but not deleted
10. edits a saved item and refreshes the records
11. deletes a saved item after confirmation
12. shows an error when the employees list fails to load
13. shows an empty-state message when there are no employees
14. creates a person and refreshes the list
15. shows an error when saved records fail to load

### 2.6 `WhatsAppPage.test.tsx` — 4

1. shows the Meta override mismatch and flow events
2. shows aligned webhooks without a mismatch alert
3. shows an error when status fails to load
4. reloads status when Refresh is clicked
