# Auto Share Investigation Report

**Project:** cooplogng  
**Source workbook:** `C:\Users\User\Downloads\TMSA_E-COOP.xlsm`  
**Investigation date:** 2026-11-04  
**Scope:** Prompt sheet requirements, legacy VBA behavior, and current application implementation.  
**Application changes:** None.

## Executive finding

The source workbook does not contain a procedure or module explicitly named `Auto Share`. The closest legacy behavior is the **monthly payment-advise** workflow, implemented through `Advise_Form`, `adviseME`, `advise_live1`–`advise_live25`, `AdviseMe_plus_names`, and `AdviseMe_minus_names`. That workflow calculates suggested/current advice values and writes advice rows to the `adv_a*` named ranges; it is not an automatic remittance-allocation engine.

The current cooplogng application already has the important primitives needed for an Auto Share feature: configurable enterprise accounts, distribution priority, compulsory dues, remittance headers/details, approval status, account-balance calculation, payment advice, and derived child remittance records. The missing feature should therefore be implemented as a deterministic allocation service layered on top of those primitives, not as a direct port of the workbook’s 25-column VBA layout.

## 1. Prompt requirements translated into engineering terms

The Prompt sheet asks for an Auto Share workflow that should:

1. Use enterprise-account configuration rather than hard-coded account positions.
2. Respect enterprise priority ordering.
3. Support compulsory dues and their configured amounts.
4. Allocate a member’s remittance amount into enterprise-level detail lines.
5. Keep the parent remittance and its distribution details auditable.
6. Prevent allocations from exceeding the available remittance amount.
7. Preserve the existing approval, reconciliation, balance, and reporting behavior.
8. Be tested against both ordinary and edge-case remittance scenarios.

The wording implies that “Auto Share” is an allocation/distribution feature. It should not be confused with the workbook’s payment advice feature, which predicts or displays what should be paid but does not itself create a remittance transaction.

## 2. Legacy workbook evidence

The VBA project contains 53 modules/forms. Relevant items include:

| Area | Evidence | Interpretation |
|---|---|---|
| Payment advice form | `Advise_form.frm` | Member-facing advice entry/display form. |
| Current balance/advice | `adviseME()` | Reads member balances from `rem_det_a2` through `rem_det_a27` and computes current advice fields. |
| Advice calculation | `advise_live1()`–`advise_live25()` | Per-enterprise calculation functions. Most cap advice by current balance; `advise_live15()` has a special six-month accrued-profit rule. |
| Advice persistence | `SubmitBotton_Click()` | Writes the advice form values to `adv_a1`–`adv_a26`; this persists advice, not remittance details. |
| Monthly advice report | `Advise_botton_Click()`, `AdviseMe_plus_names()`, `AdviseMe_minus_names()` | Builds a monthly advice print sheet and PDF from balances and advice values. |
| Manual remittance entry | `Remittance_Form.frm`, `Remittanceform()` | Opens the remittance form; no Auto Share procedure was found in the extracted VBA. |
| Transaction IDs | `Next_Transaction_ID()` | Uses `MAX(rem_a1)+1`, confirming the legacy remittance header uses sequential transaction IDs. |
| Share/savings check | `CHECKSAV_SHAR()` | Compares current shares and savings against a configured ratio; this is a validation/status check, not automatic allocation. |

### Important legacy calculation examples

`adviseME()` obtains current member balances by summing remittance-detail columns for the selected registration number. The workbook’s advice functions then use those balances and the persisted advice table. For example, the ordinary-loan advice functions use the pattern:

```vb
cur_bal = CB10.Value
raw_adv = Application.WorksheetFunction.Index(Range("adv_a11"), reg_No)
advise_live10 = IIf(raw_adv * -1 < cur_bal, cur_bal * -1, raw_adv)
```

`advise_live15()` is a special case: it calculates an accrued-profit amount over the remaining part of a six-repayment window and caps the result at the current balance. This logic is business-specific and should not be silently generalized into Auto Share without confirmation.

## 3. Current application architecture relevant to Auto Share

### Enterprise configuration

`src/screens/settings/enterprises.js` already exposes:

- `distribution_priority`, with lower numbers settled first;
- `compulsory_due`;
- `compulsory_amount`;
- `revenue`;
- `is_penalty`;
- account type, charges, interest, and loan multiplier.

The screen saves these values through `addEnterprise()`/`updateEnterprise()` and sorts active accounts by priority for display. This makes the enterprise table the correct source of ordering and rules.

The SQLite enterprise schema also includes these fields in `src/services/sqlite/constants.js`.

### Remittance persistence

`src/services/data/remittances.js` provides:

- `addRemittance(data, createdBy)`;
- `updateRemittance(id, data, modifiedBy)`;
- `approveRemittance(...)`;
- `declineRemittance(...)`;
- parent remittance fields such as `amount`, `status`, `member_id`, `bank_name`, and `remittance_date`;
- child `details[]` with `enterprise_id`, `amount`, `notes`, `auto_description`, and optional `loan_info`;
- `autogen`, `parent_remittance_id`, and loan/guarantor child handling.

A key existing rule is that loan charges and payment-advice records are not created by the generic `addRemittance()` path; some derived records are created during approval-specific flows. Auto Share must preserve that separation unless the prompt explicitly requires a new approval-side effect.

### Remittance UI and balances

`src/screens/Remittance/remittancePage.js`:

- loads enterprises, members, banks, and transaction types together;
- loads opening balances with `buildAccountBalance()`;
- loads member payment advice with `fetchMemberPaymentAdvise()`;
- groups `autogen` child remittances under their parent;
- preserves update-vs-create behavior for existing records;
- treats only approved records as balance-bearing, while pending entries are not included in opening balances.

This means Auto Share must produce details compatible with the current remittance editor and must not bypass the existing pending/approved lifecycle.

### Account balance semantics

The current application’s reporting comments state that member balances are based on the sum of approved `remittance_detail` amounts by enterprise. The parent remittance header amount is not used as the member’s per-enterprise balance. Any Auto Share implementation must therefore ensure that the detail allocation is the authoritative enterprise-level posting.

## 4. Proposed target behavior

For a new eligible remittance:

1. Load active enterprise accounts for the cooperative.
2. Sort them by `distribution_priority`, with a deterministic tie-breaker such as account ID.
3. Identify compulsory-due accounts and reserve their configured compulsory amounts, subject to an explicit policy for insufficient funds.
4. Apply the remaining amount according to the selected Auto Share policy. The default candidate is priority order, using each enterprise’s eligible balance/advice requirement as the amount needed and stopping at the available amount.
5. Create a preview containing every enterprise, allocated amount, remaining amount, and explanation.
6. Require the user to confirm the preview before saving, unless the Prompt sheet explicitly requires automatic posting.
7. Save the parent remittance with detail rows containing `enterprise_id`, `amount`, and an `auto_description` that records the rule/version used.
8. Keep the parent in the normal Pending state and allow the existing approval flow to post it.
9. Recompute balances from the saved details rather than from a duplicated summary field.

## 5. Risks and unresolved business decisions

The following points must be confirmed before implementation:

- Whether compulsory dues are reserved before all other accounts, or simply treated as another priority-ordered account.
- What happens when the remittance amount is less than the total compulsory amount: reject, partially allocate, or allocate compulsory accounts in priority order until funds are exhausted.
- Whether an enterprise’s allocation is based on payment advice, negative/outstanding balance, a fixed amount, a percentage, or a hybrid rule.
- Whether Auto Share applies only to member deposits, or also withdrawals, loans, fees, penalties, and cooperative pseudo-member transactions.
- Whether zero-value detail rows should be stored or omitted.
- Whether the feature is preview-only, auto-save, or auto-save-and-approve.
- Whether changes to enterprise priority are allowed to affect existing unapproved Auto Share records.
- How rounding is handled when amounts have more than two decimal places.
- Whether the six-month accrued-profit rule from `advise_live15()` is in scope.

## 6. Recommended implementation boundary

Implement a pure allocation module first, with no UI or persistence side effects. It should accept:

```js
{
  remittanceAmount,
  enterprises,
  balancesByEnterprise,
  adviceByEnterprise,
  policy,
  currencyScale
}
```

and return:

```js
{
  allocations: [{ enterpriseId, amount, priority, reason }],
  allocatedTotal,
  remainder,
  warnings,
  policyVersion
}
```

Only after this function is covered by tests should it be connected to the Remittance UI and `addRemittance()`.

## Evidence artifacts

The investigation retained working evidence under `.work/prompt_workbook/`, including:

- `prompt.txt` — extracted Prompt sheet text;
- `vba/olevba_decoded.txt` — decoded VBA extraction;
- `vba/key_sections.txt` — relevant procedure excerpts;
- `vba/advice_functions.txt` — advice calculation excerpts;
- `function_locations.txt` — current application symbol locations.
