import { hasPermission } from '../services/permissionService.js'
import { loadSavedSession, restoreSessionFromIndexedDB } from '../services/offlineAuthService.js'
import { loadRememberedIdentity } from '../services/rememberMeService.js'
import { DEFAULT_MEMBER_FIELDS } from '../services/reports/memberFields.js'

function getDefaultTab(user) {
  if (!user) return 'dashboard';
  const order = ['dashboard', 'ledger', 'advice', 'payments', 'members', 'reports', 'reconciliation', 'settings'];
  const isMember = user.role === 'member';
  const can = (tab) => {
    switch (tab) {
      case 'dashboard': return isMember || hasPermission(user.permissions, 'dashboard_view');
      case 'ledger': return isMember || hasPermission(user.permissions, 'read_ledger') || hasPermission(user.permissions, 'read_coop_ledger');
      case 'advice': return isMember;
      case 'payments': return !!user && user.role !== 'member';
      case 'members': return !isMember && hasPermission(user.permissions, 'read_member');
      case 'reports': return !isMember && hasPermission(user.permissions, 'read_member');
      case 'reconciliation': return hasPermission(user.permissions, 'read_reconcile');
      case 'settings': return isMember || hasPermission(user.permissions, 'settings_manage');
      default: return false;
    }
  };
  for (const tab of order) {
    if (can(tab)) return tab;
  }
  return 'dashboard';
}

const savedSession = loadSavedSession();

// Global "Remember me": pre-fill the last remembered username on cold start.
const rememberedIdentity = loadRememberedIdentity();

// If sessionStorage was cleared (e.g. after Chrome crash), try IndexedDB async
if (!savedSession) {
  restoreSessionFromIndexedDB().then(session => {
    if (session) {
      // Session restored from IndexedDB into sessionStorage; reload to pick it up.
      // Guarded to once per tab session AND verified readable — otherwise a
      // session that fails loadSavedSession() validation would F5 forever.
      try {
        if (sessionStorage.getItem('cooplog-restore-reloaded')) return
        if (!loadSavedSession()) return
        sessionStorage.setItem('cooplog-restore-reloaded', '1')
      } catch { return }
      window.location.reload()
    }
  }).catch(() => {})
}

const state = {
  isOnline: navigator.onLine,
  stage: 1,
  username: rememberedIdentity?.username || '',
  rememberMe: !!rememberedIdentity,
  password: rememberedIdentity?.password || '',
  selectedCooperativeId: rememberedIdentity?.cooperativeId || '',
  cooperatives: (rememberedIdentity?.cooperativeId ? [{ id: rememberedIdentity.cooperativeId, name: rememberedIdentity.cooperativeName || rememberedIdentity.cooperativeId }] : []),
  isSubmitting: false,
  isSyncing: false,
  showPassword: false,
  errorMessage: '',
  welcomeUser: savedSession,
  activeTab: savedSession?.activeTab || getDefaultTab(savedSession),
  selectedMemberId: null,
  editingRemittance: null,
  editingRemittanceId: null,
  members: [],
  isRegistering: false,
  coopSearchQuery: '',
  googleLinkEmail: '',
  googleLinkVerified: false,
  googleLinkMobile: '',
  googleLinkFirst: '',
  googleLinkLast: '',
  googleLinkCoops: [],
  googleLinkSelectedCoop: '',
  showActivationKeyPrompt: false,
  activationKeyInput: '',
  activationKeyError: '',
  modal: {
    isOpen: false,
    title: '',
    content: '',
    type: null,
    data: null
  },
  loanRequest: {
    step: 1,
    enterpriseId: '',
    amount: 0,
    duration: 1,
    guarantors: [],
    bankDetails: {
      bankName: '',
      accountName: '',
      accountNumber: ''
    }
  },
  reports: {
    type: '',
    filters: {},
    selectedFields: DEFAULT_MEMBER_FIELDS,
    currentReportData: null
  },
}

export { state, savedSession, getDefaultTab }
