# CoopLogNg Native Android Member App — Progress Assessment

**Assessment date:** 18 November 2026  
**Project root:** `C:\Users\USER\Documents\Imradex_Project\cooplogng`  
**Android project:** `C:\Users\USER\Documents\Imradex_Project\cooplogng\android`

## Executive assessment

The Android project now has a Spark-plan compatibility implementation that reads and writes through the Firebase Firestore Android SDK and does not call Firebase Cloud Functions. The Android Firebase Functions dependency and catalog alias have been removed. Member discovery and PIN comparison are implemented in the client using the existing CoopLogNg `members` fields and SHA-256/legacy plaintext credential formats. Snapshot reads, guarantor decisions, Payment Advice updates and PIN changes are also direct Firestore operations. The login UI now mirrors the web stages (member identifier, cooperative choice only when needed, then PIN), includes an administrator-led PIN recovery guidance screen, and requires a new six-digit PIN after a temporary/default, forced-change or legacy credential is verified.

**This is not production-safe authentication and must be treated as test-only.** The app's member identity is a client-created context, not a trusted authorization credential. The checked-in Firestore rules permit public reads and broad writes, so an altered client can bypass UI scoping and read or change other cooperative records. Hashing a PIN with SHA-256 and comparing it on a device does not protect member credentials. I displayed this warning on the sign-in screen and documented it in the Android README.

The Firestore rules source now contains a *local-only* field-limited update rule for pending `loan_guarantors` decisions, because the existing default-deny write rule would block that Spark-mode feature. This rule still permits any unauthenticated client to decide any pending guarantor record. It has **not** been deployed and must not be deployed to production.

The debug APK has **not** been built. The latest Gradle attempt reached project configuration after downloading the wrapper, but failed before Kotlin/Java source compilation because `android/local.properties` points to an Android SDK directory that does not exist. No APK/AAB was produced. No Firebase indexes or rules were deployed.

## Changes made for Spark compatibility

- Replaced the Android member repository's callable-Functions path with direct Firestore SDK reads and writes for member lookup/PIN verification, account snapshot, guarantor decisions, Payment Advice, PIN changes and sign-out cleanup.
- Kept Firebase Auth only to clear any stale SDK auth state on sign-out. The current member login does **not** sign into Firebase Auth or receive a trusted server credential.
- Removed `firebase-functions` from `android/app/build.gradle.kts` and `android/gradle/libs.versions.toml`. The wider web/Functions source remains intact and is not invoked by the Android app.
- Added local composite index definitions for the enterprise, remittance, loan and guarantor queries. They are not live until separately applied to the selected Firebase project.
- Added a local-only, field-limited rule for pending guarantor updates; it allows only the decision, timestamp and actor fields but does not authenticate the actor. It was not deployed.
- Disabled Firestore disk persistence before the UI starts; Android automatic backup remains disabled.
- Added a fail-closed remittance-history limit: when a member has more than 5,000 approved remittances, Spark mode refuses to calculate/display a potentially truncated snapshot.
- Corrected the sign-in field label to the member identifiers supported by the repository and replaced the prior backend-security assurance with an explicit warning.

## Material limitations and risks

1. **Firestore access is not isolated.** Current rules allow unauthenticated reads and broad writes. The UI's member ID/cooperative filters are not security controls; direct access can be scripted outside this app. The local guarantor rule further allows any unauthenticated caller to update pending requests within its field limits.
2. **PIN verification is inspectable and bypassable.** The device reads a stored hash or legacy plaintext password and compares it locally. There is no server-enforced rate limit, trusted session, App Check enforcement or reliable audit trail for these operations.
3. **Financial calculations are not canonical ledger parity.** The Android snapshot mirrors the prior callable's simplified inclusion and balance behavior, not the web `buildMemberLedgerView` rules for transaction classification, transfers, dues settlement, opening balances and account-specific period calculations. It returns only recent activity; the PDF flow is not a complete period statement.
4. **History is intentionally capped.** The app now fails closed above 5,000 approved remittance rows rather than present a balance based on an incomplete set. A cursor-paginated canonical ledger is still required for larger accounts.
5. **Payment Advice surface is partial.** The app can update existing advice rows but does not yet reproduce the full web workflow for adding eligible enterprises without an existing row or prove the complete enterprise-eligibility policy.
6. **PIN recovery remains administrator-led.** The Android “Forgot PIN?” screen guides members to request a temporary reset from their cooperative administrator, matching the existing web workflow; it does not create a self-service reset request or reset a PIN itself. Temporary/default credentials and `force_password_change` flags now lead to a mandatory six-digit PIN change before member data is shown.
7. **Indexes and rules are not deployed or emulator-tested.** The updated index manifest must be applied to the intended Firebase project before queries requiring those indexes will work. The temporary guarantor rule must not be deployed to production.

## Validation performed

- Firestore index manifest: parsed successfully as JSON with 44 composite indexes after the local additions.
- Android configuration/repository static check: confirmed no Firebase Functions SDK alias/dependency and no `FirebaseFunctions`/callable API reference in the Android repository.
- Android sign-in notice, repository contract/model fields, manifest backup setting and activity initialization were source-reviewed. Firestore disk persistence is configured off before Compose constructs the repository.
- Staged-login static contract check passed: both repository implementations include cooperative discovery and PIN-change parameters, and the UI contains all three stages, the admin-guided recovery route and the forced first-login PIN screen.
- Latest Android build attempt: failed before source compilation because the configured `sdk.dir` path does not exist. An earlier offline attempt could not fetch the missing Gradle distribution; the network-enabled attempt reached Gradle configuration but still could not locate the Android SDK. Gradle also reported a concurrent problems-report file collision, secondary to the failed build. No APK/AAB was generated and Kotlin compilation remains unverified.
- Prior web regression baseline (before the Spark-only Android edits): 23 focused member-ledger, transaction classification, Payment Advice and loan-advice tests passed. Those tests were not rerun because web business code was not changed in this task.
- No Firebase emulator, live member sign-in, cross-member authorization test, rules test, or deployed-index test was performed.

## Recommended next steps

1. Install/configure Android SDK 37, correct the machine-local `android/local.properties` `sdk.dir` path without committing a device-specific location, then rerun `:app:assembleDebug` and fix any compile errors.
2. Apply only the Firestore index definitions to a confirmed non-production Firebase project, then run with test data and verify queries and write fields against representative CoopLogNg documents. Do not deploy the temporary guarantor rule to production.
3. Before any production use, stop using this client-side credential flow. Implement Firebase Auth or a trusted member backend and enforce per-member/cooperative access in Firestore rules; add rate limits, App Check, logging and cross-member denial tests.
4. Define and test a canonical member-ledger contract that matches the existing web accounting rules, supports cursor pagination, and validates balances and PDF/statement periods against controlled fixtures.
5. Build and manually exercise all login stages, recovery guidance and first-login PIN change in Android Studio, then address remaining advice eligibility, guarantor refresh/history, account/date filters and full statement export only against the verified contract. Do not distribute the Spark compatibility build with real financial data.

## Current release decision

**Test-only; do not distribute with real member financial data.** The project is free of Android callable-Functions dependencies, but is not a secure substitute for those functions. Public Firestore rules, local PIN verification, an unauthenticated local guarantor update rule, incomplete ledger parity, undeployed indexes and the missing Android SDK/build validation remain blockers.
