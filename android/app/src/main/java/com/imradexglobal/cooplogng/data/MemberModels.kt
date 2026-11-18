package com.imradexglobal.cooplogng.data

/**
 * Member context used by the app UI. In temporary Spark compatibility mode it
 * is created client-side and is not a trusted authorization credential.
 */
data class MemberSession(
    val memberId: String,
    val cooperativeId: String,
    val cooperativeName: String,
    val displayName: String,
    val registrationNumber: String? = null,
    val requiresPinChange: Boolean = false,
)

data class CooperativeOption(
    val id: String,
    val name: String,
)

data class AccountSummary(
    val id: String,
    val name: String,
    val balance: Long,
)

data class MemberTransaction(
    val id: String,
    val date: String,
    val description: String,
    val accountName: String,
    val reference: String,
    val debit: Long,
    val credit: Long,
    val runningBalance: Long,
    val status: String,
)

data class GuarantorRequest(
    val id: String,
    val borrowerName: String,
    val loanReference: String,
    val loanCategory: String,
    val principalAmount: Long,
    val guaranteeAmount: Long,
    val status: String,
    val requestedAt: String,
)

data class PaymentAdviceItem(
    val id: String,
    val enterpriseId: String,
    val name: String,
    val amount: Long,
    val automatic: Boolean = false,
)

data class MemberSnapshot(
    val session: MemberSession,
    val accounts: List<AccountSummary>,
    val recentTransactions: List<MemberTransaction>,
    val guarantorRequests: List<GuarantorRequest>,
    val paymentAdvice: List<PaymentAdviceItem>,
    val refreshedAt: String,
)

sealed interface RepositoryResult<out T> {
    data class Success<T>(val value: T) : RepositoryResult<T>
    data class Failure(val message: String, val cause: Throwable? = null) : RepositoryResult<Nothing>
}

interface MemberRepository {
    suspend fun discoverCooperatives(identifier: String): RepositoryResult<List<CooperativeOption>>
    suspend fun signIn(identifier: String, pin: String, cooperativeId: String): RepositoryResult<MemberSession>
    suspend fun loadSnapshot(session: MemberSession, forceRefresh: Boolean = false): RepositoryResult<MemberSnapshot>
    suspend fun decideGuarantor(session: MemberSession, requestId: String, accept: Boolean): RepositoryResult<Unit>
    suspend fun updatePaymentAdvice(session: MemberSession, advice: List<PaymentAdviceItem>): RepositoryResult<Unit>
    suspend fun changePassword(session: MemberSession, currentPin: String, newPin: String, firstLogin: Boolean = false): RepositoryResult<Unit>
    suspend fun signOut()
}
