# CoopLogNg Native Android Member Client

This Android Studio project contains the native Jetpack Compose member app. The current compatibility path reads and writes CoopLogNg data through the Firebase Firestore Android SDK and does not invoke Firebase Cloud Functions. Firebase Auth is retained only to clear any old SDK session at sign-out; the current member PIN flow does not authenticate through Firebase Auth.

## Current implementation

The app includes Home, Activity, Ledger, Guarantees, Advice and Profile destinations. `FirebaseMemberRepository` performs member lookup and client-side PIN verification, reads a member snapshot, records guarantor decisions, updates Payment Advice, changes a PIN and clears old Auth state. It uses existing CoopLogNg member, enterprise, remittance, loan and guarantor fields. Firestore disk persistence is disabled before the UI starts, and Android automatic backup is disabled. The app caps approved remittance history at 5,000 rows and refuses to show a snapshot if that cap is exceeded.

The Android sign-in now follows the web flow in stages: enter a member identifier, select a cooperative only when the identifier matches more than one, then enter the PIN or temporary password. “Forgot PIN?” explains the existing recovery route: ask the cooperative administrator for a temporary reset; the app does not reset credentials itself. After a temporary/default PIN, a forced-change flag or a legacy credential is verified, the member must choose and confirm a new six-digit PIN before the member dashboard opens. The temporary credential is kept only in memory during that pending change.

## Critical security warning — temporary Spark compatibility only

This is not production-safe authentication. The app reads the member record and stored password hash from Firestore, then checks the PIN on the device. A client-side SHA-256 comparison can be inspected, bypassed or modified. The current rules allow public reads and broad writes, so Firestore does not prove that a caller is the member ID entered in the app; a modified client can bypass member scoping and access or change other cooperative records. There is no server-enforced rate limit or trustworthy audit trail.

I added one local-only `loan_guarantors` update rule so direct Spark-mode guarantee decisions can work. It limits the changed fields and allows only records that are still pending, but it **does not authenticate the member**: any client can decide any pending guarantor request. The rule has not been deployed. Do not deploy it to a production project or use this app with production credentials or financial data. Replace it with member-claim authorization before production use. The sign-in screen displays a warning too.

The wider web/Functions source remains in the repository. Removing the Functions SDK from Android does not change Firebase billing settings, deploy functions, or change security rules.

## Firestore indexes

`firestore.indexes.json` includes composite indexes for the direct Android queries. These are local definitions until applied to the selected Firebase project. After confirming that project, apply only the indexes with `firebase deploy --only firestore:indexes`. This command does not deploy Functions or rules. Do not use a broad Firebase deployment as part of this Android build step.

## Build

Use JDK 17, Android Studio compatible with the configured Gradle wrapper, Android SDK 37, and the project's `google-services.json`. Build from `android` with `gradlew.bat :app:assembleDebug`. The current machine's `local.properties` points to an Android SDK directory that does not exist; the latest build stopped before source compilation and produced no APK. Install/configure the SDK and update only the local, untracked `sdk.dir` path before retrying. Release signing credentials are not checked into this repository.

## Source layout and secure upgrade path

`MainActivity.kt` initializes Firebase and disables Firestore disk persistence; `ui/CoopLogNgApp.kt` contains the Compose shell; `data/FirebaseMemberRepository.kt` holds temporary direct Firestore operations; `data/MemberModels.kt` defines app session and snapshot models; and `data/CoopLogNgRepository.kt` remains a fail-closed placeholder for a secure replacement. Before production use, migrate member identity into Firebase Auth or another trusted boundary, enforce cooperative/member isolation in rules or trusted server operations, add authorization and ledger-parity tests, and review App Check, abuse controls and audit logging. Do not move the current public access pattern into another client.
