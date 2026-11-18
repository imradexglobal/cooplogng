package com.imradexglobal.cooplogng.data

import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.tasks.await
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Spark-plan compatibility repository.
 *
 * This deliberately uses the CoopLogNg Firestore client SDK directly and does
 * not call Firebase Cloud Functions. PIN verification and member scoping are
 * therefore client-side only; the current Firestore rules do not enforce them.
 * Do not use this compatibility mode for production financial data.
 */
class FirebaseMemberRepository(
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance(),
) : MemberRepository {
    private val members get() = db.collection("members")

    private fun text(value: Any?): String = value?.toString()?.trim().orEmpty()

    private fun number(value: Any?): Long = when (value) {
        is Number -> value.toLong()
        else -> value?.toString()?.toDoubleOrNull()?.toLong() ?: 0L
    }

    private fun truthy(value: Any?): Boolean = when (value) {
        is Boolean -> value
        is Number -> value.toInt() != 0
        else -> value?.toString()?.trim()?.lowercase(Locale.US)?.let { it in setOf("1", "true", "yes") } ?: false
    }

    private fun isDeleted(value: Any?): Boolean = truthy(value)

    private fun isActiveMember(data: Map<String, Any?>, cooperativeId: String?): Boolean {
        if (isDeleted(data["is_deleted"])) return false
        val memberCooperativeId = text(data["cooperative_id"])
        if (memberCooperativeId.isBlank()) return false
        if (cooperativeId != null && memberCooperativeId != cooperativeId) return false
        return text(data["status"]).lowercase(Locale.US) !in setOf("archived", "disabled", "suspended", "inactive")
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString(separator = "") { byte -> "%02x".format(Locale.US, byte.toInt() and 0xff) }

    private fun normalized(value: String): String = value.trim().lowercase(Locale.US)
    private fun phoneKey(value: String): String = value.filter(Char::isDigit)

    private fun isLegacyComplexPassword(value: String): Boolean = value.length >= 8 &&
        value.any(Char::isLowerCase) && value.any(Char::isUpperCase) &&
        value.any(Char::isDigit) && value.any { !it.isLetterOrDigit() }

    private fun requiresPinChange(stored: String, typedPin: String, forceFlag: Any?): Boolean {
        if (typedPin == "123456" || truthy(forceFlag) || stored.isBlank()) return true
        if (!stored.matches(Regex("^[a-fA-F0-9]{64}$"))) return true
        return !typedPin.matches(Regex("^\\d{6}$")) && !isLegacyComplexPassword(typedPin)
    }

    private fun matchesMember(data: Map<String, Any?>, identifier: String): Boolean {
        val key = normalized(identifier)
        val phone = phoneKey(identifier)
        val textFields = listOf(
            data["special_id_lower"], data["email_lower"], data["registration_no_str"],
            data["special_id"], data["email"], data["registration_no"],
        ).map { normalized(text(it)) }
        return key in textFields || (phone.isNotEmpty() && phoneKey(text(data["mobile"])) == phone)
    }

    private suspend fun lookupCandidates(identifier: String, cooperativeId: String?): LinkedHashMap<String, DocumentSnapshot> {
        val key = normalized(identifier)
        val phone = phoneKey(identifier)
        val candidates = linkedMapOf<String, DocumentSnapshot>()
        val lookups = mutableListOf<Pair<String, String>>()
        listOf("special_id_lower", "email_lower", "registration_no_str").forEach { lookups += it to key }
        if (phone.isNotBlank()) lookups += "mobile" to phone
        var anyLookupSucceeded = false
        var lastLookupError: Exception? = null

        // Stage one searches only identifier indexes. A cooperative-scoped query
        // is used during sign-in; global field queries discover matching co-ops.
        for ((field, value) in lookups) {
            if (value.isBlank()) continue
            try {
                val base: Query = members
                val scoped = if (cooperativeId == null) base else base.whereEqualTo("cooperative_id", cooperativeId)
                scoped
                    .whereEqualTo(field, value)
                    .limit(if (cooperativeId == null) 50L else 5L)
                    .get().await().documents.forEach { candidates[it.id] = it }
                anyLookupSucceeded = true
            } catch (error: Exception) {
                lastLookupError = error
                // A bounded legacy-field fallback handles unavailable indexes.
            }
        }

        if (candidates.values.none { candidate ->
                val data = candidate.data ?: emptyMap()
                isActiveMember(data, cooperativeId) && matchesMember(data, identifier)
            }) {
            val fallbackLookups = mutableListOf(
                Triple("special_id_lower", key, 50L),
                Triple("email_lower", key, 20L),
                Triple("registration_no_str", key, 20L),
                Triple("special_id", identifier.trim(), 50L),
                Triple("email", identifier.trim(), 20L),
                Triple("registration_no", identifier.trim(), 20L),
            )
            if (phone.isNotBlank()) fallbackLookups += Triple("mobile", phone, 50L)
            for ((field, value, limit) in fallbackLookups) {
                if (value.isBlank()) continue
                try {
                    db.collection("members").whereEqualTo(field, value).limit(limit)
                        .get().await().documents.forEach { candidate ->
                            val data = candidate.data ?: emptyMap()
                            if (cooperativeId == null || text(data["cooperative_id"]) == cooperativeId) {
                                candidates[candidate.id] = candidate
                            }
                        }
                    anyLookupSucceeded = true
                } catch (error: Exception) {
                    lastLookupError = error
                    // Continue; unavailable legacy fields should not block other keys.
                }
            }
        }

        if (!anyLookupSucceeded) {
            throw lastLookupError ?: IllegalStateException("Unable to search member records.")
        }
        return candidates
    }

    override suspend fun discoverCooperatives(identifier: String): RepositoryResult<List<CooperativeOption>> {
        return try {
            val cleanIdentifier = identifier.trim()
            if (cleanIdentifier.isBlank()) return RepositoryResult.Failure("Enter your mobile number, email or member ID.")
            val candidates = lookupCandidates(cleanIdentifier, cooperativeId = null)
            val cooperativeIds = candidates.values.mapNotNull { candidate ->
                val data = candidate.data ?: emptyMap()
                if (isActiveMember(data, cooperativeId = null) && matchesMember(data, cleanIdentifier)) {
                    text(data["cooperative_id"]).takeIf { it.isNotBlank() }
                } else null
            }.distinct()
            val options = cooperativeIds.map { id ->
                val cooperative = db.collection("cooperatives").document(id).get().await()
                val data = cooperative.data ?: emptyMap()
                CooperativeOption(
                    id = id,
                    name = text(data["name"]).ifBlank {
                        text(data["full_name"]).ifBlank { text(data["short_name"]).ifBlank { id } }
                    },
                )
            }.sortedBy { it.name.lowercase(Locale.US) }
            RepositoryResult.Success(options)
        } catch (error: Exception) {
            RepositoryResult.Failure(error.message ?: "Unable to find your cooperative. Check your connection and try again.", error)
        }
    }

    private suspend fun findMember(identifier: String, cooperativeId: String): DocumentSnapshot? {
        val candidates = lookupCandidates(identifier, cooperativeId)
        val active = candidates.values.filter {
            val data = it.data ?: emptyMap()
            isActiveMember(data, cooperativeId) && matchesMember(data, identifier)
        }
        return when (active.size) {
            0 -> null
            1 -> active.single()
            else -> throw IllegalStateException("More than one active member matches these details. Please contact your cooperative administrator.")
        }
    }

    private fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

    private fun dateMillis(value: Any?): Long {
        if (value is Timestamp) return value.toDate().time
        if (value is Date) return value.time
        if (value is Number) return value.toLong()
        val raw = text(value)
        if (raw.isBlank()) return 0L
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSX",
            "yyyy-MM-dd'T'HH:mm:ssX",
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd",
        )
        for (pattern in patterns) {
            try {
                val parser = SimpleDateFormat(pattern, Locale.US).apply {
                    isLenient = false
                    timeZone = TimeZone.getTimeZone("UTC")
                }
                parser.parse(raw)?.let { return it.time }
            } catch (_: Exception) {
                // Try the next date representation used by legacy records.
            }
        }
        return 0L
    }

    private fun displayDate(value: Any?): String {
        if (value is String) return value
        val millis = dateMillis(value)
        if (millis == 0L) return text(value)
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(millis))
    }

    private fun includedDetail(detail: Map<String, Any?>, enterprise: Map<String, Any?>?): Boolean {
        if (enterprise == null) return true
        val revenue = truthy(enterprise["revenue"])
        val dueOrPenalty = truthy(enterprise["compulsory_due"]) || truthy(enterprise["is_penalty"])
        return !(revenue && !dueOrPenalty)
    }

    override suspend fun signIn(
        identifier: String,
        pin: String,
        cooperativeId: String,
    ): RepositoryResult<MemberSession> {
        return try {
        val cleanIdentifier = identifier.trim()
        val cleanPin = pin.trim()
        val cleanCooperativeId = cooperativeId.trim()
        if (cleanIdentifier.isBlank() || cleanPin.isBlank() || cleanCooperativeId.isBlank()) {
            return RepositoryResult.Failure("Enter your member ID, PIN and cooperative ID.")
        }

        val memberDoc = findMember(cleanIdentifier, cleanCooperativeId)
            ?: return RepositoryResult.Failure("Invalid member credentials.")
        val member = memberDoc.data ?: return RepositoryResult.Failure("Member account is unavailable.")
        val stored = text(member["password_hash"])
        if (stored != sha256(cleanPin) && stored != cleanPin) {
            return RepositoryResult.Failure("Invalid member credentials.")
        }
        val pinChangeRequired = requiresPinChange(stored, cleanPin, member["force_password_change"])

        val cooperative = db.collection("cooperatives").document(cleanCooperativeId).get().await()
        val cooperativeData = cooperative.data ?: emptyMap()
        if (truthy(cooperativeData["is_extracted"])) {
            return RepositoryResult.Failure("This cooperative's data has been extracted. Please contact your administrator.")
        }
        val displayName = listOf(member["last_name"], member["first_name"], member["middle_name"])
            .map(::text).filter(String::isNotBlank).joinToString(" ")
            .ifBlank { text(member["name"]).ifBlank { text(member["mobile"]).ifBlank { "Member" } } }
        val session = MemberSession(
            memberId = memberDoc.id,
            cooperativeId = cleanCooperativeId,
            cooperativeName = text(cooperativeData["name"]).ifBlank {
                text(cooperativeData["full_name"]).ifBlank {
                    text(cooperativeData["short_name"]).ifBlank { cleanCooperativeId }
                }
            },
            displayName = displayName,
            registrationNumber = text(member["registration_no"]).ifBlank { text(member["special_id"]) }.takeIf { it.isNotBlank() },
            requiresPinChange = pinChangeRequired,
        )

        // Best-effort compatibility with the web login counter. This is a
        // client write and is not an auditable or security-enforced operation.
        if (!pinChangeRequired) {
            try {
                memberDoc.reference.update(
                    mapOf("last_login" to isoNow(), "login_count" to FieldValue.increment(1))
                ).await()
            } catch (_: Exception) {
                // Login itself remains successful if this legacy statistic is unwritable.
            }
        }
        RepositoryResult.Success(session)
    } catch (error: Exception) {
        RepositoryResult.Failure(error.message ?: "Unable to sign in. Check your connection and try again.", error)
    }
    }

    override suspend fun loadSnapshot(
        session: MemberSession,
        forceRefresh: Boolean,
    ): RepositoryResult<MemberSnapshot> = try {
        coroutineScope {
            val memberRef = members.document(session.memberId)
            val memberSnapshot = memberRef.get().await()
            if (!memberSnapshot.exists()) {
                return@coroutineScope RepositoryResult.Failure("Member account is unavailable.")
            }
            val memberData = memberSnapshot.data ?: emptyMap()
            if (!isActiveMember(memberData, session.cooperativeId)) {
                return@coroutineScope RepositoryResult.Failure("Member account is unavailable.")
            }

            val enterprisesTask = async {
                db.collection("enterprise")
                    .whereEqualTo("cooperative_id", session.cooperativeId)
                    .whereEqualTo("is_deleted", 0)
                    .get().await().documents
            }
            val remittancesTask = async {
                db.collection("remittance")
                    .whereEqualTo("cooperative_id", session.cooperativeId)
                    .whereEqualTo("member_id", session.memberId)
                    .whereEqualTo("status", "Approved")
                    .whereEqualTo("is_deleted", 0)
                    .limit(5001)
                    .get().await().documents
            }
            val guarantorsTask = async {
                db.collection("loan_guarantors")
                    .whereEqualTo("cooperative_id", session.cooperativeId)
                    .whereEqualTo("member_id", session.memberId)
                    .whereEqualTo("is_deleted", 0)
                    .limit(200)
                    .get().await().documents
            }
            val enterprises = enterprisesTask.await().associate { doc ->
                doc.id to (doc.data ?: emptyMap())
            }
            val remittances = remittancesTask.await()
            val guarantorDocs = guarantorsTask.await()

            // Never show balances computed from an arbitrary truncated history.
            // A proper cursor-paginated canonical ledger is needed for larger accounts.
            if (remittances.size > 5000) {
                return@coroutineScope RepositoryResult.Failure(
                    "Your account history is too large to calculate safely in Spark mode. Please contact the cooperative administrator."
                )
            }

            val sortedRemittances = remittances.sortedWith(
                compareBy<DocumentSnapshot> { dateMillis(it.get("remittance_date") ?: it.get("created_at")) }
                    .thenBy { text(it.get("created_at")) }
                    .thenBy { it.id }
            )
            val accounts = linkedMapOf<String, AccountSummary>()
            val transactions = mutableListOf<MemberTransaction>()
            var runningBalance = 0L
            for (remittance in sortedRemittances) {
                val data = remittance.data ?: emptyMap()
                val date = displayDate(data["remittance_date"] ?: data["created_at"])
                val description = text(data["description"])
                val details = data["details"] as? List<*> ?: emptyList<Any>()
                for (rawDetail in details) {
                    @Suppress("UNCHECKED_CAST")
                    val detail = rawDetail as? Map<String, Any?> ?: continue
                    val accountId = text(detail["enterprise_id"]).ifBlank { text(detail["item"]) }
                    val enterprise = enterprises[accountId]
                    if (!includedDetail(detail, enterprise)) continue
                    val amount = number(detail["amount"])
                    val accountName = text(enterprise?.get("account_name")).ifBlank { "Unknown account" }
                    val previous = accounts[accountId]
                    accounts[accountId] = AccountSummary(accountId, accountName, (previous?.balance ?: 0L) + amount)
                    runningBalance += amount
                    val transactionId = text(detail["id"]).ifBlank { "${remittance.id}-$accountId" }
                    transactions += MemberTransaction(
                        id = transactionId,
                        date = date,
                        description = description,
                        accountName = accountName,
                        reference = remittance.id,
                        debit = if (amount < 0) -amount else 0L,
                        credit = if (amount > 0) amount else 0L,
                        runningBalance = runningBalance,
                        status = "Approved",
                    )
                }
            }

            val requests = mutableListOf<GuarantorRequest>()
            for (guarantorDoc in guarantorDocs) {
                val row = guarantorDoc.data ?: emptyMap()
                val loanId = text(row["loan_id"])
                val loanSnapshot = if (loanId.isBlank()) null else db.collection("loans").document(loanId).get().await()
                val loan = loanSnapshot?.data ?: emptyMap()
                val borrowerId = text(loan["member_id"])
                val borrowerSnapshot = if (borrowerId.isBlank()) null else members.document(borrowerId).get().await()
                val borrower = borrowerSnapshot?.data ?: emptyMap()
                val approval = row["guarantor_approval"]
                val status = if (approval == null) "pending" else if (truthy(approval)) "approved" else "rejected"
                val enterpriseId = text(loan["enterprise_id"])
                requests += GuarantorRequest(
                    id = guarantorDoc.id,
                    borrowerName = listOf(borrower["last_name"], borrower["first_name"])
                        .map(::text).filter(String::isNotBlank).joinToString(" ").ifBlank { "Member" },
                    loanReference = loanId,
                    loanCategory = text(enterprises[enterpriseId]?.get("account_name")).ifBlank { "Loan" },
                    principalAmount = number(loan["principal_amount"]),
                    guaranteeAmount = number(row["guarantee_amount"]),
                    status = status,
                    requestedAt = displayDate(row["created_at"]),
                )
            }

            val advice = (memberData["payment_advise"] as? List<*>)?.mapNotNull { raw ->
                @Suppress("UNCHECKED_CAST")
                val row = raw as? Map<String, Any?> ?: return@mapNotNull null
                val enterpriseId = text(row["enterprise_id"])
                PaymentAdviceItem(
                    id = text(row["id"]).ifBlank { "${session.memberId}-$enterpriseId" },
                    enterpriseId = enterpriseId,
                    name = text(enterprises[enterpriseId]?.get("account_name")).ifBlank { enterpriseId },
                    amount = number(row["amount"]),
                    automatic = text(enterprises[enterpriseId]?.get("account_type")).equals("loan", ignoreCase = true),
                )
            }.orEmpty()

            RepositoryResult.Success(
                MemberSnapshot(
                    session = session,
                    accounts = accounts.values.sortedBy { it.name.lowercase(Locale.US) },
                    recentTransactions = transactions.takeLast(30).asReversed(),
                    guarantorRequests = requests,
                    paymentAdvice = advice,
                    refreshedAt = isoNow(),
                )
            )
        }
    } catch (error: Exception) {
        RepositoryResult.Failure(error.message ?: "Unable to refresh member data. Check your connection and try again.", error)
    }

    override suspend fun decideGuarantor(
        session: MemberSession,
        requestId: String,
        accept: Boolean,
    ): RepositoryResult<Unit> {
        return try {
        if (requestId.isBlank()) return RepositoryResult.Failure("A guarantor request is required.")
        val ref = db.collection("loan_guarantors").document(requestId)
        val now = isoNow()
        db.runTransaction { transaction ->
            val snapshot = transaction.get(ref)
            if (!snapshot.exists()) throw IllegalStateException("Guarantor request was not found.")
            val row = snapshot.data ?: emptyMap()
            if (text(row["cooperative_id"]) != session.cooperativeId || text(row["member_id"]) != session.memberId) {
                throw SecurityException("This request is not assigned to the current member.")
            }
            if (row["guarantor_approval"] != null) {
                throw IllegalStateException("This guarantor request has already been decided.")
            }
            transaction.update(ref, mapOf(
                "guarantor_approval" to if (accept) 1 else 0,
                "approved_at" to if (accept) now else (row["approved_at"] ?: ""),
                "modified_at" to now,
                "modified_by" to session.memberId,
            ))
            true
        }.await()
        RepositoryResult.Success(Unit)
    } catch (error: Exception) {
        RepositoryResult.Failure(error.message ?: "Unable to record guarantor decision.", error)
    }
    }

    override suspend fun updatePaymentAdvice(
        session: MemberSession,
        advice: List<PaymentAdviceItem>,
    ): RepositoryResult<Unit> {
        return try {
        val memberRef = members.document(session.memberId)
        val memberSnapshot = memberRef.get().await()
        if (!memberSnapshot.exists() || !isActiveMember(memberSnapshot.data ?: emptyMap(), session.cooperativeId)) {
            return RepositoryResult.Failure("Member account is unavailable.")
        }
        val enterpriseDocs = db.collection("enterprise")
            .whereEqualTo("cooperative_id", session.cooperativeId)
            .whereEqualTo("is_deleted", 0)
            .get().await().documents
        val enterprises = enterpriseDocs.associate { it.id to (it.data ?: emptyMap()) }
        val loanDocs = db.collection("loans")
            .whereEqualTo("cooperative_id", session.cooperativeId)
            .whereEqualTo("member_id", session.memberId)
            .whereEqualTo("is_deleted", 0)
            .get().await().documents
        val loanEnterpriseIds = loanDocs.mapNotNull { loan ->
            val status = text(loan.get("status")).lowercase(Locale.US)
            if (status in setOf("declined", "rejected", "cancelled")) null else text(loan.get("enterprise_id")).takeIf { it.isNotBlank() }
        }.toSet()
        val previous = memberSnapshot.get("payment_advise") as? List<*> ?: emptyList<Any>()
        val previousByEnterprise = previous.mapNotNull { raw ->
            @Suppress("UNCHECKED_CAST")
            val row = raw as? Map<String, Any?> ?: return@mapNotNull null
            text(row["enterprise_id"]).takeIf(String::isNotBlank)?.let { it to row }
        }.toMap()
        val seen = mutableSetOf<String>()
        val next = mutableListOf<Map<String, Any?>>()
        for (item in advice) {
            val enterpriseId = item.enterpriseId.trim()
            if (enterpriseId.isBlank() || !seen.add(enterpriseId)) continue
            val enterprise = enterprises[enterpriseId]
                ?: return RepositoryResult.Failure("Payment advice contains an unknown enterprise.")
            val amount = item.amount
            if (amount < 0 || amount > 100_000_000L) {
                return RepositoryResult.Failure("Payment advice amount is invalid.")
            }
            val prior = previousByEnterprise[enterpriseId]
            val isLoan = enterpriseId in loanEnterpriseIds || text(enterprise["account_type"]).equals("loan", ignoreCase = true)
            if (isLoan && prior != null && number(prior["amount"]) != amount) {
                return RepositoryResult.Failure("Loan payment advice is automatic and cannot be edited.")
            }
            if (!isLoan && amount > 0) {
                val roundedAmount = ((amount + 99L) / 100L) * 100L
                next += mapOf(
                    "id" to item.id.ifBlank { "${session.cooperativeId}-${session.memberId}-$enterpriseId" },
                    "enterprise_id" to enterpriseId,
                    "amount" to roundedAmount,
                    "created_at" to text(prior?.get("created_at")).ifBlank { isoNow() },
                )
            } else if (isLoan && prior != null) {
                next += prior
            }
        }
        for ((enterpriseId, prior) in previousByEnterprise) {
            if (enterpriseId in loanEnterpriseIds && enterpriseId !in seen) next += prior
        }
        memberRef.update(mapOf(
            "payment_advise" to next,
            "modified_at" to isoNow(),
            "modified_by" to session.memberId,
        )).await()
        RepositoryResult.Success(Unit)
    } catch (error: Exception) {
        RepositoryResult.Failure(error.message ?: "Unable to update payment advice.", error)
    }
    }

    override suspend fun changePassword(
        session: MemberSession,
        currentPin: String,
        newPin: String,
        firstLogin: Boolean,
    ): RepositoryResult<Unit> {
        return try {
        if (!newPin.matches(Regex("^\\d{6}$"))) {
            return RepositoryResult.Failure("The new PIN must contain exactly six digits.")
        }
        if (newPin == "123456") {
            return RepositoryResult.Failure("Choose a new PIN other than the temporary PIN 123456.")
        }
        if (firstLogin && !session.requiresPinChange) {
            return RepositoryResult.Failure("A first-login PIN change is not pending.")
        }
        val memberRef = members.document(session.memberId)
        val snapshot = memberRef.get().await()
        if (!snapshot.exists() || !isActiveMember(snapshot.data ?: emptyMap(), session.cooperativeId)) {
            return RepositoryResult.Failure("Member account is unavailable.")
        }
        val stored = text(snapshot.get("password_hash"))
        if (stored != sha256(currentPin) && stored != currentPin) {
            return RepositoryResult.Failure("Current PIN is incorrect.")
        }
        val now = isoNow()
        val updates = mutableMapOf<String, Any>(
            "password_hash" to sha256(newPin),
            "force_password_change" to false,
            "modified_at" to now,
            "modified_by" to session.memberId,
        )
        if (firstLogin) {
            updates["last_login"] = now
            updates["login_count"] = FieldValue.increment(1)
            updates["sync_at"] = now
        }
        memberRef.update(updates).await()
        RepositoryResult.Success(Unit)
    } catch (error: Exception) {
        RepositoryResult.Failure(error.message ?: "Unable to change the PIN.", error)
    }
    }

    override suspend fun signOut() {
        // Member mode has no server-issued Auth credential in Spark mode. Clear
        // any Firebase Auth state left by an earlier build as a precaution.
        auth.signOut()
    }
}
