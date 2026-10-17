# Cooperative Registration / Join + My Cooperative — Task Plan

## Project Structure

| Path | Purpose |
|------|---------|
| `.trae/specs/coop-registration-join-fix/spec.md` | Requirements & acceptance criteria |
| `.trae/specs/coop-registration-join-fix/tasks.md` | This file: task breakdown + execution plan |
| `.trae/specs/coop-registration-join-fix/review.md` | Independent review (created after implement) |

---

## Task List

All tasks are ordered by dependency. Each task maps to the ACs it satisfies.

### Phase A — Build Blockers (MUST DO FIRST)

#### TASK-A1 · Restore the missing `dataService.js` barrel re-export

- **Goal**: Eliminate the missing-module runtime error so Registration, AccountBalance, and main.js load.
- **What to do**:
  1. Create a new file `src/services/dataService.js`.
  2. This file does **nothing** except `export * from './data/index.js'`. (The barrel at `services/data/index.js` already exports registerCooperative, all membershipRequests functions, fetchAllMembers, fetchEnterprises, fetchBanks, fetchRemittances, fetchMemberPaymentAdvise, buildAccountBalance, isNotDeleted, fetchMembersBySearch, addMember, fetchAllCooperatives, etc. — one line re-export is sufficient.)
  3. Do **not** migrate existing import statements — keep them as-is; the missing file is being restored.
- **Files touched**: `src/services/dataService.js` (create — single export-star line only).
- **Why this order?**: Without this, Registration.js and AccountBalance.js fail at import-time, so every downstream test is meaningless.
- **Tests (rule TR)**:
  - TR-A1.1: App boots with no module-resolution console error referencing `../services/dataService.js`.
  - TR-A1.2: Navigate to Register via Landing → Register. Screen paints fully; no blank/white failure.
  - TR-A1.3: Login as any member. Dashboard (AccountBalance) loads its financial cards without errors.
- **AC Coverage**: AC-B1, AC-R1, AC-M1 (indirectly — AccountBalance must load first).
- **Priority**: BLOCKER.

---

### Phase B — Register Cooperative (UI + Submission)

#### TASK-B1 · Rework Registration.js layout, sections, labels, required/optional indicators

- **Goal**: FR-2 (Register UX sections & labels).
- **What to do**: In the render phase of `renderRegistration()` inside [Registration.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/Registration.js):
  1. Add a scoped `<style>` block (SYS_CSS pattern) prefixed with `#registration-wrap`. Use only classes inside that selector — no global `.card` overrides. Define: `.reg-section`, `.reg-section-title`, `.reg-grid`, `.required-star`, `.field-label-optional`, `.reg-help-text`, `.validation-message`, `.reg-actions`, `.alert-success`, `.alert-error`, `.alert-info`, `.btn-loading` (spinner text helper). Also add @media rules for `<720px` full-width + stacks.
  2. Organize the existing fields into clearly-labelled 4 sections with headers:
     - Section 1 — Cooperative Information (full_name, short_name, contact_number, email).
     - Section 2 — Cooperative Logo (logo_path file input + existing `<img id="reg-logo-preview">`).
     - Section 3 — Location & Settings (address textarea, coop_first_month date).
     - Section 4 — Admin Account (username read-only "admin" display, info box restating: default password will be `123456` — **not** the old "random 4-digit" claim; see spec NFR-3 note. This is a UI-copy correction only, service unchanged).
  3. Apply `*` required-star marker to: full_name, short_name, contact_number, address, coop_first_month. Label email "Optional". Label logo "(Optional, PNG/JPG, auto-resized)".
  4. Swap input types: `type="tel"` for contact_number, `type="email"` for email, `type="date"` for coop_first_month, `accept="image/*"` on file.
  5. Keep activation-key two-step flow exactly as-is, but wrap the prompt in a dedicated `.alert-info` box that clearly states the YYDDMM rule and shows today's hint as a helper line (not in the input).
  6. Replace the password success `div` with a proper `.alert-success` block that makes the password prominent (e.g. a mono-style badge) and shows a visible countdown/redirect notice.
  7. Add an inline error `div.alert-error` that renders inside the action area (not above the form where it scrolls out of view) — both for form-validation errors and runtime errors.
  8. Keep sessionStorage draft `cooplog-reg-draft` + Clear Form button (add `.ghost-button` class for consistent styling).
- **Files touched**: `src/screens/Registration.js` (render phase only, new `<style>` block + field layout reorg inside `#registration-wrap`).
- **Tests (rule TR)**:
  - TR-B1.1: 4 section titles are visible.
  - TR-B1.2: Required fields show `*`. email, logo show "(optional)" or equivalent.
  - TR-B1.3: contact_number = tel, email = email, coop_first_month = date, logo accept=image/*.
  - TR-B1.4: Admin section info box says default password `123456` — no mention of 4-digit random.
  - TR-B1.5: Mobile (devtools @ 375×812): all fields 100% width, no horizontal scroll, buttons tappable (≥44px).
- **AC Coverage**: AC-R2, AC-R7, NFR-2, NFR-5, AC-C3.

#### TASK-B2 · Add Registration.js inline field-validation messages + submit-time guard

- **Goal**: FR-2 (validation messages) + FR-3 (prevent activation-key flow on invalid form).
- **What to do**:
  1. Introduce a `const errors = {};` state object before validation runs.
  2. On submit, validate the fields:
     - full_name / short_name: trimmed length ≥ 2 characters.
     - contact_number: normalizePhone then ensure it starts with "+" or digit, length ≥ 8.
     - email: if filled, match a simple regex; empty is OK (optional).
     - address: trimmed length ≥ 5.
     - coop_first_month: non-empty valid date.
  3. For each field with an error, populate `errors[fieldName]` with a readable message and render a `<span class="validation-message">` immediately after the `<input>`. Use a shared helper `renderFieldError(key)`.
  4. If any required error exists, **do not** set `awaitingActivationKey = true`; instead show a top inline alert "Please fix the errors below" and stop.
  5. Preserve HTML5 native validation too — the custom messages are additive, not a replacement. Keep `required` attributes so autofocus-to-first-error still works.
- **Files touched**: `src/screens/Registration.js` (submit handler + render helper + field error spans).
- **Tests (rule TR)**:
  - TR-B2.1: Click "Register Cooperative" with empty required fields → inline validation messages appear, activation-key section does NOT render.
  - TR-B2.2: Type invalid email (e.g. "foo") → inline validation message "Please enter a valid email or leave blank" on submit.
  - TR-B2.3: Fix all errors, submit again → activation-key section appears.
- **AC Coverage**: AC-R3.

#### TASK-B3 · Fix Registration.js submission state & double-click guard

- **Goal**: FR-3 (correct loading, dedup, success/error lifecycle).
- **What to do**:
  1. Move `let isSubmitting = false;` to the module-level-or-closure scope so it's shared between the **initial** submit button handler and the Verify & Create click handler (currently the initial submit at `submit` listener does NOT check it).
  2. In BOTH click paths:
     - Start: `if (isSubmitting) return;` then `isSubmitting = true;`.
     - Immediately after: disable the triggering button and swap its text to a spinner-style label ("Validating…" / "Creating…") + add `.btn-loading`.
     - Error or finally: `isSubmitting = false;`, re-enable the button, restore original text, remove `.btn-loading`.
  3. Activation-key verification: if wrong key, return early and re-enable; never call `registerCooperative`.
  4. Call `registerCooperative(coopData)` exactly once per valid verification. On success:
     - Populate the success alert with `result.generatedPassword`.
     - Clear `sessionStorage.removeItem('cooplog-reg-draft')`.
     - After ~2500ms, call the existing `onSuccess` callback (do not change this callback — it's wired in main.js).
  5. On error from `registerCooperative`, populate the `.alert-error` div with `err.message || 'Registration failed. Please try again.'` and do NOT clear the draft.
  6. Ensure form fields remain disabled while `isSubmitting === true` in either phase.
- **Files touched**: `src/screens/Registration.js` (state scope, initial submit guard, verify&create handler, button text/disabled, error/success branches).
- **Tests (rule TR)**:
  - TR-B3.1: Double-click Verify & Create → only 1 call to registerCooperative (count via breakpoint or log).
  - TR-B3.2: Button shows "Creating…" while running.
  - TR-B3.3: Success → green block with `123456` visible → redirect to login at ~2.5s → login screen appears with admin prefilled.
  - TR-B3.4: Force a `registerCooperative` rejection (e.g. disconnect DB temporarily or modify call to throw) → red alert appears, button re-enabled and original text, fields still retain values.
- **AC Coverage**: AC-R4, AC-R5, AC-R6, AC-B3.

---

### Phase C — Join Cooperative (UI + Submission)

#### TASK-C1 · Rework JoinCooperative.js layout, sections, labels, indicators (mirror Register style)

- **Goal**: FR-4 (Join UX) + AC-C3 (visual consistency with Register).
- **What to do**:
  1. Add a scoped `<style>` block inside `#join-coop-wrap` with the EXACT SAME class vocabulary and spacing as TASK-B1: `.reg-section`, `.reg-section-title`, `.reg-grid`, `.required-star`, `.field-label-optional`, `.validation-message`, `.reg-actions`, `.alert-success/error/info`, `.btn-loading`, plus identical @media rules for <720px.
  2. Organize the existing fields into 3 sections:
     - Section 1 — Cooperative (the `<select id="join-cooperative-select">` + loading state + retry UI; wrap the loading/error messages in alerts).
     - Section 2 — Personal Information (last_name, first_name, middle_name).
     - Section 3 — Contact & Photo (mobile, address, passport photo file + preview).
  3. Required markers: Cooperative select, Last Name, First Name, Mobile → `*`. Optional labels: Middle Name, Address, Passport Photo "(optional, auto-resized)".
  4. Keep and restyle the existing info box (no activation key needed, default 123456 after approval) into `.alert-info`.
  5. Swap input types: Mobile = `type="tel"`, photo = `accept="image/*"`.
  6. Mobile breakpoint styling identical to Register (stack everything, full width).
- **Files touched**: `src/screens/JoinCooperative.js` (render phase only — new `<style>` + reorganized sections).
- **Tests (rule TR)**:
  - TR-C1.1: 3 section titles visible; required `*` on 4 fields; middle/address/photo marked optional.
  - TR-C1.2: Mobile (375×812): fields stack, select wraps long names, no horizontal scroll, buttons tappable.
  - TR-C1.3: Info box `.alert-info` states no-key rule and default password.
- **AC Coverage**: AC-J3, AC-J7, AC-C3, NFR-2, NFR-5.

#### TASK-C2 · Add JoinCooperative.js inline validation + field error messages

- **Goal**: FR-4 (validation feedback).
- **What to do**:
  1. Mirror TASK-B2 pattern: local `errors = {}` + `renderFieldError(key)` helper.
  2. Validate on submit:
     - cooperative: non-empty selection (not the "" placeholder option).
     - last_name / first_name: trimmed length ≥ 2.
     - middle_name: optional; empty OK.
     - mobile: after normalizePhone, start with "+" or digit, length ≥ 8.
     - address: optional.
  3. If any errors, show inline messages AND a top `.alert-error`; do NOT call `submitMembershipRequest`.
- **Files touched**: `src/screens/JoinCooperative.js` (submit handler + render helper + error spans).
- **Tests (rule TR)**:
  - TR-C2.1: Submit with nothing filled → 4 inline error messages on the 4 required fields + top alert.
  - TR-C2.2: Select a cooperative, fill last/first, enter invalid "abc" phone → mobile field error "Please enter a valid phone number".
  - TR-C2.3: Fix all errors, submit → valid flow proceeds to `submitMembershipRequest()`.
- **AC Coverage**: AC-J3 (partial), AC-J4 (prerequisite).

#### TASK-C3 · Fix JoinCooperative.js submission state, list-load UX, and dedup

- **Goal**: FR-4/FR-5 (list states, loading, dedup, error/success lifecycle).
- **What to do**:
  1. Refactor the existing cooperative-list loading state so:
     - While loading: select is disabled, placeholder option shows "Loading cooperatives…" in `.text-muted`, no spinner flicker.
     - Network failure/timeout: the placeholder option shows "Failed to load — click Retry"; a visible `.alert-error` box with a `.secondary-button` Retry button that re-invokes `loadCooperativesForJoin()`; the Submit button stays disabled while the list is empty (use `!selectedCoopId || isLoadingCoops`).
     - Success: list populates with the existing pattern (only `full_name` as label, id as value).
  2. Submission state:
     - `isSubmitting` already exists — verify it guards the Submit click properly AND that on failure the button is unconditionally re-enabled inside a `finally {}` block (move button restoration out of catch-only if it's not already there).
     - On submit: button text → "Submitting…", add `.btn-loading`, disable; on resolve → reset text; on reject → reset text and show `.alert-error`.
  3. Double-click guard: verify `isSubmitting` check is the FIRST statement in the handler (before any validation). If not, move it up.
  4. Success handling: keep existing `submitted = true` render branch (success card), but verify that `sessionStorage.removeItem('cooplog-join-draft')` happens ONLY after the call resolves, not before.
  5. Failure handling: keep the draft in sessionStorage; do not auto-redirect.
- **Files touched**: `src/screens/JoinCooperative.js` (loadCooperativesForJoin, submit handler, finally/error/success branches, button state wiring).
- **Tests (rule TR)**:
  - TR-C3.1: Load Join with network disabled (or throttle to Offline in devtools) → timeout/error → red alert with Retry button visible, Submit disabled.
  - TR-C3.2: Click Retry after re-enabling network → list populates.
  - TR-C3.3: Valid submit → button shows "Submitting…" disabled → 1 call to submitMembershipRequest (no double on rapid double-click).
  - TR-C3.4: Success card shows selected cooperative name + Back to Login button.
  - TR-C3.5: Simulate `submitMembershipRequest` throw → red alert, button re-enabled, values retained, draft NOT cleared.
- **AC Coverage**: AC-J1, AC-J2, AC-J4, AC-J5, AC-J6, AC-B3.

---

### Phase D — Choice Screen Consistency & Navigation

#### TASK-D1 · Polish choice screen card style; verify back/forward links

- **Goal**: FR-6 (consistent look + correct navigation).
- **What to do**:
  1. Locate the Create-vs-Join two-card choice rendering block inside `main.js` around L1742-L1777.
  2. Add a small scoped `<style>` for this section only (prefix with `.login-shell` selector) — reuse the same card classes/variables used by Register/Join so radii, shadows, and accent match. Do not add a global `.card` rule (existing reconciliation/dashboard layout will break).
  3. Add icon emojis to each card heading: ✨ "Create a New Cooperative" (Register CTA) and 🤝 "Join an Existing Cooperative" (Join CTA). Keep existing sub-headings and onClicks.
  4. Verify & fix nav transitions end-to-end:
     - From Login → Register link → choice screen loads.
     - Choice → Create → Registration.js loads; Registration's Back button → returns to choice screen (check `backCallback` wiring).
     - Choice → Join → JoinCooperative.js loads; Join's Back button → returns to choice screen.
     - Choice → Back to Login (check existing back-link button below cards is visible and correctly sets `showRegisterChoice=false; showLogin=true` or equivalent).
     - Join success card → "Back to Login" → Login page (not back to choice — verify existing wiring).
     - Registration success → redirects to Login with username 'admin'.
- **Files touched**: `src/main.js` (choice-screen render block + nav wiring tweaks ONLY if broken).
- **Tests (rule TR)**:
  - TR-D1.1: Login → Register → 2 cards visible with icons.
  - TR-D1.2: Create → Register → Back → returns to choice screen (NOT login).
  - TR-D1.3: Join → Join screen → Back → returns to choice screen.
  - TR-D1.4: Choice screen "Back to Login" → Login appears.
- **AC Coverage**: AC-C1, AC-C2, AC-C3.

---

### Phase E — My Cooperative Summary Restoration (Member Dashboard)

#### TASK-E1 · Implement member-dashboard "My Cooperative" summary block

- **Goal**: FR-7 + NFR-4 (render the member summary BEFORE the Net Portfolio hero, using ONLY existing fields from cooperatives + members rows).
- **What to do**:
  1. Open [AccountBalance.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/AccountBalance.js) render function. Locate the point where `isMember === true` branch starts and renders `<h3>My Net Portfolio</h3>` or the `#dashboard-net-portfolio-hero` hero card.
  2. Add a new render step BEFORE that hero, inside the same `if (isMember)` branch:
     ```html
     <section id="member-summary-wrap" class="card" style="margin-bottom: 1.5rem;">…</section>
     ```
  3. Wrap in a scoped `<style>` block prefixed with `#member-summary-wrap` — define:
     - `.summary-grid` — desktop: `grid-template-columns: auto 1fr 1fr; gap: 1.25rem 1.5rem; align-items: center;` — this positions logo + name on the left, coop contact on middle-right, member info on far right. Use a @media rule for <720px to collapse to 1 column.
     - `.summary-logo` — 48×48 circular.
     - `.summary-pill` — for status (Active/Inactive/Suspended, matching the same colors used on members page stat cards: green=Active / yellow=Inactive / red=Suspended).
     - `.summary-label` — text-xs muted label above each value; `.summary-value` — semibold.
     - Use var(--bg-card) already set for the card; radius var(--radius-lg).
  4. Data population (render-time JS inside AccountBalance, after state.loaded becomes true for the member/coop rows):
     - **Cooperative row**: use the existing state.cooperative (or load via `getAllForCoop(cooperativeId, 'cooperatives')[0]` in the existing load chain, the same pattern settings/cooperative.js uses).
     - **Member row**: use `await loadDoc('members', user.memberId, cooperativeId)` in the same async load chain at the top of renderAccountBalance (merge into existing awaits, do not add a separate parallel fetch).
  5. Map EXISTING fields to UI:
     - Heading area: logo_path (fallback: 48×48 circular box with `getInitials(full_name)` in gray) + full_name as `<h3>` + a small secondary badge `#${short_name}`.
     - Coop contact column:
       - Label "Phone" / Value: `<a href="tel:${contact_number}">${contact_number ?? '—'}</a>`
       - Label "Email" / Value: `<a href="mailto:${email}">${email ?? '—'}</a>`
       - Label "Address" / Value: `${address ?? '—'}` (wrap in a multi-line block; never overflow horizontally — use `overflow-wrap: anywhere`).
     - Member column:
       - Label "Reg No" / Value: `registration_no ?? '—'`
       - Label "Member since" / Value: format `date_joined` with `formatDate` from utils (same formatter used by members table).
       - Label "Status" / Value: `.summary-pill` with matching color + `status ?? 'Unknown'`
       - Label "My Contact" / Value: mobile (normalize + "—" fallback).
  6. Graceful fallback for any null/undefined field → '—', never a blank column, never throw. Keep existing `<img>` onerror fallback to initials (same pattern used on the sidebar logo and members page avatars).
  7. **Admin guard**: Only render the block `if (isMember)`. Do NOT render for admin users (admin dashboard hero is unchanged).
- **Files touched**: `src/screens/AccountBalance.js` (async data-load stage + new `#member-summary-wrap` `<section>` + scoped `<style>` block).
- **Tests (rule TR)**:
  - TR-E1.1: Login as member → AccountBalance shows `#member-summary-wrap` BEFORE the Net Portfolio hero.
  - TR-E1.2: Values match the source rows: contact_number, email, address from cooperatives; registration_no, date_joined, status, mobile from members.
  - TR-E1.3: logo_path filled → thumbnail. logo_path empty → initials box (no broken image icon).
  - TR-E1.4: Admin user login → no summary block; Net Portfolio area + admin Savings/Loans/Cash/Revenue cards unchanged.
  - TR-E1.5: Mobile (375×812): summary grid collapses to 1 column; contact lines wrap; no horizontal scroll.
- **Tests (rubric TR)**:
  - TR-E1.6 (rubric, 0–2): Summary visually matches the dashboard fintech style. Pass ≥ 1.5.
- **AC Coverage**: AC-M1, AC-M2, AC-M3, AC-M4, AC-M5, AC-M6, NFR-4.

---

### Phase F — No-Regression Verification (pre-review)

#### TASK-F1 · Smoke-test entire authenticated app + join-request approval flow

- **Goal**: AC-B2 (no regression on member approve flow) + AC-B3 (write-queue integrity) + AC-B1 (no runtime errors).
- **What to do**:
  1. Boot the app. Open DevTools console — keep open for the full session.
  2. **Register flow** (TASK-A1 + TASK-B3 combined evidence):
     - Landing → Register → Create → fill → submit → correct YYDDMM → success with 123456 → redirected to login.
     - Login as admin / new coop. Immediately visit Settings → Cooperative. Confirm coop data persisted (full_name, short_name, contact, etc.).
     - Open SQLite dev inspector or the debug DB-dump UI. Confirm: 1 new cooperatives row, 1 new users row (admin), sync_queue rows for set operations, both rows have `is_synced=0`.
  3. **Join flow** (TASK-C3 evidence):
     - Logout → Login screen → Register → Join → select the NEW coop you just created (if Firebase list not yet synced, use a long-existing coop instead).
     - Fill form → submit → success card. Note the name you entered.
     - Login as admin of THAT coop → Members page → click "Join Requests" stat card (or secondary view toggle) → see the request with status Pending.
     - Click Approve → confirm success. Confirm:
       - members table: 1 new row inserted, default password hash for 123456, `force_password_change=1` (if column exists).
       - membership_request row: status=Approved, reviewed_by, reviewed_at, member_id populated.
       - sync_queue rows present for both updates.
  4. **Regression pass on core screens**:
     - Dashboard → Savings/Loans/Cash/Revenue cards load.
     - Members page → list, filters, all 5 stat cards clickable, secondary views toggled.
     - Remittance → new remittance opens, dropdowns populate.
     - Reconciliation (if present on this build) → list of unreconciled loads without error.
     - Console should show **zero** new warnings/errors that were not already present before implementation.
- **Files touched**: NONE (testing-only task). If failures are found, the implementer must open a new small remediation task in this tasks.md and fix.
- **Tests**:
  - TR-F1.1 (rule): Register → DB writes confirmed to cooperatives + users + sync_queue.
  - TR-F1.2 (rule): Join → Approve → members row + membership_request stamped correctly.
  - TR-F1.3 (rule): Core 4 screens (Dashboard, Members, Remittance, Settings) render with no runtime errors in console.
- **AC Coverage**: AC-B1, AC-B2, AC-B3, all downstream ACs.

---

## Acceptance Criteria ↔ Task Matrix

| AC | Primary Task | Secondary Task |
|----|-------------|----------------|
| AC-R1 | A1 | — |
| AC-R2 | B1 | — |
| AC-R3 | B2 | — |
| AC-R4 | B3 | — |
| AC-R5 | B3 | — |
| AC-R6 | B3 | — |
| AC-R7 | B1 | — |
| AC-J1 | C3 | C1 |
| AC-J2 | C3 | — |
| AC-J3 | C1 + C2 | — |
| AC-J4 | C2 + C3 | — |
| AC-J5 | C3 | — |
| AC-J6 | C3 | — |
| AC-J7 | C1 | — |
| AC-C1 | D1 | — |
| AC-C2 | D1 | — |
| AC-C3 | B1 + C1 + D1 | — |
| AC-M1 | E1 | A1 |
| AC-M2 | E1 | — |
| AC-M3 | E1 | — |
| AC-M4 | E1 | — |
| AC-M5 | E1 | — |
| AC-M6 | E1 | — |
| AC-B1 | A1 | F1 |
| AC-B2 | F1 | — |
| AC-B3 | B3 + C3 | F1 |

---

## Implementation Order

Implement **in this order**. Do not skip tasks or reorder.

1. **A1** (restore barrel) → run TR-A1.1/A1.2/A1.3 smoke tests immediately.
2. **B1** → **B2** → **B3** (Register top→bottom) → self-verify TR-B1.* through TR-B3.*
3. **C1** → **C2** → **C3** (Join top→bottom) → self-verify TR-C1.* through TR-C3.*
4. **D1** (choice screen polish + nav) → TR-D1.1–D1.4
5. **E1** (My Cooperative summary) → TR-E1.1–E1.5 + rubric TR-E1.6
6. **F1** (full smoke test + evidence screenshots)

---

## Rubric Scoring Guide (for implementer self-review and for post-implement Review Phase)

- **AC-C3 (Register/Join/Choice consistency rubric, 0–2)**:
  - 0: Completely different looks between Register vs Join vs Choice cards.
  - 1: Similar spacing and card radius but different typography, different button classes, or sections don't match.
  - 2: Consistent class vocabulary, the same spacing scale, same section headers, same required-star, same alert style, same button family across all three screens.
- **AC-M5 (My Coop summary style fit rubric, 0–2)**:
  - 0: Summary looks like an alien block inside the dashboard — wrong radius, wrong colors, clashing typography.
  - 1: Mostly matches but spacing is off or 1–2 colors don't follow theme.
  - 2: Indistinguishable look-and-feel from the existing stat cards; uses the project's CSS vars consistently, same shadows, radius, label-to-value density.
- **TR-E1.6 (same as AC-M5, captured in both places for completeness)**.
