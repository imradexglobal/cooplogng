# CoopLogNG — Member Self-Registration Feature Implementation Prompt

## Context — Read First

You are working on **CoopLogNG**, an offline-first cooperative savings/loans/remittance web app built with:
- **Vite + Vanilla JavaScript (ESM)** — no React/Vue; screens render via `container.innerHTML` + event binding.
- **SQLite in the browser** (sql.js) + Firestore cloud sync. All tables carry standard columns: `id`, `cooperative_id`, `created_at`, `created_by`, `modified_at`, `modified_by`, `is_deleted` (0/1), `is_synced` (0/1), `sync_at`, and optional `deleted_at`.
- **Offline-first identity-queue write model**: EVERY write goes through **`saveDoc(collection, doc)`** (writes IndexedDB/SQLite + sets `is_synced=0`) followed by **`enqueueWrite(cooperativeId, collection, docId, operation, payload=null)`** (adds a deduped entry in `sync_queue`). `operation` ∈ `'set' | 'update' | 'delete'`. **Never bypass `saveDoc`/`enqueueWrite`** to mutate collections. Never introduce a new "bulk queue" API.
- All data-service exports are re-exported through **`src/services/data/index.js`** (the barrel). Any new service function you create must be added there.
- UI screens follow a `let localState = {...}; function render() { container.innerHTML = ... }; function bindEvents() {...}` pattern (see `src/screens/Reconciliation.js` for the canonical state-driven example).
- Soft-delete convention: to "delete" a row you set `is_deleted = 1`, update `modified_at/by`, clear `is_synced`, and call `enqueueWrite(..., 'delete', ...)`. The sync engine reads `is_deleted=1` and pushes the tombstone to Firestore.
- Helper imports: `generateId`, `hashPassword` (returns a string hash), `escapeHtml` / `escapeAttribute` from `src/utils/formatters.js`. `normalizePhone` from `src/utils/normalize.js`. Image compression for photos uses `compressImage(file)` from `src/utils/imageUtils.js`.

---

## Feature Goal — Member Self-Registration

Add a **Member Self-Registration** flow so that new users can either:
1. **Create a new cooperative** (existing flow, but moved — see section 2 below), OR
2. **Join an existing cooperative** (new flow — minimal data collected, no activation key, request goes into a new `membership_request` collection for admin approval).

Also — on the Members Page inside the app — add a **Join Requests summary card** that shows pending count, opens a list, and lets admins **Approve** (creates a real member row with default password `123456`) or **Decline** (soft-delete the request row, same pattern as `deleteRemittance`).

Finally, restructure the **pre-login entry** so that clicking "Register" no longer immediately asks for an activation key. Instead it first shows a **choice screen**: "Create Cooperative" vs "Join Cooperative". Activation key moves INSIDE the Create Cooperative flow after the user fills the coop form (on submit → key prompt → correct key → create).

---

## Existing Files & Locations to Reference / Modify

| File | Purpose |
|------|---------|
| `src/screens/Landing.js` | Marketing page. Has **two** `data-lp="register"` buttons and **two** "Register New Cooperative" labels. **Change all labels** to just **"Register"**. |
| `src/screens/Login/loginService.js` | Login HTML renderer. Stage-1 form has a button at the bottom: `<button data-action="show-registration">Register New Cooperative</button>`. **Change the visible label to "Register"**. The handler lives in `src/main.js`. |
| `src/main.js` | **Central routing + state**. Contains: (a) initial state block with `showActivationKeyPrompt`, `activationKeyInput`, `activationKeyError`, `isRegistering`; (b) handler for `action === 'show-registration'` that sets `showActivationKeyPrompt = true`; (c) handler for `action === 'activation-key-submit'` logic that validates the YYDDMM key then sets `isRegistering = true`; (d) the `render()` function branch that paints the Activation Key card (around line 1719–1779) then the `state.isRegistering` branch that calls `renderRegistration(...)`. **You will add a NEW state branch `state.registerChoice` = `null | 'create' | 'join'` + a "Choice Screen" between "Register" click and the activation-key / coop-form / join-form.** |
| `src/screens/Registration.js` | Renders the **Create Cooperative** form. Currently collects: `full_name, short_name, contact_number, email, logo, address, first_month` + hardcoded `admin` user (random 4-digit pwd generated inside `registerCooperative` service). **Wrap the submit handler** so that pressing "Register Cooperative" first prompts for the activation key (YYDDMM format — same logic as current main.js activation key check), and only on **correct key** call the existing `registerCooperative(coopData)`. Keep the current draft-key persistence mechanism (`cooplog-reg-draft` sessionStorage). Keep the "Clear Form" button. Keep the 4-digit admin password result display + 2.5s redirect to login after success. |
| `src/services/data/registration.js` | Current `registerCooperative(coopData)` that calls `saveDoc('cooperatives', coop) + enqueueWrite + saveDoc('users', admin) + enqueueWrite`. **Do NOT change its signature.** You will create a NEW service file (or add to this one) for the join-request flow. |
| `src/services/data/members.js` | Current `addMember(data, createdBy)` — builds full member doc with auto-increment `registration_no`, `mobile` normalize, `special_id` normalize, 4-digit random password hash, `force_password_change: true`, etc. **When approving a join-request you will call this same `addMember` (then mark the request `status='Approved'`)** — so the approved member gets a proper auto registration_no, duplicate mobile guard, etc. |
| `src/services/sqlite/constants.js` | Lists `TABLES` array and `TABLE_COLUMNS` for every collection in SQLite. **You MUST add `'membership_request'` to both.** The columns are detailed in Section 4 below. |
| `src/services/sqlite/syncQueue.js` | Already exports `enqueueWrite` — used as-is. |
| `src/screens/members/membersStats.js` | Renders the 4 summary cards (Total, Active, Issues, New) in the Members page. **Add a 5th card "Join Requests"** showing pending count with a badge-style accent color; clicking it dispatches a window event (same pattern as existing stat cards). |
| `src/screens/members/membersPage.js` | Top-level Members page render. Imports/uses `membersStats`. You need to **pass the count of pending membership requests into `renderMembersStats`** (add it as a second argument — e.g. `renderMembersStats(getFilteredMembers(), pendingJoinCount)`). Also wire a handler for the new stat-click event so it opens the join-request list view (see Section 5). |
| `src/services/data/remittances.js` | Reference the `deleteRemittance(id, modifiedBy)` function (lines ~296–308) for the **Decline join-request pattern** (soft-delete `is_deleted=1` + modify stamps + `is_synced=0` + `enqueueWrite(..., 'delete', ...)`). |
| `src/services/authService.js` | Reference `searchAllCooperatives(searchTerm)` (lines ~258–274) which queries Firestore `cooperatives` collection and returns `[{id, name}]`. **Use this (or its equivalent) to populate the cooperative dropdown in the Join-Existing-Cooperative form.** Also reference `discoverCooperativesByMobile` — but note: join form needs a list of ALL coops visible for selection, not per-user. |
| `src/services/data/index.js` | Barrel exports. Add exports for every new data function you create (submitMembershipRequest, listPendingMembershipRequests, approveMembershipRequest, declineMembershipRequest, countPendingMembershipRequests, etc.). |
| `src/components/memberAvatarUpload.js` | Reference for photo upload + compress pattern — reuse the `compressImage(file)` utility + preview thumbnail pattern inside the Join form. |
| `src/services/dataService.js` | Exists; you may import from the specific service modules directly in screens rather than going through dataService (newer code already uses direct service imports). |

---

## Architectural Hard Constraints — DO NOT VIOLATE THESE

1. **NO new columns on existing tables** (`members`, `users`, `cooperatives`, …). The new membership_request data MUST live in its own `membership_request` collection only.
2. **NO bypassing `saveDoc` + `enqueueWrite`**. For every write to `membership_request`: `saveDoc('membership_request', doc)` → `enqueueWrite(targetCooperativeId, 'membership_request', doc.id, 'set' | 'update' | 'delete', null)`. For every write to `members` on approval: already handled inside `addMember` + `updateMember` in members.js (check — if not, ensure the pattern is `saveDoc('members', ...)` → `enqueueWrite(coopId, 'members', memberId, 'set', null)`).
3. **FK-based, not date-based.** There is no date-range interaction here; just follow the soft-delete + FK conventions already established.
4. **`membership_request` rows belong to their target cooperative** — their `cooperative_id` = the coop the user wants to join. This is so the sync engine, which is scoped per cooperative, pushes each request to the correct Firestore path under `cooperatives/{coopId}/membership_request/{id}`. Enforce this on the enqueueWrite call (first arg = target coop id).
5. **No Activation Key for Join Existing Cooperative.** Only Create Cooperative needs the YYDDMM activation key — and ONLY after the full form is submitted, not before.
6. **Default password = `'123456'`** on approved join. Pass `{ password_hash: hashPassword('123456') }` to `addMember` (or override the 4-digit random inside addMember via a parameter — but simplest is to build the hash in the approve handler and pass it as `data.password_hash` to `addMember` — confirm addMember honors incoming `password_hash`. Check `src/services/data/members.js` line 134: `const pwd = data.password_hash || generateRandom4Digit()` — yes, it already honors an incoming hash. So pass `password_hash: await hashPassword('123456')` plus `force_password_change: true` (already the default inside addMember).
7. **Decline = soft delete, not destroy.** Follow the `deleteRemittance` pattern exactly: `is_deleted = 1`, `modified_at/by` updated, `is_synced = 0`, then `enqueueWrite(coopId, 'membership_request', requestId, 'delete', null)`.
8. **Admin-only approval/decline.** Use `hasPermission(user.permissions, 'admin')` from `src/services/permissionService.js` OR `user.username?.toLowerCase() === 'admin'` — same pattern as `membersPage.js` line 7.
9. **Single render() + bindEvents() pattern for any new screen/UI section.** Do NOT scatter addEventListener calls that append to innerHTML outside a single bindEvents step per render cycle — this causes duplicate listeners. Mirror the pattern in `src/screens/Reconciliation.js` (a single `render()` writes innerHTML, then a single `bindEvents()` wires everything after).
10. **Firestore is the source of truth for cooperatives listing on the Join form.** The user is not logged in → no local SQLite co-op list available. So the cooperative dropdown MUST fetch from Firestore via the Firebase SDK (import from `src/firebase.js`). Network required for this specific screen — if offline, show a friendly "Internet connection required to browse cooperatives. Please connect and try again." message + disable the submit.

---

## Detailed Requirements by Section

---

### SECTION 1 — Pre-Login: Landing + Login "Register" Label Changes

Goal: Every visible instance of the label "Register New Cooperative" (pre-login) becomes "Register".

**Files + changes:**

- **`src/screens/Landing.js`**
  - Line 249 (hero CTA), line 381 (final CTA): `<button data-lp="register">Register New Cooperative</button>` → change text to `Register`.
  - Line 262 (inside the fake-phone demo graphic): the `<div style="...Register New Cooperative">` string → change to `Register`.
  - Line 93 (FAQ answer for "How do we get started?"): `'Tap "Register New Cooperative" below,...'` → `'Tap "Register" below,...'`.
  - Line 69 (STEPS array, step 1): `'Register your cooperative'` — leave this as-is (it's instructional copy, not a button).

- **`src/screens/Login/loginService.js`**
  - Around line 215-217: `<button data-action="show-registration">Register New Cooperative</button>` → change label to `Register`.

---

### SECTION 2 — Pre-Login: Register Choice Screen (Create vs Join)

Goal: Clicking "Register" (from Landing or Login) shows a choice screen with two big cards:
- **A) Create Cooperative** — when clicked → opens the existing Create-Cooperative form (Registration.js), with activation key moved INSIDE that form (see Section 3).
- **B) Join Cooperative** — when clicked → opens the new minimal Join Existing Cooperative form (Section 4).

**Implementation:**

In **`src/main.js`**:

1. **Add to initial state object** (near line 207, alongside showActivationKeyPrompt):
   ```js
   registerChoice: null,   // null | 'create' | 'join'
   isJoining: false,       // true = the Join Existing Cooperative screen is rendered
   ```

2. **Change the `show-registration` handler** (action === 'show-registration', around line 1161):
   ```js
   if (action === 'show-registration') {
     state.registerChoice = null;          // clear previous
     state.isRegistering = false;
     state.isJoining = false;
     state.showActivationKeyPrompt = false;
     render();
     return;
   }
   ```
   Also update the **Landing onRegister callback** (around line 1819) to do the same — open the choice screen, not the activation key prompt.

3. **In the `render()` function** (inside the app-render section, before the activation-key branch), insert a NEW **choice screen branch**:
   ```
   if (!state.isRegistering && !state.isJoining && !state.showActivationKeyPrompt && state.registerChoice !== undefined && <we came from a 'show-registration' path> )
   ```
   — simpler: just check **if the user is NOT logged in, NOT registering, NOT joining, NOT showing activation key, and we are past boot → and the "last action was Register"**. Cleanest approach:
   - Add a separate state boolean `state.showRegisterChoice = false`.
   - "show-registration" action sets `state.showRegisterChoice = true; state.isRegistering=false; state.isJoining=false; state.showActivationKeyPrompt=false;`.
   - "go-login" and "go-landing" actions clear `state.showRegisterChoice`.
   - In render(): **First branch** (before activation key, before isRegistering): `if (state.showRegisterChoice)` → render the Choice Screen card.

4. **Choice Screen HTML**: render the same `.shell` / `.card` layout as the Activation Key screen. Title "Register". Sub-text "Choose the option that best describes you." Two equal-width cards (grid) side-by-side (on desktop; stacked on mobile via CSS @media max-width 720px grid-template-columns 1fr).
   - Card A: 🏢 **Create Cooperative** — subtitle "Start a brand new cooperative and become the first admin." CTA button class="primary-button" data-action="choice-create" → on click: `state.showRegisterChoice = false; state.isRegistering = true; render();`
   - Card B: 🤝 **Join Cooperative** — subtitle "Apply to an existing cooperative as a new member. Approval is required." CTA button class="secondary-button" data-action="choice-join" → on click: `state.showRegisterChoice = false; state.isJoining = true; render();`
   - Also a "Back to Login" secondary button at the bottom (data-action="go-login").

5. **Existing actions cleanup**:
   - Action `activation-key-back` currently returns to login — change it so it sets `state.showRegisterChoice = true` instead (goes back to the Choice Screen).
   - Action `go-landing` clears showRegisterChoice, isRegistering, isJoining, showActivationKeyPrompt.

---

### SECTION 3 — Create Cooperative: Move Activation Key Inside Registration.js Submit

Goal: The flow becomes: **Choice Screen → Create Cooperative → Fill Coop form → Press Submit → Prompt for activation key (inside Registration submit handler) → Correct key → call registerCooperative → show success with password → redirect to login.**

The current flow is: **Choice Screen (old: skip) → Activation Key → Fill Coop form → Submit → create.** You will flip this.

**Files + changes:**

- **`src/main.js`** — the `showActivationKeyPrompt` screen and `activation-key-submit` logic is now **UNUSED** for the Create flow (delete or leave dead code — cleaner to remove the activation-key-prompt SCREEN branch and its action handlers, since the key check now lives inside Registration.js submit). If you remove, also clear the 3 state fields `showActivationKeyPrompt`, `activationKeyInput`, `activationKeyError` from initial state and from the `show-registration` handler.

- **`src/screens/Registration.js`** — refactor the form submit handler:
  1. Keep all existing form validation, FormData gathering, draft-save, logo-compress, etc. Exactly as-is.
  2. On submit → BEFORE calling `registerCooperative(coopData)` → **show an inline activation-key section** inside the card (swap the submit actions area, or use a simple confirm-style modal via window.prompt? No — use the same styling as the previous activation-key card **inline inside the form**).
     - Prefered approach: add a local state flag `let awaitingActivationKey = false;` at the top of `renderRegistration`. Collect the form data into a closure variable on first submit click, set `awaitingActivationKey = true`, `re-render` the container HTML with the same form data **locked (disabled)** at the top and an activation-key input box below with "Verify & Create" button + "Cancel" (which goes back to edit mode).
     - Or simpler (and acceptable since this is a rare admin-only flow): use a custom prompt card. But for consistency with the app's look and UX, **do NOT use `window.prompt()`**. Use the inline re-render pattern.
  3. When the user enters the activation key and presses "Verify & Create":
     - Validate key using **identical YYDDMM logic as main.js**: `today = new Date(); yy = String(today.getFullYear()).slice(-2); dd = String(today.getDate()).padStart(2,'0'); mm = String(today.getMonth()+1).padStart(2,'0'); expected = yy+dd+mm;`
     - If wrong: show inline error in red `Invalid activation key. Please try again.`, stay on screen, allow retry.
     - If correct: proceed with the existing `registerCooperative(coopData)` call (the try block starting at line 170). Show password, 2.5s redirect to login — all unchanged.

---

### SECTION 4 — Join Existing Cooperative Form (NEW)

Goal: A minimal pre-login form. Collects only basic member info. User selects their target cooperative from a Firebase-sourced dropdown. On submit (no activation key), saves a row to the **NEW `membership_request` table** with `status = 'Pending'`. Shows success screen: "Request submitted. The cooperative admin will review your application. You will receive a notification if approved."

**4a. Schema — add to `src/services/sqlite/constants.js`:**

- Push into `TABLES` array: `'membership_request'`
- Add to `TABLE_COLUMNS` object:
  ```js
  membership_request: [
    'id',
    'cooperative_id',        // the coop they want to join (target)
    'last_name',
    'first_name',
    'middle_name',
    'mobile',                // required — phone
    'address',               // physical address (textarea, optional)
    'image_path',            // passport photo as base64 dataURL (optional but encouraged)
    'status',                // 'Pending' | 'Approved' | 'Declined'
    'reviewed_by',           // user id of admin who approved/declined, or null
    'reviewed_at',           // ISO date of decision, or null
    'member_id',             // filled on Approval = the newly created member.id, or null
    'decline_reason',        // optional text note on decline
    'created_at',
    'created_by',            // for pre-login rows: 'self' or mobile number? use 'self-register'
    'modified_at',
    'modified_by',
    'is_deleted',            // 0/1 — set to 1 on Decline (soft-delete via decline handler)
    'is_synced',             // 0/1
    'sync_at'
  ]
  ```

**4b. Data service functions — create new file `src/services/data/membershipRequests.js` and export the following from it:**

```js
/**
 * Submit a self-registration join request.
 * @param {Object} req — must have cooperative_id, last_name, first_name, mobile, etc.
 * @returns {Promise<string>} the new request id
 */
export async function submitMembershipRequest(req) { ... }
// Body: generateId() + now + status='Pending' + reviewed_by/at/member_id = null +
//       is_deleted=0 + is_synced=0 + created_by='self-register' + saveDoc + enqueueWrite(req.cooperative_id, 'membership_request', id, 'set', null)
```

```js
/**
 * For the Members Page admin: list Pending (or all by filter) membership_requests
 * for THIS cooperative only.
 * @param {string} cooperativeId
 * @param {'Pending'|'All'} [filter='Pending']
 * @returns {Promise<Array>}
 */
export async function listMembershipRequests(cooperativeId, filter = 'Pending') {
  // Use getAllForCoop(cooperativeId, 'membership_request') then filter by is_deleted=0 + (if filter==='Pending' then status==='Pending').
  // Sort by created_at DESC.
}
```

```js
/**
 * Count only Pending requests for the stat card.
 * @param {string} cooperativeId
 * @returns {Promise<number>}
 */
export async function countPendingMembershipRequests(cooperativeId) { ... }
```

```js
/**
 * Approve a request:
 *   1. Load request → validate status === 'Pending' (else throw).
 *   2. Build a memberData object and call addMember(memberData, reviewed_by).
 *   3. Update the request row: status='Approved', reviewed_by/at, member_id=returnedMember.id, is_synced=0, stamps.
 *   4. enqueueWrite(coopId, 'membership_request', reqId, 'update', null).
 *   (addMember already does saveDoc + enqueueWrite for the member row.)
 * @param {string} requestId
 * @param {string} reviewedByUserId — admin who clicks Approve (use welcomeUser.id or username? consistent with app — welcomeUser.userDoc.id when available, else username)
 * @returns {Promise<{memberId: string, generatedPassword: string}>}
 *
 * NOTE on default password: pass memberData.password_hash = await hashPassword('123456').
 * addMember already honors data.password_hash fallback (members.js line 134).
 * So the approved member's default password is 123456 with force_password_change=true.
 * Also in memberData pass: last_name, first_name, middle_name, mobile (via normalizePhone), address, image_path (if any), date_joined = today ISO, status = 'Active'.
 */
export async function approveMembershipRequest(requestId, reviewedByUserId) { ... }
```

```js
/**
 * Decline a request — follow deleteRemittance pattern exactly.
 *   1. Load existing, verify status='Pending' (else throw).
 *   2. Set is_deleted = 1, modified_at/by, is_synced = 0, status='Declined' (informational), reviewed_by/at, decline_reason if provided.
 *   3. saveDoc('membership_request', {...})
 *   4. enqueueWrite(coopId, 'membership_request', requestId, 'delete', null)
 *      — enqueueWrite already auto-normalizes op to 'delete' when payload.is_deleted === 1.
 */
export async function declineMembershipRequest(requestId, reviewedByUserId, reason = '') { ... }
```

**4c. Barrel exports — add to `src/services/data/index.js`:**
```js
export {
  submitMembershipRequest,
  listMembershipRequests,
  countPendingMembershipRequests,
  approveMembershipRequest,
  declineMembershipRequest,
} from './membershipRequests.js'
```

**4d. Join-Form Screen (`isJoining` branch in `src/main.js` render()):**

When `state.isJoining === true`, render a **new screen function** (create `src/screens/JoinCooperative.js`). Import it from main.js similarly to renderRegistration. Follow the single-render + bindEvents pattern.

**Form fields (order matters):**
1. 🤝 Title "Join Cooperative" — subtitle "Fill in the form below to request membership. We'll let your chosen cooperative know right away."
2. **Cooperative** — `<select>` (required). Populate options by calling `searchAllCooperatives('')` from authService on mount. Use `await import('../firebase.js')` and replicate the pattern of `searchAllCooperatives`:
   ```js
   // In the data-loading function inside the screen:
   const { getDb, collection, getDocs } = await import('../firebase.js');
   const snap = await getDocs(collection(getDb(), 'cooperatives'));
   const coops = snap.docs
     .filter(d => {
       const dat = d.data();
       return (dat.is_deleted !== 1) && (dat.is_extracted !== true);
     })
     .map(d => ({
       id: d.id,
       name: d.data().full_name || d.data().short_name || d.id
     }))
     .sort((a,b) => a.name.localeCompare(b.name));
   ```
   Options: `<option value="${coop.id}">${coop.name}</option>` — **display full name (never id) to the user**.
   Loading state: show a spinner-like message "Loading cooperatives..." inside the select. Network-fail: show inline red message "Internet connection required. Please check your network and click 'Retry' button." + Retry button that re-runs the load. Offline: disable submit button, show same warning.

3. **Surname / Last Name** (required, text)
4. **First Name** (required, text)
5. **Middle Name** (optional, text — empty string allowed)
6. **Passport Photo** (optional but encouraged — same pattern as Registration.js logo upload: file input accept="image/*", preview thumbnail 80x80 circle, use `compressImage(file)` from imageUtils.js to get base64 dataURL). Label: "Passport Photo" + hint: "Optional but helps admins verify your identity."

7. **Mobile Number** (required, tel, placeholder 08012345678). `normalizePhone` before save.

8. **Residential Address** (optional, textarea, height 80px).

9. Summary/alert — small info box: ℹ️ No payment or activation key required. Your application will be reviewed by the cooperative admin. You'll be able to login with your mobile number once approved. Default password after approval: `123456` (you will be asked to change it on first login).

10. Actions row:
    - Back button (secondary-button) → data-action="join-back" → sets `state.isJoining=false; state.showRegisterChoice=true; render();` (goes back to Choice Screen)
    - Submit Request (primary-button) → on submit: validate required fields (coop selected, last_name, first_name, mobile non-empty), build request object, call `submitMembershipRequest(request)`, on success replace the form with a success card: ✅ **Request Submitted!** — "Your application to join **<coop_full_name>** has been sent. The cooperative admin will review it shortly. If approved, you can sign in with your mobile number and default password `123456`." + a "Back to Login" CTA.

---

### SECTION 5 — Members Page: Join Requests Stat Card + List View

Goal: Inside the authenticated Members Page (after login), the summary card row (Total / Active / Issues / New) gets a **5th card: "Join Requests"**. Clicking it toggles a table/list below the stats (or replaces the main table view — simpler UX: **toggle between Members Table and Join Requests Table**). Approve/Decline buttons per row, admin-only.

**Files + changes:**

- **`src/screens/members/membersStats.js`**
  - Change function signature: `export function renderMembersStats(members = [], pendingJoinCount = 0)`.
  - Add a 5th `.stat-card` inside the existing `.members-stats-grid` after the "New" card:
    - `data-stat="join-requests"`
    - Label: "Join Requests"
    - Value: `${pendingJoinCount}` — accent color `var(--warning, #d97706)`, add a badge-style dot if count > 0 (e.g. red/green circle, or CSS badge `if count > 0` then style `.stat-value::after { content: ' NEW'; font-size: 0.5em; background: var(--danger); color:#fff; padding:2px 6px; border-radius:999px; vertical-align: middle; margin-left: 6px; }`).
    - Sub-line: "Needs review" when count > 0, else "All clear".
    - Add it to `isActive()` key set: `if (key === 'join-requests') return <filter-state flag>` — introduce a new state flag in membersState.js (or use `state.secondaryView = 'members' | 'join-requests'` — see next point).
  - In `attachStatsListeners`, dispatch the existing `members-stat-filter` CustomEvent with `detail: { stat: 'join-requests' }` for this new card.

- **`src/screens/members/membersState.js`** — add a new exported state variable:
  ```js
  export let secondaryView = 'members'; // 'members' | 'join-requests'
  export function setSecondaryView(v) { secondaryView = v; }
  ```
  In the existing `members-stat-filter` event handler (inside `membersFilters.js`), on `stat === 'join-requests'` call `setSecondaryView('join-requests')` and for any other stat call `setSecondaryView('members')` — so clicking Total/Active/Issues/New returns to the members table.

- **`src/screens/members/membersPage.js`**
  - **Data load phase**: After fetching members, also call `countPendingMembershipRequests(cooperativeId)` from the new data service, and pass it as second arg to `renderMembersStats(filteredMembers, pendingCount)`.
  - **Render phase**: Replace the single `renderMembersTable(container)` call with a conditional switch based on `secondaryView`:
    - If `secondaryView === 'members'` → render members table as today.
    - If `secondaryView === 'join-requests'` → **render the join-requests list view** (Section 5a).
  - **Permission gate**: Non-admins can still SEE the count (transparency) but the Approve/Decline buttons are disabled (grayed out) and a tooltip "Only admins can approve/decline join requests" is shown on hover. Alternatively for non-admins: clicking the stat card shows an empty view with "Admin approval required. Please contact your cooperative admin to manage join requests." — either approach is acceptable but showing count+disabled action is more consistent with existing permission gating.

**5a. Join-Requests List View**

Render the same `.table-container` scroll container as the members table, with these columns:

| Column | Source |
|--------|--------|
| Request Date | `new Date(created_at).toLocaleDateString()` |
| Name | `last_name + ' ' + first_name + ' ' + (middle_name || '')`. Trim. |
| Mobile | `mobile` — clickable tel: link on mobile (optional enhancement). |
| Photo | Small 32x32 circular thumbnail from `image_path`, or grey `👤` circle placeholder. |
| Address | First 40 chars + ellipsis. |
| Status | `status` — Badge. Pending → amber pill. Approved → green pill. Declined → red pill. Sort default: Pending first. |
| **Actions** (admin-only) | Two buttons: ✅ Approve (success-variant small button) + ❌ Decline (danger-variant small button). |

**Row-level button actions:**

- **Approve click**: Confirm dialog `window.confirm('Approve this join request? A new member record will be created with default password 123456, and the applicant will be able to sign in.')`. On YES → call `approveMembershipRequest(row.id, reviewerId)` → on success showToast('Member approved and created.', 'success') → refresh counts + re-render.
- **Decline click**: Confirm dialog + optional decline-reason input (use a simple window.prompt for the reason? Or inline prompt. Prefer inline for UX, but a single prompt() call is acceptable here given rarity. Requirement: the `reason` parameter must be captured and stored on the declined row per Section 4b). On confirm → call `declineMembershipRequest(row.id, reviewerId, reason)` → showToast('Request declined.', 'warning') → refresh.

**Reviewer ID**: pass `state.welcomeUser.userDoc?.id || state.welcomeUser.username` as `reviewedByUserId`. Get the current welcomeUser from the closure (membersPage render receives `user` — use `user.userDoc?.id` or fallback username).

**Refresh pattern**: on Approve/Decline success, re-fetch the pending count + refetch `listMembershipRequests(coopId)` for the table — easiest: just call the entire page-render again (membersPage already supports a "silent refresh" path if the page scaffold exists — check line 12 of membersPage.js).

---

### SECTION 6 — Cross-Cutting: Sync, Permissions, Edge Cases

1. **SYNC** — `membership_request` needs to be listed in any hardcoded sync collection lists. Search the entire `src/` directory for the arrays `TABLES` (already done) and also for `SYNC_COLLECTIONS` in `syncState.js` and any `const COLLECTIONS` / sync whitelist arrays. Add `'membership_request'` to each so the sync engine actually pulls and pushes rows for this collection.
2. **PERMISSION** on Members Page list view:
   - All logged-in users (even regular members) can see the count (for awareness of team size / cooperative activity).
   - Only admins (`isAdmin === true` from membersPage line 7) can click Approve/Decline.
3. **Duplicate Mobile Check on Approve**:
   - Inside `approveMembershipRequest`, `addMember` already runs `findLocalDuplicate` which throws `'This mobile number is already registered to another member.'` on collision. Catch this and surface as an explicit error in a toast + do NOT mark Approved; leave the request Pending so admin can investigate (e.g. the applicant may already have a member record, or another Pending request was approved first — but since addMember uses coop-scoped duplicate guard, a second approve of the same request won't double-create because status is no longer Pending after first approve — the step-1 check `if existing.status !== 'Pending' throw` protects against double-approve).
4. **Cooperative name display everywhere**: in the join-form success card, show the cooperative's `full_name` (you stored it in local state from the select on change). Never show the ID to users.
5. **Form reset on successful submit (join form)**: clear form state after a successful submit — do NOT keep the submitted data lingering in the inputs.
6. **Join form session draft**: optional, but mirroring Registration.js's `saveDraft`/`loadDraft` for the join form improves UX (under a separate `DRAFT_KEY = 'cooplog-join-draft'`). Feel free to add.
7. **Login after approval**: the new member is created via `addMember` with `mobile` normalized, `password_hash = hash('123456')`, `force_password_change: true`. Login discovery already works by mobile number (see `discoverLoginCooperatives` in authService — it searches users+members by username/mobile/email). So the member will be able to sign in with: **Username = their mobile number** (or registration_no later), **PIN = `123456`** → force change on first login. Correct.

---

## Deliverables Checklist

- [ ] All "Register New Cooperative" pre-login labels changed to "Register" (Landing + Login screens).
- [ ] Register Choice Screen (Create vs Join) working correctly from both Landing CTA and Login CTA with Back-to-Login + Back-to-Choice nav.
- [ ] Activation key check MOVED inside Registration.js submit (after form fill). Pre-click activation key screen removed from main.js.
- [ ] Create Cooperative flow: Submit → Key Prompt → Correct Key → Create → Success with password → Login redirect.
- [ ] Join Cooperative screen (new) loads ALL cooperatives from Firebase, shows full names in select, requires online, collects last/first/middle name + mobile + address + photo preview + compress.
- [ ] NEW `membership_request` table in `TABLES` + `TABLE_COLUMNS` (constants.js), added to SYNC_COLLECTIONS whitelists.
- [ ] NEW `membershipRequests.js` service with 5 functions: submit / list / count / approve / decline.
- [ ] Join form submits to membership_request via service, no activation key, success confirmation shown.
- [ ] Members page: 5th stats card "Join Requests" with pending count, dispatches event on click.
- [ ] Members page: secondary view toggle shows join-requests table with 7 columns + Approve/Decline admin-only action buttons.
- [ ] Approve → calls addMember({password_hash: hash('123456'), ...}) → member created → request.status='Approved' → member_id stamped.
- [ ] Decline → soft-delete pattern (is_deleted=1, modified stamps, enqueueWrite 'delete', decline_reason stored).
- [ ] All writes go through saveDoc + enqueueWrite (identity-queue, no payload partials).
- [ ] Added function exports in `src/services/data/index.js`.
- [ ] No duplicated event listeners (single render() + bindEvents pattern per new screen module).
- [ ] Default password 123456 forces change on first login (already default of addMember — `force_password_change: true`).
- [ ] Mobile numbers normalized with `normalizePhone` on both join submit and approve flows.
- [ ] Images compressed with `compressImage` on passport upload (no raw file blobs stored).
- [ ] Run `node tests/reconciliation.test.mjs` to confirm existing reconciliation tests still pass (no regressions).
- [ ] Run GetDiagnostics on all modified files → 0 lint/type errors.

---

## Acceptance Scenario — Manually Verify After Implementation

1. Open app → Landing → click **Register** → choice screen shows "Create Cooperative" + "Join Cooperative" (not the activation key screen).
2. Click **Create Cooperative** → Registration.js form → fill → Submit → inline activation key appears → wrong key → error → YYDDMM correct key → coop created → password shown → redirects to login.
3. Back to Register → **Join Cooperative** → offline → warning shown + submit disabled → connect to internet → retry → coops dropdown populates with FULL coop names → fill fields, upload photo → Submit → success card.
4. Login as admin of that coop → Members page → stats row now has 5th card "Join Requests = 1" → click it → table shows request with photo, mobile → Approve → confirm dialog → toast success → new member row appears in Members list (count decrements to 0).
5. Log out → try login with new member mobile + PIN 123456 → logs in → immediately forced to change PIN.
6. Submit another join request → as admin click Decline → enter reason → request is removed from pending list, row soft-deleted (check via dev-tools: `SELECT * FROM membership_request` shows it with is_deleted=1, status='Declined').
7. Approve a request for a mobile that already exists in members → addMember's duplicate guard surfaces an error via toast, request stays Pending.
8. Non-admin member user opens Members page → sees Join Requests count (if any) → clicks → sees the list → Approve/Decline buttons disabled with tooltip/admin-only note.
