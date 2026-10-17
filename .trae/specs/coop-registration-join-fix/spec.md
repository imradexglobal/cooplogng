# Cooperative Registration / Join + My Cooperative — Fix & UI/UX Spec

## Problem

The CoopLogNG cooperative registration and join flows have regressed in functionality and UX, and the member dashboard ("My Cooperative") is missing a summary section that previously existed. Specifically:

1. **Critical Build Block**: Multiple source files import from `services/dataService.js` which does not exist (the barrel file lives at `services/data/index.js`), causing module resolution failures at runtime.
2. **Register Cooperative UI**: The form at [Registration.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/Registration.js) works but lacks clear section hierarchy, explicit validation messages, robust submission-state handling, and consistent mobile responsiveness.
3. **Join Cooperative UI**: The form at [JoinCooperative.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/JoinCooperative.js) similarly lacks polish, consistent state messaging, and mobile-optimized layout.
4. **My Cooperative Summary**: The member-role dashboard rendered by [AccountBalance.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/AccountBalance.js) no longer shows a cooperative+membership summary section at the top before the financial cards. Users must hunt for basic cooperative info in the sidebar header only.

All underlying data models (cooperatives, membership_request, members tables), service functions (registerCooperative, submitMembershipRequest, approve/decline), and sync architecture (saveDoc + enqueueWrite) are already correct and must be preserved.

## Users

- **First-time operators** who want to create a brand-new cooperative (register flow).
- **Prospective members** who want to apply to join an existing cooperative (join flow).
- **Regular members** who log in and land on the Dashboard — need a visible "My Cooperative" overview at a glance.
- **Admins / staff** — indirectly, because fixing the public flows and the member summary also keeps the authenticated member-facing UX consistent and reduces support questions.

## Goals

1. **Restore runtime integrity** — eliminate the missing `dataService.js` import so all screens (Register, AccountBalance, main.js) load without module errors.
2. **Fix Register Cooperative submission** end-to-end — no duplicate submits, correct loading state, success/error surfaces reliably, correct redirect to login with admin credentials shown.
3. **Fix Join Cooperative submission** end-to-end — same state guarantees, cooperative list loads/retries cleanly, success screen appears, no double-submit to membership_request.
4. **Professionalize the Register + Join UX** so both forms feel like the same product: clear sections, labels, required/optional indicators, validation messages, loading → success → error states, mobile responsive.
5. **Restore the My Cooperative summary block** on the member dashboard using existing data sources only (cooperatives table row + member's own row) — no new DB fields.
6. **Zero functional regression** in the authenticated app (members page, remittance, reconciliation, approval of join requests, sync).

## Non-Goals

- Do **not** redesign the cooperative business logic, approval rules, or permission model.
- Do **not** create new database fields, collections, tables, or parallel service layers.
- Do **not** modify the membership_request approval/decline workflow inside the members page (it already works via `membersJoinRequests.js`).
- Do **not** change the admin Cooperative Settings editor (`settings/cooperative.js`).
- Do **not** rewrite the sync engine or SQLite/Firestore mappings.

## Functional Requirements

### FR-1 — dataService.js Restoration

The application must resolve the following existing imports without error:

- `Registration.js`: `import { registerCooperative } from '../services/dataService.js'`
- `main.js`: `import { fetchAllMembers, fetchMembersBySearch, isNotDeleted } from './services/dataService.js'`
- `AccountBalance.js`: `import { buildAccountBalance, fetchEnterprises, fetchRemittances, fetchAllMembers, fetchBanks, fetchMemberPaymentAdvise } from '../services/dataService.js'`

All exports currently present in [services/data/index.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/data/index.js) must be available via `services/dataService.js` with identical names.

### FR-2 — Register Cooperative Form: UX

The screen rendered by `renderRegistration()` in [Registration.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/Registration.js) must:

- Display the existing 4 logical groups (Cooperative Information, Logo, Location & Settings, Admin Account) with visible section headers, spacing, and visual hierarchy.
- Label all required fields with a consistent `*` indicator; explicitly label optional fields with "(optional)".
- Use appropriate input types: `tel` for contact_number, `email` for email, `date` for first_month, `file` (accept image/*) for logo.
- Show helpful inline validation messages beyond raw HTML5 tooltips when the user interacts with a field and it's invalid, or on submit when required fields are empty.
- Keep the existing activation-key two-step flow (fill form → prompt YYDDMM key → on correct key → create → show password → redirect). Lock (disable) the form fields while the activation-key panel is visible.
- Show a clear loading state on the primary action while `registerCooperative` runs (button text like "Creating…", disabled).
- On success, display an unmissable success block that shows the generated admin password clearly and a countdown/redirect notice.
- On error, display a readable inline error message; re-enable the button and allow retry without losing form data.
- Preserve the existing sessionStorage draft key `cooplog-reg-draft` (auto-save, load on revisit, Clear Form button).

### FR-3 — Register Cooperative Submission Correctness

Tracing Form → `form submit` handler → `finishRegistration()` → `registerCooperative()` → `saveDoc('cooperatives')` + `saveDoc('users')` + `enqueueWrite` → UI response:

- `isSubmitting` guard must prevent double-click double-submit even if the user clicks rapidly.
- The loading state must be applied and cleared on the exact button that triggered the flow (Verify & Create during activation-key phase, Register Cooperative button submit phase disabled when awaiting key).
- The success block must be visible and stable for long enough to read (the existing 2500ms redirect is acceptable).
- On success, the draft in sessionStorage must be cleared.
- On error, the activation-key verification button is re-enabled and its text restored.
- `registerCooperative()` in [services/data/registration.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/data/registration.js) is invoked exactly as-is — no new parameters, no database schema changes.

### FR-4 — Join Cooperative Form: UX

The screen rendered by `renderJoinCooperative()` in [JoinCooperative.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/JoinCooperative.js) must:

- Mirror the Register page card shell, section style, typography, button hierarchy, and spacing for a consistent feel.
- Keep the existing 3 logical groups (Cooperative, Personal Information, Contact & Photo).
- Mark required fields (Cooperative select, Last Name, First Name, Mobile) with the same `*` indicator pattern used by Register.
- Explicitly label optional fields (Middle Name, Address, Passport Photo).
- Show a friendly info box that restates the no-activation-key rule and the default-password convention (123456, change on first login).
- Loading state for cooperatives list: show "Loading cooperatives…" inside the select. Network/timeout failure: show a red alert + "Retry" button, and keep the submit disabled until a valid cooperative is loaded.
- On submit, disable the button and show "Submitting…".
- On success, show the existing ✅ success card with cooperative name + back-to-login button (no auto-redirect — user reads the instructions first).
- On failure, show an inline alert with a readable message, re-enable the button, and keep field values.
- Preserve the existing `cooplog-join-draft` sessionStorage draft.

### FR-5 — Join Cooperative Submission Correctness

Tracing Form → `submit` handler → `submitMembershipRequest()` → `saveDoc('membership_request')` → `enqueueWrite` → UI:

- `isSubmitting` guard must block double-click double-submit.
- The cooperative dropdown shows only the full name (never the ID) per existing project rules. IDs are used as values only.
- `normalizePhone()` is applied to `mobile` before saving (already done — must remain).
- Photo upload uses `compressImage()` and stores the resulting data URL as `image_path` (already done — must remain).
- `status` is always `'Pending'`, `created_by` is `'self-register'`, `is_deleted=0`, `is_synced=0` (already correct — must remain).
- No duplicate rows are created on double submit, and the button state is restored on failure.

### FR-6 — Choice Screen Consistency (Create vs Join)

The choice screen inside the `render()` function of [main.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/main.js#L1742-L1777) must:

- Keep the existing two-card layout and back-to-login button.
- Align its visual style with Register/Join (same card radius, accent, spacing, brand header).
- Back links from inside Register and Join flows must correctly return to this choice screen (already mostly wired — verify no broken transitions).

### FR-7 — My Cooperative Summary Restoration

On the member dashboard — i.e., when `renderAccountBalance()` is called with `isMember === true` — render a summary section **near the top, before the "My Net Portfolio" financial hero card**. The summary must read exclusively from **existing** data:

- **Cooperative data** from `cooperatives` row for the current `cooperativeId`:
  - `full_name` → cooperative name (main heading).
  - `short_name` → small accent badge next to the name.
  - `logo_path` → 48×48 circular thumbnail (same thumbnail pattern as the sidebar header; fallback to initials via `getInitials`).
  - `contact_number` → phone (tel link on mobile).
  - `email` → email (mailto link).
  - `address` → physical address (truncated with wrap, never overflow horizontally).
- **Member data** from the logged-in member's row (load via `loadDoc('members', user.memberId, cooperativeId)`):
  - `registration_no` → "Reg No: XYZ".
  - `date_joined` → "Member since: DD MMM, YYYY".
  - `status` → "Status: Active/Inactive/Suspended" with a matching pill accent.
  - `mobile` → "My contact: +234…" (normalized).

Styling goal: compact, visually organized, responsive (stacks to single column under ~720px), matches the existing fintech-dashboard feel of AccountBalance.js (same var(--bg-card), var(--radius-lg), var(--border-light)). No new metrics invented beyond what the rows above provide.

### FR-8 — No Regression on Authenticated Screens

The following existing functionality must continue to work exactly as before:

- Members page list + filters + stat cards + join-requests approval flow.
- Remittance creation/edit/approval + reconciliation screens.
- Cooperative Settings editor under Settings > Cooperative (admin-only).
- Background sync of coops, membership_requests, members, remittances.
- Force-password-change flow after first login of a newly-approved member.

## Non-Functional Requirements

### NFR-1 — Offline-first & Write Queue Integrity

Every write still flows through `saveDoc(collection, doc)` then `enqueueWrite(cooperativeId, collection, docId, op, payload|null)`. No new direct writes to IndexedDB/SQLite.

### NFR-2 — Mobile Responsiveness

- Register form: all fields become full-width under ~720px; file input + preview stacks above instead of inline; buttons full-width or well-spaced; validation text wraps; no horizontal scroll.
- Join form: same responsive rules as Register; cooperative select never clips long names (wrap + ellipsis inside); the success card is readable on small screens.
- Member summary: grid under ~720px collapses to a single stacked column; logo+name stack vertically; contact lines wrap rather than truncate with ellipsis unless absolutely necessary.

### NFR-3 — No Parallel Logic

There must remain exactly **one** authoritative implementation for:
- Cooperative creation: `registerCooperative()` in `services/data/registration.js`.
- Join-request submission: `submitMembershipRequest()` in `services/data/membershipRequests.js`.
- Join-request approval/decline: existing functions in `membershipRequests.js`.

The UI screens call these existing functions — no duplicated logic.

### NFR-4 — No Invented Fields

All summary values rendered on the dashboard must come from fields that already exist on `cooperatives` and `members` rows. No new Firestore fields, no new SQLite columns, no new transient object properties.

### NFR-5 — Style Consistency

Register + Join + Choice screen + My Cooperative summary all use:

- Existing CSS custom properties (var(--bg-card), var(--radius-lg), var(--accent-primary), var(--danger), var(--success), var(--text-muted), etc.).
- Existing `.primary-button`, `.secondary-button`, `.ghost-button`, `.field`, `.alert`, `.card` classes where applicable (override in per-component `SYS_CSS`-like `<style>` blocks if needed — but do **not** add new global `.card` `max-width` rules that could collide with reconciliation/dashboard layouts).

## Constraints, Dependencies, Assumptions

- **Constraint**: No schema changes to existing tables. `membership_request`, `cooperatives`, `members`, `users` stay exactly as currently defined in `constants.js`.
- **Constraint**: The activation key format YYDDMM lives inside `Registration.js` and must not be moved to a shared location or modified.
- **Constraint**: Default post-approval password is `'123456'` with `force_password_change: true`; must not change.
- **Dependency**: Photo upload depends on `compressImage()` from `utils/imageUtils.js` (already available).
- **Dependency**: Local write model depends on `saveDoc` / `enqueueWrite` from `services/sqliteService.js`.
- **Assumption**: When listing cooperatives on the Join form, offline users cannot browse coops — this is an acceptable tradeoff because the user is pre-login and the local DB has no cooperative rows yet.
- **Assumption**: The "My Cooperative" summary for members always has a valid `cooperativeId` and non-null `memberId` in `state.welcomeUser` when AccountBalance runs (the login/session layer guarantees this).

## Open Questions

None at spec time — investigation resolved all ambiguity by reading the existing service layers and table schemas directly.

---

## Acceptance Criteria

All ACs are typed `rule` or `rubric`.

### Register Cooperative

| ID | Type | Criterion |
|----|------|-----------|
| AC-R1 | rule | `Registration.js` loads with no module-error; `registerCooperative` is the exact function from `services/data/registration.js` re-exported via the barrel. |
| AC-R2 | rule | Form shows 4 clearly-separated sections; required fields are marked `*`; optional fields are labeled `(optional)`; input types are correct (tel/email/date/file). |
| AC-R3 | rule | Clicking "Register Cooperative" without required field values shows inline human-readable validation messages and does **not** proceed to activation-key prompt. |
| AC-R4 | rule | Filling valid data + Submit → shows activation-key section with all form fields locked (disabled). Wrong key → inline red error. Correct YYDDMM key → calls `registerCooperative()` exactly once. |
| AC-R5 | rule | During `registerCooperative()` the "Verify & Create" button is disabled and shows "Creating…". Success → shows green success block with admin password visibly displayed + redirects to login after ~2.5s + clears draft. Failure → shows inline error, re-enables button, preserves entered data. |
| AC-R6 | rule | Rapid double-click of "Verify & Create" never produces 2 cooperative rows. |
| AC-R7 | rule | Mobile view (<720px): form fields stack full-width; no horizontal scroll; validation messages wrap; buttons are tappable (≥44px target area). |

### Join Cooperative

| ID | Type | Criterion |
|----|------|-----------|
| AC-J1 | rule | `JoinCooperative.js` loads; cooperatives list populates from Firestore `cooperatives` (excluding `is_deleted=1` / `is_extracted`); select shows full names as labels, IDs as values. |
| AC-J2 | rule | Offline / timeout on list load → red alert + "Retry" button appears; Submit button stays disabled until list loads with a selection. |
| AC-J3 | rule | Form shows 3 sections; required fields (Cooperative, Last, First, Mobile) marked `*`; optional fields explicitly labeled; info box with default-password convention visible. |
| AC-J4 | rule | Valid submit → button shows "Submitting…" disabled → `submitMembershipRequest()` called exactly once → success card shows the selected cooperative full name and a "Back to Login" button. No auto-redirect. Draft is cleared. |
| AC-J5 | rule | Submit failure → inline alert with message, button re-enabled, field values retained. |
| AC-J6 | rule | Rapid double-click of Submit never produces 2 membership_request rows. |
| AC-J7 | rule | Mobile view (<720px): fields stack full-width; cooperative select wraps long names correctly; photo+preview stacks; no horizontal scroll; success card fits the viewport. |

### Choice Screen & Cross-Page Consistency

| ID | Type | Criterion |
|----|------|-----------|
| AC-C1 | rule | Landing "Register" CTA and Login "Register" button both open the Create-vs-Join choice screen correctly. |
| AC-C2 | rule | From inside Register → Back returns to choice screen; from inside Join → Back returns to choice screen; "Back to Login" works from all three screens. |
| AC-C3 | rubric | Register, Join, and Choice screens share a consistent visual feel (typography scale, card radius, spacing, button hierarchy). Score 0–2. Pass threshold ≥ 1.5. |

### My Cooperative Summary (Member Dashboard)

| ID | Type | Criterion |
|----|------|-----------|
| AC-M1 | rule | When role = member, AccountBalance renders a summary block BEFORE the Net Portfolio hero card. |
| AC-M2 | rule | Summary renders, from **existing** rows only: coop `full_name`, `short_name`, `logo_path`/initials, `contact_number`, `email`, `address`; member `registration_no`, `date_joined` formatted, `status` pill, normalized `mobile`. |
| AC-M3 | rule | Missing fields (e.g. no logo, no address) degrade gracefully to the same placeholder/fallback pattern as the sidebar coop logo — no blank boxes with broken `<img>` alt-artefacts visible. |
| AC-M4 | rule | Desktop: compact layout (logo + name on the left, contact + membership details on right, or a 2–3 column grid). Mobile (<720px): stacks cleanly to one column, all lines wrap, no horizontal overflow. |
| AC-M5 | rubric | Summary is visually integrated with the dashboard's fintech style (same cards, radius, spacing, colour palette). Score 0–2. Pass threshold ≥ 1.5. |
| AC-M6 | rule | No regression: authenticated admin users do **not** see the member summary block on their dashboard (admin-dashboard layout with Savings/Loans/Cash/Revenue cards is unchanged). |

### Build & No-Regression

| ID | Type | Criterion |
|----|------|-----------|
| AC-B1 | rule | App boots; no module-resolution errors for `dataService.js` anywhere; Dashboard, Members, Reports, Reconciliation, Settings tabs all open without runtime errors. |
| AC-B2 | rule | Existing members-page join-request Approve/Decline flow works unchanged; Approve still calls `addMember()` with password_hash for 123456 and stamps the request with `Approved` + `member_id`. |
| AC-B3 | rule | All writes produced by Register + Join still flow through `saveDoc` + `enqueueWrite`; SQLite rows land with `is_synced=0`; `sync_queue` entries are created for both operations. |

### Manual Verification Scripter's Checklist (evidence for Review)

These are the same scenarios the user enumerated in section 13 of the brief — all must be demonstrated via screenshots + manual steps during review:

1. Register: page loads, fields render, validation blocks bad submit, valid submit + correct key → success + password → redirects to login.
2. Register: double-click does **not** double-create.
3. Register: loading + error + success states all display correctly.
4. Register mobile layout pass.
5. Join: page loads; coops list loads correctly; offline retry works.
6. Join: valid submit → success card; double-click never duplicates; error state surfaces properly; mobile layout pass.
7. My Cooperative: Dashboard loads for a member user; summary block appears above financial cards with all values populated; member-level recent-activity + balances sections below remain functional; admin Dashboard layout unchanged.
