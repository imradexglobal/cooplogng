# Auto Share Requirements Specification

**Status:** Draft for confirmation before implementation  
**Source:** Prompt sheet in `TMSA_E-COOP.xlsm` plus current cooplogng behavior  
**Application changes:** None

## 1. Purpose

Auto Share distributes a member remittance amount into enterprise-account detail lines using configured enterprise rules. The result must be transparent, deterministic, auditable, and compatible with the existing Remittance lifecycle.

Auto Share is distinct from payment advice. Payment advice may inform the amount expected for an enterprise; Auto Share creates the proposed distribution of a specific remittance amount.

## 2. Functional requirements

### FR-01: Enterprise source

The feature shall use active enterprise accounts belonging to the current cooperative. Deleted accounts shall not receive new allocations.

### FR-02: Priority order

The feature shall order eligible enterprise accounts by ascending `distribution_priority`. Ties shall use a stable secondary key, preferably enterprise ID, so that identical input always produces identical output.

### FR-03: Compulsory due support

The feature shall recognize accounts with `compulsory_due = 1` and use their `compulsory_amount` when calculating required allocation.

The treatment of insufficient funds must be configured as one of:

- reject the preview;
- partially allocate in priority order;
- allocate compulsory accounts first, then stop;
- allow a warning and user override.

The default implementation should not guess silently; it should expose the selected policy in the preview and audit text.

### FR-04: Eligible balance/advice

The allocation policy shall state whether each enterprise’s requested amount is derived from:

- payment advice;
- outstanding negative balance;
- a configured fixed amount;
- a percentage of the remittance;
- compulsory amount;
- or a combination of these.

The implementation must not infer a new rule from the legacy 25-column workbook layout without an approved business decision.

### FR-05: No over-allocation

The total of all detail allocations shall never exceed the parent remittance amount, subject to the configured rounding scale.

### FR-06: Remainder

If the entire remittance cannot be allocated, the result shall retain an explicit remainder. The UI shall show the remainder and the reason why it was not distributed.

### FR-07: Detail persistence

When the user confirms an Auto Share preview, the application shall save one detail row per non-zero allocation with:

- `enterprise_id`;
- `amount`;
- `auto_description` containing the policy/version and reason;
- normal creation/modification metadata.

Zero-value details should be omitted unless reporting requires them.

### FR-08: Parent lifecycle

Auto Share shall create or update the normal parent remittance record. It shall not bypass the current Pending/Approved/Declined status lifecycle.

### FR-09: Approval compatibility

Auto Share must remain compatible with `approveRemittance()` and with existing reconciliation/sealed-period guards. It must not mutate a sealed record’s bank, date, amount, or status.

### FR-10: Edit behavior

When an existing unsealed remittance is edited and Auto Share is rerun, the previous Auto Share details shall be replaced atomically rather than appended as duplicates.

For a sealed remittance, the existing rules remain in force: bank, date, amount, and status are frozen, while distribution details may be editable according to current application behavior.

### FR-11: Auditability

Every automatically generated allocation shall identify:

- the policy name/version;
- calculation date/time;
- priority used;
- source amount or balance used;
- any warning or shortfall.

### FR-12: Preview

The UI shall provide a preview before saving, including enterprise name, priority, requested amount, allocated amount, cumulative total, and remainder.

### FR-13: Idempotence

Running Auto Share twice with the same input snapshot and policy shall produce the same allocation result. Saving the same preview twice shall not create duplicate details.

### FR-14: Permissions

Auto Share shall use the current Remittance screen permissions. It shall not expose member records or enterprise accounts outside the user’s cooperative/member scope.

## 3. Non-functional requirements

- Use decimal-safe arithmetic or integer minor units for currency calculations.
- Keep the allocation engine free of DOM, database, and global session dependencies.
- Return structured warnings rather than relying only on toast messages.
- Preserve existing data-service APIs unless an additive API is necessary.
- Add unit tests for the allocation engine before UI integration.
- Add integration tests for saving, reloading, editing, approval, and balance calculation.

## 4. Proposed policy contract

```js
const policy = {
  id: 'priority-compulsory-v1',
  currencyScale: 2,
  compulsoryMode: 'priority-first',
  shortfallMode: 'partial-with-warning',
  sourceMode: 'advice-then-outstanding-balance',
  remainderMode: 'retain-on-parent',
};
```

This is a proposal, not an approved business rule. The exact `sourceMode`, `shortfallMode`, and `compulsoryMode` require confirmation.

## 5. Acceptance criteria

### AC-01: Basic priority allocation

Given three active enterprise accounts with priorities 1, 2, and 3, and a remittance amount sufficient for the first two requirements, Auto Share allocates to priority 1 first, then priority 2, and leaves priority 3 unallocated.

### AC-02: Priority tie

Given two accounts with the same priority, allocation order is stable across repeated runs and follows the documented tie-breaker.

### AC-03: Compulsory due

Given a compulsory account with a configured compulsory amount, the preview visibly reserves or allocates that amount according to the selected compulsory policy.

### AC-04: Insufficient funds

Given a remittance amount below the total compulsory requirement, the result follows the selected shortfall policy and emits a warning or rejection; it never silently over-allocates.

### AC-05: Exact balance

Given an allocation whose total equals the remittance amount, the remainder is exactly zero after currency rounding.

### AC-06: Unallocated remainder

Given a remittance amount greater than all eligible requested allocations, the result retains and displays the remainder.

### AC-07: Persistence

After confirming a preview, reloading the Remittance record returns the same enterprise detail allocations and audit descriptions.

### AC-08: Update without duplication

Editing and rerunning Auto Share changes the existing details and does not append duplicate Auto Share detail lines.

### AC-09: Approval lifecycle

A saved Auto Share remittance remains Pending until the normal approval action. Once approved, `buildAccountBalance()` reflects its detail amounts by enterprise.

### AC-10: Sealed-period protection

An Auto Share edit cannot change a sealed remittance’s frozen bank, date, amount, or status and surfaces the existing guard error.

### AC-11: Legacy advice distinction

Payment advice records are not accidentally rewritten or treated as approved remittance details merely because Auto Share is run.

### AC-12: Regression

Existing manual remittance entry, loan-derived details, withdrawal flows, reports, and enterprise settings continue to work unchanged.

## 6. Open decisions required from product owner

1. What is the exact source of requested allocation per enterprise?
2. Are compulsory dues always first, or only ordered by priority?
3. What is the insufficient-funds policy?
4. Should remainder stay as an unallocated parent amount or be assigned to a designated suspense/cooperative account?
5. Should Auto Share be available for withdrawals and loans?
6. Is preview-and-confirm mandatory?
7. Should approval create any additional automatic records?
8. Should historical Auto Share records retain the priority snapshot used at creation?
