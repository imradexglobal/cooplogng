package com.imradexglobal.cooplogng.ui

import android.content.Intent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.imradexglobal.cooplogng.data.MemberRepository
import com.imradexglobal.cooplogng.data.MemberSession
import com.imradexglobal.cooplogng.data.MemberSnapshot
import com.imradexglobal.cooplogng.data.CooperativeOption
import com.imradexglobal.cooplogng.data.RepositoryResult
import com.imradexglobal.cooplogng.data.FirebaseMemberRepository
import com.imradexglobal.cooplogng.data.PaymentAdviceItem
import com.imradexglobal.cooplogng.data.StatementPdfExporter
import androidx.core.content.FileProvider
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

private enum class AppTab(val label: String, val glyph: String) {
    Home("Home", "⌂"), Transactions("Activity", "↕"), Ledger("Ledger", "▤"), Guarantors("Guarantees", "✓"), Advice("Advice", "₦"), Profile("Profile", "●")
}

private enum class LoginStage { Identifier, Cooperative, Pin, Recovery }

@Composable
fun CoopLogNgApp(repository: MemberRepository = remember { FirebaseMemberRepository() }) {
    var session by remember { mutableStateOf<MemberSession?>(null) }
    var forcedPinSession by remember { mutableStateOf<MemberSession?>(null) }
    var firstLoginPin by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val pendingPinChange = forcedPinSession
    if (pendingPinChange != null) {
        FirstLoginPinScreen(
            session = pendingPinChange,
            currentPin = firstLoginPin,
            repository = repository,
            onComplete = {
                session = pendingPinChange.copy(requiresPinChange = false)
                forcedPinSession = null
                firstLoginPin = ""
            },
            onCancel = {
                scope.launch {
                    repository.signOut()
                    forcedPinSession = null
                    firstLoginPin = ""
                }
            },
        )
        return
    }
    if (session == null) {
        SignInScreen(repository = repository, onSignedIn = { signedInSession, pin ->
            if (signedInSession.requiresPinChange) {
                forcedPinSession = signedInSession
                firstLoginPin = pin
            } else {
                session = signedInSession
            }
        })
        return
    }
    MemberShell(session = session!!, repository = repository, onSignOut = {
        scope.launch {
            repository.signOut()
            session = null
        }
    })
}

@Composable
private fun SignInScreen(repository: MemberRepository, onSignedIn: (MemberSession, String) -> Unit) {
    val scope = rememberCoroutineScope()
    var stage by remember { mutableStateOf(LoginStage.Identifier) }
    var identifier by remember { mutableStateOf("") }
    var cooperatives by remember { mutableStateOf<List<CooperativeOption>>(emptyList()) }
    var selectedCooperativeId by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }

    fun findCooperatives() {
        if (identifier.isBlank() || loading) {
            if (identifier.isBlank()) message = "Enter your mobile number, email or member ID."
            return
        }
        loading = true
        message = ""
        scope.launch {
            when (val result = repository.discoverCooperatives(identifier.trim())) {
                is RepositoryResult.Success -> {
                    cooperatives = result.value
                    if (result.value.isEmpty()) {
                        message = "No matching member was found. Check your details or contact your cooperative administrator."
                    } else if (result.value.size == 1) {
                        selectedCooperativeId = result.value.single().id
                        stage = LoginStage.Pin
                    } else {
                        selectedCooperativeId = ""
                        stage = LoginStage.Cooperative
                    }
                }
                is RepositoryResult.Failure -> message = result.message
            }
            loading = false
        }
    }

    fun submitPin() {
        if (pin.isBlank()) {
            message = "Enter your PIN or temporary password."
            return
        }
        val cooperativeId = selectedCooperativeId
        if (cooperativeId.isBlank() || loading) return
        loading = true
        message = ""
        scope.launch {
            val submittedPin = pin.trim()
            when (val result = repository.signIn(identifier.trim(), submittedPin, cooperativeId)) {
                is RepositoryResult.Success -> onSignedIn(result.value, submittedPin)
                is RepositoryResult.Failure -> message = result.message
            }
            loading = false
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("CoopLogNg", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Text("Your cooperative, clearly.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(32.dp))
            if (stage != LoginStage.Recovery) {
                val step = when (stage) {
                    LoginStage.Identifier -> "Step 1 of 3 · Identify yourself"
                    LoginStage.Cooperative -> "Step 2 of 3 · Select cooperative"
                    LoginStage.Pin -> "Step 3 of 3 · Enter your PIN"
                    LoginStage.Recovery -> ""
                }
                Text(step, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 18.dp, bottom = 10.dp))
            } else {
                Text("PIN recovery", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 18.dp))
            }

            when (stage) {
                LoginStage.Identifier -> {
                    Text("Welcome back", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text("Enter the details linked to your membership.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 14.dp))
                    OutlinedTextField(
                        value = identifier,
                        onValueChange = { identifier = it; message = "" },
                        label = { Text("Mobile, email, registration or special ID") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (identifier.isNotBlank()) {
                        val detected = when {
                            identifier.contains("@") -> "Email"
                            identifier.all(Char::isDigit) && identifier.length >= 10 -> "Mobile"
                            identifier.all(Char::isDigit) -> "Registration number"
                            else -> "Special ID / registration number"
                        }
                        Text("Detected: $detected", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.Start).padding(top = 4.dp))
                    }
                    Button(onClick = ::findCooperatives, enabled = !loading, modifier = Modifier.fillMaxWidth().padding(top = 20.dp)) {
                        if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Next")
                    }
                }
                LoginStage.Cooperative -> {
                    Text("Select Cooperative", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text("More than one cooperative is linked to ${identifier.trim()}.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 12.dp))
                    cooperatives.forEach { cooperative ->
                        Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                                RadioButton(selected = selectedCooperativeId == cooperative.id, onClick = { selectedCooperativeId = cooperative.id })
                                Column(Modifier.padding(vertical = 10.dp)) {
                                    Text(cooperative.name, fontWeight = FontWeight.SemiBold)
                                    Text("ID: ${cooperative.id}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
                        OutlinedButton(onClick = { stage = LoginStage.Identifier; message = "" }, modifier = Modifier.weight(1f)) { Text("Back") }
                        Button(onClick = { if (selectedCooperativeId.isBlank()) message = "Select a cooperative to continue." else { stage = LoginStage.Pin; message = "" } }, enabled = !loading, modifier = Modifier.weight(1f)) { Text("Next") }
                    }
                }
                LoginStage.Pin -> {
                    val cooperativeName = cooperatives.firstOrNull { it.id == selectedCooperativeId }?.name ?: selectedCooperativeId
                    Text("Enter Password", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Card(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                        Column(Modifier.padding(14.dp)) {
                            Text("Logging in as", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(identifier.trim(), fontWeight = FontWeight.SemiBold)
                            Text("→ $cooperativeName", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    OutlinedTextField(
                        value = pin,
                        onValueChange = { pin = it.take(64); message = "" },
                        label = { Text("PIN or temporary password") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    TextButton(onClick = { stage = LoginStage.Recovery; message = "" }, modifier = Modifier.align(Alignment.End)) { Text("Forgot PIN?") }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                        OutlinedButton(onClick = {
                            stage = if (cooperatives.size > 1) LoginStage.Cooperative else LoginStage.Identifier
                            pin = ""
                            message = ""
                        }, modifier = Modifier.weight(1f)) { Text("Back") }
                        Button(onClick = ::submitPin, enabled = !loading, modifier = Modifier.weight(1f)) {
                            if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Sign in")
                        }
                    }
                }
                LoginStage.Recovery -> {
                    val cooperativeName = cooperatives.firstOrNull { it.id == selectedCooperativeId }?.name ?: selectedCooperativeId
                    Text("Forgot your PIN?", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text(
                        "For security, PIN resets are handled by your cooperative administrator. Contact ${cooperativeName.ifBlank { "your cooperative administrator" }} and ask for a temporary member PIN. After you sign in with it, the app will require you to choose a new six-digit PIN before showing your account.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 14.dp),
                    )
                    Button(onClick = { stage = LoginStage.Pin; message = "" }, modifier = Modifier.fillMaxWidth()) { Text("Back to sign in") }
                }
            }

            if (message.isNotEmpty()) Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 14.dp))
            Text("Spark-plan mode reads member records directly from Firestore and verifies the PIN in this app. Current rules do not enforce member-only access; do not use with production financial data until security is upgraded.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 24.dp))
        }
    }
}

@Composable
private fun FirstLoginPinScreen(
    session: MemberSession,
    currentPin: String,
    repository: MemberRepository,
    onComplete: () -> Unit,
    onCancel: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var newPin by remember(session.memberId) { mutableStateOf("") }
    var confirmPin by remember(session.memberId) { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("CoopLogNg", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(24.dp))
            Text("Set Your 6-Digit PIN", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("Your account is using a temporary or legacy credential. Set a new numeric PIN to continue.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
            OutlinedTextField(
                value = newPin,
                onValueChange = { newPin = it.filter(Char::isDigit).take(6); message = "" },
                label = { Text("New 6-digit PIN") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = confirmPin,
                onValueChange = { confirmPin = it.filter(Char::isDigit).take(6); message = "" },
                label = { Text("Confirm new PIN") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            )
            Text("Use exactly six digits. Do not reuse the temporary PIN 123456.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.Start).padding(top = 8.dp))
            Button(
                enabled = !saving && newPin.length == 6 && confirmPin.length == 6,
                onClick = {
                    if (newPin != confirmPin) {
                        message = "The new PINs do not match."
                    } else if (newPin == "123456") {
                        message = "Choose a new PIN other than the temporary PIN."
                    } else {
                        saving = true
                        message = ""
                        scope.launch {
                            when (val result = repository.changePassword(session, currentPin, newPin, firstLogin = true)) {
                                is RepositoryResult.Success -> onComplete()
                                is RepositoryResult.Failure -> message = result.message
                            }
                            saving = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
            ) { Text(if (saving) "Setting PIN…" else "Set PIN & continue") }
            TextButton(onClick = onCancel, enabled = !saving, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
            if (message.isNotBlank()) Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun MemberShell(session: MemberSession, repository: MemberRepository, onSignOut: () -> Unit) {
    var tab by remember { mutableStateOf(AppTab.Home) }
    var snapshot by remember(session.memberId) { mutableStateOf<MemberSnapshot?>(null) }
    var refreshMessage by remember(session.memberId) { mutableStateOf("") }
    LaunchedEffect(session.memberId) {
        when (val result = repository.loadSnapshot(session, forceRefresh = true)) {
            is RepositoryResult.Success -> snapshot = result.value
            is RepositoryResult.Failure -> refreshMessage = result.message
        }
    }
    Scaffold(bottomBar = {
        NavigationBar { AppTab.entries.forEach { item -> NavigationBarItem(selected = tab == item, onClick = { tab = item }, icon = { Text(item.glyph) }, label = { Text(item.label) }) } }
    }) { padding ->
        when (tab) {
            AppTab.Home -> DashboardScreen(session, snapshot, refreshMessage, padding)
            AppTab.Transactions -> TransactionsScreen(snapshot, session, padding)
            AppTab.Ledger -> LedgerScreen(snapshot, padding)
            AppTab.Guarantors -> GuarantorsScreen(snapshot, repository, session, padding)
            AppTab.Advice -> PaymentAdviceScreen(snapshot, repository, session, padding)
            AppTab.Profile -> ProfileScreen(session, repository, onSignOut, padding)
        }
    }
}

@Composable
private fun DashboardScreen(session: MemberSession, snapshot: MemberSnapshot?, refreshMessage: String, padding: PaddingValues) {
    LazyColumn(contentPadding = padding, modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Spacer(Modifier.height(12.dp)); Text("Good morning", color = MaterialTheme.colorScheme.onSurfaceVariant); Text(session.displayName, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
        item { SecureDataCard(snapshot) }
        item { Text("Your accounts", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
        if (snapshot == null) item { EmptyState(refreshMessage.ifBlank { "Refreshing approved account data…" }) }
        items(snapshot?.accounts.orEmpty(), key = { it.id }) { account -> AccountRow(account.name, account.balance) }
        item { Text("Recent activity", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
        if (snapshot?.recentTransactions.isNullOrEmpty()) item { EmptyState("No approved activity was returned.") }
        items(snapshot?.recentTransactions?.take(5).orEmpty(), key = { it.id }) { transaction -> TransactionRow(transaction.description, transaction.credit - transaction.debit, transaction.status) }
    }
}

@Composable
private fun TransactionsScreen(snapshot: MemberSnapshot?, session: MemberSession, padding: PaddingValues) {
    val context = LocalContext.current
    LazyColumn(contentPadding = padding, modifier = Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Recent transactions", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Text("Only approved member-scoped transactions are shown.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp)); Button(enabled = snapshot != null, onClick = { snapshot?.let { data -> val file = StatementPdfExporter.write(context, session, data); val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file); context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "application/pdf"; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }, "Share statement")) } }, modifier = Modifier.fillMaxWidth()) { Text("Export statement PDF") } }
        if (snapshot?.recentTransactions.isNullOrEmpty()) item { EmptyState("No approved transactions available.") }
        items(snapshot?.recentTransactions.orEmpty(), key = { it.id }) { transaction -> TransactionRow(transaction.description, transaction.credit - transaction.debit, transaction.status) }
    }
}

@Composable
private fun LedgerScreen(snapshot: MemberSnapshot?, padding: PaddingValues) {
    var selected by remember { mutableStateOf("All accounts") }
    LazyColumn(contentPadding = padding, modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        item { Spacer(Modifier.height(20.dp)); Text("Financial ledger", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Text("Opening balances and running balances come from the complete approved ledger.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 16.dp)) }
        item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("All accounts", "Savings", "Shares").forEach { FilterChip(selected == it, { selected = it }, label = { Text(it) }) } } }
        if (snapshot?.recentTransactions.isNullOrEmpty()) item { EmptyState("No ledger data available.") }
        items(snapshot?.recentTransactions.orEmpty(), key = { it.id }) { transaction -> TransactionRow(transaction.accountName, transaction.runningBalance, transaction.status) }
    }
}

@Composable
private fun GuarantorsScreen(snapshot: MemberSnapshot?, repository: MemberRepository, session: MemberSession, padding: PaddingValues) {
    val scope = rememberCoroutineScope()
    var actionMessage by remember { mutableStateOf("") }
    var busyId by remember { mutableStateOf<String?>(null) }
    LazyColumn(contentPadding = padding, modifier = Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Guarantees", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Text("Requests assigned to your member account.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp)) }
        if (actionMessage.isNotBlank()) item { Text(actionMessage, color = MaterialTheme.colorScheme.error) }
        if (snapshot?.guarantorRequests.isNullOrEmpty()) item { EmptyState("No guarantor requests available.") }
        items(snapshot?.guarantorRequests.orEmpty(), key = { it.id }) { request -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(request.borrowerName, fontWeight = FontWeight.Bold); Text("${request.loanCategory} · ${request.status}", color = MaterialTheme.colorScheme.onSurfaceVariant); Text("Guarantee: ${request.guaranteeAmount}"); if (request.status == "pending") Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) { Button(enabled = busyId == null, onClick = { busyId = request.id; scope.launch { when (val result = repository.decideGuarantor(session, request.id, true)) { is RepositoryResult.Success -> actionMessage = "Decision recorded. Refresh the page to confirm status."; is RepositoryResult.Failure -> actionMessage = result.message }; busyId = null } }) { Text("Accept") }; OutlinedButton(enabled = busyId == null, onClick = { busyId = request.id; scope.launch { when (val result = repository.decideGuarantor(session, request.id, false)) { is RepositoryResult.Success -> actionMessage = "Decision recorded. Refresh the page to confirm status."; is RepositoryResult.Failure -> actionMessage = result.message }; busyId = null } }) { Text("Decline") } } } } }
    }
}

@Composable
private fun PaymentAdviceScreen(snapshot: MemberSnapshot?, repository: MemberRepository, session: MemberSession, padding: PaddingValues) {
    val scope = rememberCoroutineScope()
    var amounts by remember(snapshot) { mutableStateOf(snapshot?.paymentAdvice?.associate { it.enterpriseId to it.amount }.orEmpty()) }
    var message by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Payment advice", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Set your monthly commitment. Loan advice is automatic and cannot be edited here.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (snapshot == null) EmptyState("Payment advice is loading securely.")
        snapshot?.paymentAdvice.orEmpty().forEach { item ->
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp)) { Text(item.name, fontWeight = FontWeight.SemiBold); OutlinedTextField(value = (amounts[item.enterpriseId] ?: item.amount).toString(), onValueChange = { raw -> amounts = amounts + (item.enterpriseId to (raw.filter(Char::isDigit).toLongOrNull() ?: 0L)) }, enabled = !item.automatic, label = { Text(if (item.automatic) "Automatic loan advice" else "Monthly amount") }, modifier = Modifier.fillMaxWidth()) } }
        }
        Button(enabled = !saving && snapshot != null, onClick = { saving = true; message = ""; scope.launch { val advice = snapshot?.paymentAdvice.orEmpty().map { item -> PaymentAdviceItem(item.id, item.enterpriseId, item.name, amounts[item.enterpriseId] ?: item.amount, item.automatic) }; when (val result = repository.updatePaymentAdvice(session, advice)) { is RepositoryResult.Success -> message = "Payment advice saved securely."; is RepositoryResult.Failure -> message = result.message }; saving = false } }, modifier = Modifier.fillMaxWidth()) { Text(if (saving) "Saving…" else "Save advice") }
        if (message.isNotBlank()) Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ProfileScreen(session: MemberSession, repository: MemberRepository, onSignOut: () -> Unit, padding: PaddingValues) {
    val scope = rememberCoroutineScope()
    var showPasswordForm by remember { mutableStateOf(false) }
    var currentPin by remember { mutableStateOf("") }
    var newPin by remember { mutableStateOf("") }
    var passwordMessage by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Profile", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(session.displayName, fontWeight = FontWeight.Bold); Text(session.cooperativeName, color = MaterialTheme.colorScheme.onSurfaceVariant); session.registrationNumber?.let { Text("Membership: $it") } } }
        OutlinedButton(onClick = { showPasswordForm = !showPasswordForm }, modifier = Modifier.fillMaxWidth()) { Text("Change PIN") }
        if (showPasswordForm) {
            OutlinedTextField(currentPin, { currentPin = it }, label = { Text("Current PIN") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(newPin, { newPin = it }, label = { Text("New six-digit PIN") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            Button(enabled = !saving, onClick = { saving = true; passwordMessage = ""; scope.launch { when (val result = repository.changePassword(session, currentPin, newPin)) { is RepositoryResult.Success -> { passwordMessage = "PIN changed successfully."; currentPin = ""; newPin = "" }; is RepositoryResult.Failure -> passwordMessage = result.message }; saving = false } }, modifier = Modifier.fillMaxWidth()) { Text(if (saving) "Saving…" else "Save new PIN") }
            if (passwordMessage.isNotBlank()) Text(passwordMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
    }
}

@Composable
private fun SecureDataCard(snapshot: MemberSnapshot?) { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(18.dp)) { Text("Account overview", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold); Text(if (snapshot == null) "Refreshing approved balances…" else formatAmount(snapshot.accounts.sumOf { it.balance }), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 8.dp)); Text(if (snapshot == null) "Financial data is being refreshed securely." else "Approved member balance", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp)) } } }

@Composable
private fun AccountRow(name: String, amount: Long) { Card(Modifier.fillMaxWidth()) { Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.SpaceBetween) { Text(name, fontWeight = FontWeight.SemiBold); Text(formatAmount(amount), fontWeight = FontWeight.Bold) } } }

@Composable
private fun TransactionRow(description: String, amount: Long, status: String) { Card(Modifier.fillMaxWidth()) { Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) { Column(Modifier.weight(1f)) { Text(description.ifBlank { "Account activity" }, fontWeight = FontWeight.SemiBold); Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }; Text(formatAmount(amount), fontWeight = FontWeight.Bold) } } }

private fun formatAmount(value: Long): String = NumberFormat.getCurrencyInstance(Locale("en", "NG")).format(value)

@Composable
private fun EmptyPage(title: String, body: String, padding: PaddingValues) { Column(Modifier.fillMaxSize().padding(padding).padding(20.dp)) { Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)); EmptyState("Secure member data is not available in this build.") } }

@Composable
private fun EmptyState(message: String) { Card(Modifier.fillMaxWidth()) { Box(Modifier.fillMaxWidth().padding(22.dp), contentAlignment = Alignment.Center) { Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
