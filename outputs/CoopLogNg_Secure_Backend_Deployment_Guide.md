# CoopLogNg secure member backend

## What is now implemented

The project now contains a Firebase Functions member boundary under `functions/`:

- `memberLogin`: verifies the existing member PIN hash on the server, creates/updates a Firebase Auth user with member/cooperative claims, and returns a custom token plus minimal member session.
- `getMemberSnapshot`: requires an authenticated member custom-token session and returns only that member's approved account balances, approved transactions and guarantor requests.
- `decideGuarantor`: requires the authenticated member to be the assigned guarantor, requires a pending request, and records the decision with actor/timestamps.
- `changeMemberPassword`: requires the authenticated member and current PIN, validates a six-digit replacement PIN, stores only its SHA-256 hash and clears the force-change flag.
- `updateMemberPaymentAdvice`: validates enterprise scope, amount bounds and ₦100 rounding, preserves automatic loan advice, and writes only member-owned advice.

The Android client now uses `FirebaseMemberRepository`, signs in with `memberLogin`, exchanges the custom token through Firebase Auth, and calls the protected snapshot, guarantor, password and payment-advice operations through Firebase Functions in `europe-west1`. The native UI includes authenticated guarantor accept/decline controls and current-PIN/new-PIN change controls.

## Files

- `functions/index.js`
- `functions/package.json`
- `firebase.json`
- `android/app/google-services.json`
- `android/app/src/main/java/com/imradexglobal/cooplogng/data/FirebaseMemberRepository.kt`

## Deployment steps

From the project root, install the isolated Functions dependencies and deploy only the new functions:

```powershell
npm.cmd install --prefix functions
firebase.cmd deploy --only functions --project cooplogng
```

### Current deployment blocker

The authenticated CLI reached the correct `cooplogng` project, but deployment was rejected because the project has no open billing account. Firebase requires billing to activate the Cloud Functions, Cloud Build and Artifact Registry APIs used by the current Functions runtime. No functions were deployed and no Firestore rules or Hosting configuration was changed.

After the project owner enables billing for `cooplogng`, rerun the two commands above. The deployment is limited to the Functions codebase and does not deploy Firestore rules or Hosting.

After deployment, verify the callable region is `europe-west1`, then test with a non-production member account. Do not test with a real member PIN in logs or shell history.

## Security notes

- The callable functions use Admin SDK access server-side; administrative credentials are not shipped in Android.
- Android never reads `members`, `remittance`, `enterprise` or `loan_guarantors` directly.
- Existing legacy web/desktop Firestore access remains unchanged by this boundary, so the existing rules are not tightened in this step and administrative regression risk is reduced.
- The legacy Firestore rules remain unsafe for direct clients. Android must continue using only the callable boundary.
- The backend currently uses the existing SHA-256/legacy-plaintext compatibility rule to avoid locking out existing accounts. Legacy plaintext records should be migrated and removed after member login migration is complete.
- Before production rollout, add App Check enforcement, rate limiting/abuse monitoring, emulator tests, and a migration plan for legacy password records.

## Validation checklist

1. Deploy functions to the `cooplogng` project.
2. Sign in from Android with a test member account.
3. Confirm a Firebase Auth user is created with only `role`, `memberId` and `cooperativeId` claims.
4. Confirm `getMemberSnapshot` returns only approved records for that member/cooperative.
5. Try a different member ID and confirm the first member's records are not returned.
6. Test guarantor decision with the assigned member and with a different member.
7. Test password change with wrong and correct current PINs.
8. Compare returned account totals and ledger ordering against the existing web application.
9. Run web regression tests and verify existing admin workflows remain operational.
10. Only then prepare release signing and APK/AAB builds.
