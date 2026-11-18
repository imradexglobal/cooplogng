package com.imradexglobal.cooplogng.data

/**
 * Deliberately fail-closed until a trusted CoopLogNg member API or Firebase
 * Auth/custom-token boundary is configured. Direct client-side password-hash
 * verification and public Firestore reads are not acceptable for production.
 */
class CoopLogNgRepository : MemberRepository {
    private val unavailable = RepositoryResult.Failure(
        "Secure member services are not configured on this build. Contact the cooperative administrator."
    )

    override suspend fun discoverCooperatives(identifier: String): RepositoryResult<List<CooperativeOption>> = unavailable

    override suspend fun signIn(identifier: String, pin: String, cooperativeId: String): RepositoryResult<MemberSession> = unavailable

    override suspend fun loadSnapshot(session: MemberSession, forceRefresh: Boolean): RepositoryResult<MemberSnapshot> = unavailable

    override suspend fun decideGuarantor(session: MemberSession, requestId: String, accept: Boolean): RepositoryResult<Unit> = unavailable

    override suspend fun updatePaymentAdvice(session: MemberSession, advice: List<PaymentAdviceItem>): RepositoryResult<Unit> = unavailable

    override suspend fun changePassword(session: MemberSession, currentPin: String, newPin: String, firstLogin: Boolean): RepositoryResult<Unit> = unavailable

    override suspend fun signOut() = Unit
}
