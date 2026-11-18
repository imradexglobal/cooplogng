# CoopLogNg Native Android Member App
## Architecture and implementation status

### Current phase

Phase 2 foundation has started in the existing Android Studio project. No replacement project was created.

### Implemented in the Android project

- Replaced the default `Hello Android!` activity with a native Jetpack Compose member shell.
- Added bottom navigation for Home, Activity, Ledger, Guarantees and Profile.
- Added a member sign-in surface with cooperative context and PIN input.
- Added fail-closed empty states for balances, transactions, ledger and guarantor data.
- Added audited domain models for member sessions, account summaries, transactions and guarantor requests.
- Added `MemberRepository` contracts for sign-in, snapshot refresh, guarantor decisions, password changes and sign-out.
- Added a `CoopLogNgRepository` implementation that refuses to read or write financial data until a trusted backend boundary is configured.
- Applied a distinct modern financial-app color system while preserving the existing Compose/Material 3 setup.
- Placed the supplied Firebase configuration at `android/app/google-services.json`; its package matches `com.imradexglobal.cooplogng` and the app is wired for Firebase Auth/Firestore initialization.
- Added a native Payment Advice destination backed by `updateMemberPaymentAdvice`; editable advice is submitted through the secure callable boundary and automatic loan advice is locked.
- Added statement PDF generation and Android share support from the authenticated member snapshot, using a scoped `FileProvider` cache path.

### Intentional current limitation

The UI does not show fabricated balances, mock transactions, placeholder loans or cached financial values. The repository currently returns a safe configuration error because the existing web backend authenticates by client-side Firestore password-hash comparison and the current Firestore rules permit public access to sensitive collections. Connecting Android directly to that model would violate the project’s security requirements.

## Target architecture

```text
Compose UI
   ↓
View/state layer
   ↓
MemberRepository
   ├── SecureAuthDataSource
   ├── MemberLedgerDataSource
   ├── GuarantorDataSource
   └── PaymentAdviceDataSource
           ↓
Trusted CoopLogNg member boundary
           ↓
Existing Firestore / SQLite-sync authoritative records
```

The Android client should receive a minimal member-scoped session and canonical read models. It must not receive administrative documents or perform client-side password verification. Financial reads should be online-first and carry a refresh timestamp/status. Offline data, if introduced later, must be clearly labelled stale and must never be presented as current.

## Required secure backend contract

A trusted backend operation or API must provide:

- Member sign-in using the existing identifier/cooperative/PIN compatibility rules, with server-side verification.
- A short-lived authenticated session or Firebase custom token tied to member ID and cooperative ID.
- Member-scoped snapshot containing only authorised profile, enterprise configuration, approved balances, transactions, ledger rows, guarantor summaries and eligible payment-advice settings.
- Server-side guarantor decision operation enforcing target-guarantor identity, cooperative scope, pending status and auditable timestamp/actor.
- Server-side payment-advice update enforcing enterprise eligibility, amount limits and distribution rules.
- Password change operation with reauthentication and no password persistence in Firestore or Android storage.

## Data invariants carried from the web audit

- Only `Approved` remittances contribute to posted member financial data.
- Member data is always scoped by the authenticated member ID and cooperative ID.
- Pure revenue enterprises do not increase member net worth.
- Compulsory dues and penalties remain member obligations even when an enterprise has revenue classification.
- Ledger ordering is remittance date, then creation timestamp, then record ID.
- Opening balances include all approved records before the selected period.
- Running balances cannot be computed from only the visible/paginated page.
- Loan and guarantor data must use approved loan/repayment records and existing enterprise rules.

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 1. Discovery and audit | Complete | Report saved as `CoopLogNg_Phase1_Audit.md`. |
| 2. Android foundation | In progress | Native Compose shell, repository boundary, Firebase project plumbing and callable backend client added. |
| 3. Core member experience | Implemented in source | Dashboard, activity, ledger, guarantor actions, profile/PIN change and Payment Advice surfaces are wired to secure member snapshots/actions. |
| 4. Advanced member services | Implemented in source | Server-validated guarantor, password and payment-advice operations are implemented and wired to Android; live operation awaits Functions deployment. |
| 5. Web member improvements | Not started | Must share the secured backend boundary. |
| 6. Security/integration testing | Blocked by deployment | Backend source is validated, but Firebase Functions deployment requires billing enabled on `cooplogng`. |
| 7. Release preparation | Blocked | Release signing credentials and backend security are still required; fresh build is blocked because the Gradle wrapper distribution is unavailable locally. |

## Release gate

The app must not be labelled production-ready, signed for release, or distributed with real member data until:

1. Firebase/API authentication is server-authorized.
2. Firestore rules or API authorization enforce member/cooperative isolation.
3. Guarantor and payment-advice writes are trusted operations.
4. Android receives only minimal member-scoped data.
5. Web/desktop regression tests pass after backend changes.
6. Multiple-member and multiple-enterprise isolation tests pass.
7. A real release signing configuration is explicitly configured by the project owner.
