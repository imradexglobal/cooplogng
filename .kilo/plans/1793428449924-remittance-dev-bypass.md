# Developer Bypass for Remittance Date Rules (CTRL+Click)

## Goal
Allow testers to bypass the new remittance date validation rules by holding Ctrl (or Cmd) while clicking the submit button. Production users without the modifier remain subject to all rules.

## Context
Rules live in `src/screens/Remittance/remittancePage.js` inside `handleSubmit`, guarded by `!editMode`. The submit button is `#submit-log-btn` / `#update-log-btn`. `handleSubmit` is invoked from event listeners; no event object is currently passed, so modifier state must be captured separately.

## Design
1. Add a module-scoped flag `devBypassActive = false`.
2. Attach a `click` listener to the submit button (registered where the button is created/bound) that sets `devBypassActive = e.ctrlKey || e.metaKey`.
3. In `handleSubmit`, at the start of the date-validation block, if `devBypassActive` is true, skip all three checks and show toast "Developer bypass active: date rules skipped." Then reset `devBypassActive = false`.
4. Reset the flag in a `finally`-equivalent path so a cancelled submit does not leave bypass stuck on.
5. Optional convenience: also set the flag on `keydown` when Ctrl+Enter is pressed on the form, so keyboard users can bypass.

## Gating
- Only treat the modifier as a bypass when `import.meta.env.DEV` is true OR the current user is admin (`isAdmin`/`isActualAdmin`). Otherwise ignore the flag and enforce rules. This prevents end users from bypassing in production.

## Risks
- If the button is recreated (re-render), the listener must be re-attached; ensure registration happens in the render/attach flow, not once at module load.
- Flag must be reset on every submit path, including early returns.
- Modifier detection relies on the click event reaching the button; confirm the button is not disabled during capture.

## Validation
- Manual: Ctrl+click submit with a future date -> submits; normal click -> rejected.
- Unit/integration: test bypass flag reset after submit.
- Ensure production build (`import.meta.env.DEV` false, non-admin) ignores Ctrl+click.
