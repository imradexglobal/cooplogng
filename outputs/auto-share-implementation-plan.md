# Auto Share Implementation and Test Plan

**Status:** Planned; implementation intentionally not started  
**Application changes:** None

## Phase 1: Isolated allocation engine

### Candidate files

- `src/services/autoShare/allocator.js` — pure allocation algorithm;
- `src/services/autoShare/policy.js` — policy defaults and validation;
- `tests/autoShare/allocator.test.js` — unit tests;
- `tests/fixtures/autoShareFixtures.js` — small deterministic fixtures.

### Design rules

The allocator must not import DOM code, database services, session state, or the Remittance screen. It should accept normalized data and return a normalized result.

Recommended algorithm:

1. Normalize money to integer minor units.
2. Filter inactive/deleted enterprises.
3. Validate non-negative remittance amount and configured compulsory amounts.
4. Sort by priority and deterministic tie-breaker.
5. Compute each account’s requested amount from the approved policy.
6. Reserve/apply compulsory amounts according to the selected compulsory mode.
7. Allocate no more than the remaining available amount.
8. Return allocations, remainder, warnings, skipped accounts, and policy version.

## Phase 2: Service integration

### Candidate files

- `src/services/data/autoShare.js` — load enterprise/balance/advice inputs and build details;
- `src/services/data/index.js` — export additive Auto Share service functions;
- `src/services/data/remittances.js` — only if a transaction-safe replace/update helper is needed;
- existing SQLite schema files only if audit fields cannot fit existing `auto_description`/detail metadata.

### Required service functions

A likely additive API is:

```js
previewAutoShare({ cooperativeId, memberId, amount, remittanceDate, policyId })
confirmAutoShare({ remittanceId, preview, modifiedBy })
```

`previewAutoShare()` should return the pure allocator result plus enterprise labels. `confirmAutoShare()` should reuse the existing `addRemittance()` or `updateRemittance()` lifecycle and should not duplicate persistence logic.

If an audit snapshot is required, prefer an additive detail field or structured JSON in `auto_description` only after checking reporting compatibility. Do not change existing columns without a migration plan.

## Phase 3: Remittance UI integration

### Candidate files

- `src/screens/Remittance/remittancePage.js` — Auto Share action, preview, and form-data integration;
- `src/screens/Remittance/remittanceBulk.js` — only if the prompt requires bulk Auto Share;
- reusable modal/component file if the project’s existing UI conventions support one.

### UI behavior

- Add an explicit Auto Share action near distribution details.
- Disable it until member, amount, and required enterprise data are available.
- Show loading, preview, warnings, and errors.
- Preserve manual editing: the user may adjust the preview only if the Prompt sheet allows it.
- Mark generated details as Auto Share while preserving ordinary detail editing rules.
- Re-run the preview when member, amount, remittance date, or enterprise configuration changes.
- Do not auto-approve.

## Phase 4: Reports and balance validation

Inspect and update only where necessary:

- `src/services/data/balance.js`;
- `src/services/reports/remittanceReports.js`;
- `src/services/reports/accountingPack.js`;
- `src/screens/AccountBalance.js`;
- `src/screens/PaymentAdvice.js`.

The expected result is that approved Auto Share detail rows contribute to the same enterprise-level balance calculations as manually entered detail rows. Payment advice must remain a separate concept.

## Phase 5: Test plan

### Unit tests

1. priority ordering;
2. stable priority ties;
3. exact allocation;
4. partial allocation;
5. remainder handling;
6. compulsory-due allocation;
7. insufficient compulsory funds;
8. zero and negative input validation;
9. currency rounding;
10. idempotence;
11. deleted/inactive account filtering;
12. policy validation.

### Service tests

1. preview loads the correct cooperative enterprises;
2. member balance/advice inputs are scoped correctly;
3. confirm creates the expected parent/detail shape;
4. confirm does not create duplicates on retry;
5. update replaces prior Auto Share details;
6. existing loan/guarantor and autogen behavior is preserved;
7. sealed reconciliation guards remain active.

### UI tests

1. Auto Share button visibility and permission scope;
2. preview renders all allocation rows and warnings;
3. cancel leaves the remittance unchanged;
4. confirm updates the remittance form;
5. changing amount/member/date refreshes the preview;
6. manual remittance entry remains functional;
7. error and loading states recover correctly.

### Regression tests

Run the existing project test/build commands from `package.json`, then verify:

- enterprise settings CRUD;
- remittance add/edit/delete;
- approval and decline;
- account balance;
- payment advice;
- loan and withdrawal flows;
- reports/accounting pack;
- reconciliation/sealed-period behavior.

## Phase 6: Data migration and compatibility

No migration is currently justified. Existing `remittance_detail` already has `auto_description`, and the existing parent record has `autogen`/`parent_remittance_id` fields. Before adding columns:

1. confirm whether audit requirements can be met with existing fields;
2. inspect schema versioning and sync behavior;
3. add forward-compatible defaults;
4. test old databases and sync/import/export paths;
5. document rollback behavior.

## Phase 7: Handoff checklist

Implementation is ready for handoff only when:

- product decisions in the requirements document are resolved;
- allocator unit tests pass;
- service tests pass;
- UI preview and persistence tests pass;
- full regression/build checks pass;
- no existing workbook or production data is overwritten;
- the final change list identifies every modified file;
- a short user-facing note explains the policy and any limitations.

## Current stop point

The work intentionally stops before Phase 1 implementation because the Prompt sheet does not unambiguously specify the allocation basis and insufficient-funds behavior. Implementing those choices now would risk encoding an incorrect financial rule.
