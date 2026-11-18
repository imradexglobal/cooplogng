# CoopLogNg Native Android Member App
## Phase 1 — Project Discovery and Integration Audit

**Audit date:** 2026-11-18  
**Workspace:** `C:\Users\USER\Documents\Imradex_Project\cooplogng`  
**Android project:** `C:\Users\USER\Documents\Imradex_Project\cooplogng\android`

## Executive summary

The supplied Android project is an existing, minimal Jetpack Compose application and must be extended in place. It is not yet a member banking application: the only implemented screen is the default `Hello Android!` activity. The web/desktop project contains substantial cooperative accounting, member, remittance, loan, guarantor and payment-advice logic, but that logic is primarily implemented through a local SQLite/synchronisation layer and a custom Firestore-backed authentication flow.

The most important production blocker is security and authentication compatibility. The web application currently validates a member/user password hash directly against Firestore documents (`members`/`users`) rather than using Firebase Authentication for the primary PIN login. The current Firestore rules explicitly state that `request.auth` is null and allow public reads on sensitive collections, plus broad writes/deletes on many collections. A native client must not be built against this posture as-is. A secured compatibility backend or a carefully staged migration to Firebase Authentication with server-side authorization is required before exposing real member financial data in a production Android release.

No Android `google-services.json`, Firebase Android dependencies, Cloud Functions directory, or native Firebase integration was found in the supplied Android project. The existing web client does use Firebase Web SDK configuration from environment variables and Google Sign-In as an optional flow.

## 1. Existing Android project

### Configuration

- Root project name: `CoopLogNg`.
- Single Gradle module: `:app`.
- Namespace and application ID: `com.imradexglobal.cooplogng`.
- Compile SDK: 37.
- Target SDK: 37.
- Minimum SDK: 23.
- Version: `versionCode = 1`, `versionName = 1.0`.
- Android Gradle Plugin: 9.5.1.
- Kotlin: 2.2.10.
- Compose BOM: 2026.02.01.
- Java source/target compatibility: Java 11.
- Compose is enabled; Material 3, Activity Compose, Core KTX and Lifecycle Runtime KTX are present.
- No Navigation Compose, Firebase Android SDK, Room, security-crypto, PDF library or Google Services plugin is currently configured.
- The manifest contains a single exported launcher activity, `.MainActivity`.
- No signing configuration was found in the inspected Gradle configuration.
- The app has standard generated launcher resources and theme files.

### Current implementation

`MainActivity.kt` only calls `enableEdgeToEdge()`, applies `CoopLogNgTheme`, and renders a `Scaffold` containing `Greeting("Android")`. There is no authentication, navigation, repository, data model, network handling, Firebase setup, member session, dashboard or financial feature implementation.

The project directory contains generated build output including a prior `app-debug.apk`, but a fresh baseline build could not be completed during this audit because the Gradle wrapper attempted to download Gradle 9.9.1 and outbound network access was denied. This is an environment/build reproducibility issue, not evidence that the source currently fails compilation.

## 2. Existing web/desktop application

### Architecture

- Vite-based JavaScript application, package version 3.0.0.
- Electron desktop entry point is configured through `electron/main.js`.
- Capacitor Android dependencies are present in the web package, but the requested deliverable is a separate native Android client and should not be treated as a WebView/APK conversion.
- Application code is organized into screens, components, services, state and utilities.
- The project contains a substantial local SQLite data layer (`src/services/sqlite`) and synchronization services (`syncService`, `backgroundSyncService`, `syncQueue`, `syncState`, `indexedDbService`).
- Firebase Web SDK 12.2.1 and Firebase Admin 14.4.0 are listed in the web package. Firebase hosting/firestore configuration exists in `firebase.json`; no `functions/` source directory was found.

### Important existing domain modules

- Authentication: `src/services/authService.js`, `src/screens/Login/loginService.js`, `offlineAuthService.js`, `rememberMeService.js`.
- Member balances: `src/services/data/balance.js`.
- Member ledger: `src/services/data/memberLedgerView.js` and `src/screens/MemberLedger.js`.
- Remittances: `src/services/data/remittances.js` and `src/screens/Remittance/*`.
- Loans: `src/services/data/loans.js`, `loanAdvice.js`, `LoanWizard.js`, and experimental loan views.
- Guarantors: `src/screens/settings/guarantor.js`, with data access exposed through `dataService.js`/SQLite helpers.
- Payment advice: `src/services/data/advice.js`, `src/services/data/loanAdvice.js`, `src/screens/PaymentAdvice.js`.
- Reporting/export: `src/services/reports/*` and experimental PDF/ledger helpers.
- Enterprise configuration: `src/services/data/enterprises.js` and enterprise-related screens.

## 3. Authentication findings

The primary username/mobile/special-ID/PIN flow is custom:

1. The user identifies a username, mobile number, email, registration number or special ID.
2. The client discovers the cooperative by bounded Firestore queries against `users` and `members`.
3. The selected cooperative is used to query the matching user/member document.
4. The entered PIN is SHA-256 hashed and compared client-side with `password_hash`; legacy plaintext equality is also supported.
5. Local-storage progressive rate limiting is applied.
6. The client checks cooperative extraction status and subscription status.
7. Member login statistics are written back to Firestore.
8. The resulting session contains `memberId`, cooperative ID/name, role, permissions and the full user document.

Google Sign-In is separately wired through Firebase Auth and can link a verified Google email to a member after mobile/name matching. It is not the same as the primary PIN authentication mechanism.

Implications for Android:

- Android cannot use `FirebaseAuth.signInWithEmailAndPassword` as a drop-in replacement without changing the existing account model.
- Sending a password hash or validating a password directly from an untrusted mobile client is not acceptable for a production financial client.
- The safest path is a server-side authentication/compatibility endpoint or a staged migration that issues Firebase Auth custom tokens after server-side verification.
- The Android session must not persist the complete member document if it contains sensitive or administrative fields.

## 4. Financial data and accounting rules

The inspected accounting implementation establishes these rules:

- Only remittances with `status === 'Approved'` contribute to member balances and posted ledgers.
- A member-scoped query filters by the authenticated member ID.
- Transaction/detail records are allocated through `details[].enterprise_id` or `details[].item`.
- Enterprise metadata controls classification.
- Pure revenue enterprises are excluded from member net worth; compulsory dues and penalties remain included even when an enterprise is also marked as revenue.
- Ledger ordering is chronological by remittance date, then `created_at`, then ID.
- Opening balances are calculated from all approved records before the selected period, not merely from the currently visible page.
- Member ledger rows distinguish credit/debit presentation from balance impact; internal transfers and auto-generated dues settlement rows receive special handling.
- Loan balances/advice must be based on the existing loan/remittance records and enterprise configuration rather than an independent Android calculation.

A native repository should therefore consume a canonical, server-authorized member ledger/balance view or reproduce the exact audited algorithm over a complete authorized dataset. It must not calculate a running balance over a partial paginated page.

## 5. Loans and guarantors

The current implementation uses SQLite/sync-backed records including `loans` and `loan_guarantors`.

Observed workflow:

- Loan approval changes the remittance to `Approved`, creates/updates loan records, creates guarantor child records, activates loans and can create loan-charge and loan-income internal transfers.
- Guarantor records include a loan ID, member ID, guarantee amount, approval value, timestamps and audit fields.
- A guarantor decision is currently persisted using `guarantor_approval`, `approved_at`, `modified_at` and `modified_by`.
- The web UI presents pending/approved/rejected requests and requires an explicit confirmation before decision.
- The current client-side write path passes a username/member ID as the actor; backend authorization is not enforced by the visible Firestore rules.

Before Android exposes accept/decline actions, the backend must enforce that the authenticated actor is the target guarantor, the request is still pending, the loan belongs to the same cooperative, and the decision is recorded exactly once or follows an explicit cooperative policy for changes. A trusted server-side operation is recommended.

## 6. Payment advice

Payment advice is enterprise-driven. The inspected presentation logic applies this precedence:

1. Penalty: zero advice.
2. Compulsory due: configured compulsory amount.
3. Revenue: configured compulsory amount.
4. Loan: raw advice capped against the absolute outstanding loan balance.
5. Other accounts: raw advice amount.

The Android feature must first resolve the member's cooperative and enterprise configuration and must not show savings advice controls to ineligible enterprises. Updates must be validated server-side and audited; members must not be able to alter enterprise distribution priorities.

## 7. Firestore and backend security findings

The current `firestore.rules` file has critical production risks:

- `members`, `users`, `remittance`, `enterprise` and `bank` allow public reads (`allow read: if true`).
- Several collections allow broad writes/deletes with only a client-supplied `cooperative_id` schema check.
- `feedback`, `cooperatives`, notifications, transaction types and other collections also have broad access.
- The rules comment confirms that the application currently operates with `request.auth == null` for the custom login flow.
- No Cloud Functions source directory was found for trusted member operations.

This means UI restrictions alone cannot satisfy the requested member isolation/security requirements. Before a production Android release, rules and backend operations must be redesigned around authenticated identity and cooperative/member claims, or a trusted API layer must mediate all member reads/writes. Admin workflows must be regression-tested during that change.

## 8. Phase 1 gaps and recommended implementation order

### Blocking gaps

1. No native Firebase Android configuration or dependencies.
2. No secure Android-compatible authentication contract.
3. Firestore rules do not currently enforce member isolation.
4. No trusted server-side guarantor decision operation was found.
5. Canonical cloud schema and sync contract need to be documented for Android; much of the current domain access is through local SQLite.
6. No native PDF statement generation/export implementation.
7. No Android navigation, repository, state, error, offline freshness or secure-storage foundation.

### Recommended next phases

1. Define and implement the secure authentication/session boundary without changing the existing web login until compatibility is proven.
2. Add Firebase Android configuration and dependencies only after the project identity and Firebase app registration are confirmed.
3. Build a read-only member data contract for profile, enterprise eligibility, approved balances, ledger pages, transactions and guarantor summaries.
4. Implement backend-enforced guarantor decision and payment-advice update operations.
5. Add Compose navigation and member-only screens using repository interfaces, with online-first freshness indicators and no misleading stale financial data.
6. Implement statement generation from the same canonical ledger result.
7. Tighten Firestore rules in a staged deployment and regression-test web/desktop admin operations.

## 9. Baseline validation status

- Android source inventory: completed.
- Web source/domain inventory: completed.
- Firebase configuration/rules review: completed.
- Android fresh build: blocked because Gradle wrapper download was denied by the execution environment; an existing debug APK is present under generated build output.
- Web test command: PowerShell blocked `npm.ps1` by execution policy; rerun through `npm.cmd test` or an approved shell command.
- Backend source check: no `functions/` directory and no `android/app/google-services.json` found.

## 10. Decision

Do not begin by building a generic dashboard against direct public Firestore reads. Preserve the existing Android project and use this audit as the architecture gate. The next implementation step should be a security-compatible data/authentication boundary and a minimal read-only member slice backed by the existing accounting rules. Only after that boundary is validated should the full dashboard, ledger, PDF, guarantor and payment-advice workflows be implemented.
