import { escapeHtml, formatDate, formatDateTime, getInitials, getAvatarColor } from '../../utils/formatters.js'
import { enterpriseList } from './membersState.js'
import { archiveMember } from '../../services/dataService.js'
import { hasPermission } from '../../services/permissionService.js'
import { getRemittances, checkMemberHasRemittances } from '../../services/sqliteService.js'
import { showToast } from '../../services/toastService.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const EMPTY_VALUES = new Set(['', 'n/a', 'null', 'undefined', 'not available', 'none', '-'])

// Avatar colors shared via utils/formatters.js:getAvatarColor
function isMeaningful(val) {
    if (val === null || val === undefined) return false
    const s = String(val).trim()
    return s.length > 0 && !EMPTY_VALUES.has(s.toLowerCase())
}

function fieldRow(label, value, opts = {}) {
    if (!isMeaningful(value)) return ''
    const display = opts.raw ? value : escapeHtml(String(value).trim())
    return `
      <div class="md-field">
        <div class="md-label">${escapeHtml(label)}</div>
        <div class="md-value">${display}</div>
      </div>
    `
}

function section(title, iconSvg, fieldsHtml) {
    if (!fieldsHtml || !fieldsHtml.trim()) return ''
    return `
      <div class="md-section">
        <div class="md-section-header">
          <span class="md-section-icon">${iconSvg}</span>
          <span class="md-section-title">${escapeHtml(title)}</span>
        </div>
        <div class="md-section-body">
          ${fieldsHtml}
        </div>
      </div>
    `
}

// ─── Icon SVGs ────────────────────────────────────────────────────────────
const ICONS = {
    personal:    `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`,
    membership:  `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 9a6 6 0 11-12 0 6 6 0 0112 0zM3 20a6 6 0 016-6 6 6 0 016 6"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 11h4m-2-2v4"/></svg>`,
    contact:     `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>`,
    employment:  `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`,
    nok:         `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
    bank:        `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`,
}

// ─── Main Modal ──────────────────────────────────────────────────────────────

export async function renderMemberModal(m, user) {
    const isAdmin = hasPermission(user.permissions, 'admin') || user.username?.toLowerCase() === 'admin'
    const canUpdate = isAdmin || hasPermission(user.permissions, 'update_member')
    const canDelete = isAdmin || hasPermission(user.permissions, 'delete_member')
    const canEditThis = canUpdate && (isAdmin || (m.account_manager || '').includes(user.username))
    
    // SAFE DELETE RULE: Check if member has remittance records
    let hasRemittances = false
    try {
        hasRemittances = await checkMemberHasRemittances(user.cooperativeId, m.id)
    } catch (err) {
        console.error('Failed to verify remittances for safe delete', err)
        hasRemittances = true // Default to unsafe on error
    }

    const existingModal = document.getElementById('member-details-modal')
    if (existingModal) existingModal.remove()

    const padRegNo = String(m.registration_no || '').padStart(4, '0')

    // ── Avatar HTML ──────────────────────────────────────────────────────────
    const avatarHtml = m.image_path
        ? `<img id="md-avatar-img" src="${m.image_path}" alt="${escapeHtml(m.name)}" style="width:100%;height:100%;object-fit:cover;">`
        : `<span style="color:#fff;font-weight:800;font-size:2.2rem;letter-spacing:0.04em;text-transform:uppercase;user-select:none;-webkit-user-select:none;">${escapeHtml(getInitials(m.name))}</span>`

    // ── Sections ─────────────────────────────────────────────────────────────

    const personalFields = [
        fieldRow('Gender',         m.sex),
        fieldRow('Date of Birth',  m.dob ? formatDate(m.dob) : null),
        fieldRow('Marital Status', m.marital_status),
    ].join('')

    const membershipFields = [
        fieldRow('Membership Date', m.date_joined ? formatDate(m.date_joined) : null),
        isMeaningful(m.status) ? `
          <div class="md-field">
            <div class="md-label">Status</div>
            <div class="md-value">
              <span class="status-badge status-${escapeHtml(m.status)}">${escapeHtml(m.status)}</span>
            </div>
          </div>
        ` : '',
    ].join('')

    const contactFields = [
        fieldRow('Phone',   m.mobile),
        fieldRow('Email',   m.email),
        fieldRow('Address', m.address),
    ].join('')

    const employmentFields = [
        fieldRow('Employer',   m.employer),
        fieldRow('Department', m.department),
        fieldRow('Position',   m.position),
    ].join('')

    const nokFields = [
        fieldRow('Name',         m.nok_name),
        fieldRow('Relationship', m.nok_relationship),
        fieldRow('Phone',        m.nok_mobile),
    ].join('')

    const bankFields = [
        fieldRow('Bank',         m.bank_name),
        fieldRow('Account No',   m.account_number),
        fieldRow('Account Name', m.account_name),
    ].join('')

    // ── Managers (chips; CSS .md-manager-chips/.md-chip already existed) ──
    const managers = String(m.account_manager || '').split(',').map(s => s.trim()).filter(Boolean)
    const managersHtml = managers.length
        ? `<div class="md-field full"><div class="md-label">Managers</div><div class="md-manager-chips">${managers.map(x => `<span class="md-chip">${escapeHtml(x)}</span>`).join('')}</div></div>`
        : ''

    // ── Payment advice summary (enterprise names resolved when available) ──
    const entName = (id) => {
        const found = (enterpriseList || []).find(e => String(e.id) === String(id))
        return found ? (found.account_name || found.name || String(id)) : String(id)
    }
    const advices = Array.isArray(m.payment_advise) ? m.payment_advise.filter(a => parseFloat(a.amount || 0) > 0) : []
    const adviceTotal = advices.reduce((s, a) => s + (parseFloat(a.amount || 0) || 0), 0)
    const adviceHtml = advices.length
        ? `<div class="md-field full"><div class="md-label">Monthly Advice • Total ₦${adviceTotal.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div class="md-manager-chips">${advices.map(a => `<span class="md-chip">${escapeHtml(entName(a.enterprise_id))}: ₦${Number(a.amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`).join('')}</div></div>`
        : ''

    // ── Signature on file (inline thumb; tap to enlarge in its own view) ──
    const signatureHtml = isMeaningful(m.signature_path)
        ? `<div class="md-field full"><div class="md-label">Signature</div><div class="md-value"><img id="md-signature-thumb" src="${m.signature_path}" alt="Signature" title="Tap to enlarge" style="max-height: 3rem; max-width: 220px; object-fit: contain; background: #fff; border: 1px solid var(--border-light); border-radius: 6px; padding: 2px 6px; cursor: zoom-in;"></div></div>`
        : ''

    // ── Audit trail ──
    const auditFields = [
        fieldRow('Created By', m.created_by),
        fieldRow('Created At', m.created_at ? formatDateTime(m.created_at) : null),
        fieldRow('Modified By', m.modified_by || m.created_by),
        fieldRow('Modified At', (m.modified_at || m.created_at) ? formatDateTime(m.modified_at || m.created_at) : null),
    ].join('')

    // ── Quick-contact actions ──
    const digitsOnly = String(m.mobile || '').replace(/\D/g, '')
    const waNumber = digitsOnly.length > 10 ? digitsOnly : (digitsOnly ? `234${digitsOnly.slice(-10).replace(/^0/, '')}` : '')
    const quickActionsHtml = `
        <div class="md-quick-actions">
            ${digitsOnly ? `<a class="md-qa" href="tel:${escapeHtml(digitsOnly)}">Call</a>` : ''}
            ${waNumber ? `<a class="md-qa" href="https://wa.me/${escapeHtml(waNumber)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
            ${digitsOnly ? `<button type="button" class="md-qa" id="md-copy-mobile">Copy number</button>` : ''}
        </div>
    `

    // ── Footer buttons ────────────────────────────────────────────────────────
    const editBtn       = canEditThis
        ? `<button type="button" class="md-btn md-btn-secondary" id="edit-member-btn">
             <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
             Edit
           </button>` : ''
    const deleteBtn     = canDelete
        ? `<button type="button" class="md-btn md-btn-danger" id="archive-member-btn">
             <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
             Archive
           </button>` : ''
    const remittanceMsg = hasRemittances
        ? `<div class="md-remittance-note">Archiving hides this member from new activity; existing financial history is preserved.</div>` : ''
    const ledgerBtn     = `<button type="button" class="md-btn md-btn-primary" id="view-ledger-btn">
         <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
         View Ledger
       </button>`

    // ── Full modal HTML ───────────────────────────────────────────────────────
    const modalHtml = `
      <style>
        /* ── Overlay ── */
        #member-details-modal {
            position: fixed; inset: 0; z-index: 1000;
            background: var(--overlay-bg);
            display: flex; align-items: center; justify-content: center;
            padding: 1rem;
            animation: mdFadeIn 0.2s ease-out;
            font-family: 'Inter', system-ui, sans-serif;
        }
        @keyframes mdFadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* ── Modal card ── */
        .md-card {
            background: var(--bg-card);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-lg);
            width: 100%;
            max-width: 580px;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            animation: mdSlideUp 0.25s cubic-bezier(0.34,1.56,0.64,1);
        }
        @keyframes mdSlideUp { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

        /* ── Header ── */
        .md-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 1.1rem 1.5rem;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-light);
            flex-shrink: 0;
        }
        .md-header-title { font-size: 0.9rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.07em; }
        .md-close-btn {
            width: 32px; height: 32px; border-radius: 50%;
            border: none; background: var(--bg-input); color: var(--text-muted);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; font-size: 1.1rem; line-height: 1;
            transition: all 0.15s ease;
        }
        .md-close-btn:hover { background: var(--border-medium); color: var(--text-primary); }

        /* ── Body ── */
        .md-body {
            flex: 1; overflow-y: auto; padding: 1.5rem;
            scrollbar-width: thin; scrollbar-color: var(--border-medium) transparent;
            display: flex; flex-direction: column; gap: 0;
        }
        .md-body::-webkit-scrollbar { width: 5px; }
        .md-body::-webkit-scrollbar-thumb { background: var(--border-medium); border-radius: 10px; }

        /* ── Profile hero ── */
        .md-hero {
            display: flex; flex-direction: column; align-items: center;
            padding: 0.5rem 0 1.5rem;
            text-align: center;
        }
        .md-avatar-wrap {
            width: 96px; height: 96px; border-radius: 50%;
            background: var(--bg-secondary);
            border: 3px solid var(--border-medium);
            box-shadow: 0 4px 16px rgba(0,0,0,0.12);
            overflow: hidden;
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 1rem;
            cursor: pointer;
            user-select: none;
            -webkit-user-select: none;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .md-avatar-wrap img { transition: transform 0.2s ease; width:100%;height:100%;object-fit:cover; }
        .md-avatar-wrap:hover { transform: scale(1.12); box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
        .md-avatar-wrap:hover img { transform: scale(1.15); }
        .md-member-name {
            font-size: 1.35rem; font-weight: 800; color: var(--text-primary);
            margin: 0 0 0.5rem; line-height: 1.2;
        }
        .md-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center; }
        .md-badge {
            display: inline-block;
            background: var(--accent-soft); color: var(--accent-primary);
            padding: 0.25rem 0.75rem; border-radius: 999px;
            font-size: 0.72rem; font-weight: 700;
            font-variant-numeric: tabular-nums;
            border: 1px solid rgba(59,130,246,0.2);
        }

        /* ── Section ── */
        .md-section { margin-bottom: 0; }
        .md-section + .md-section { border-top: 1px solid var(--border-light); margin-top: 0; }
        .md-section-header {
            display: flex; align-items: center; gap: 0.5rem;
            padding: 0.85rem 0 0.6rem;
            color: var(--text-muted);
        }
        .md-section-icon { display: flex; align-items: center; flex-shrink: 0; }
        .md-section-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; }
        .md-section-body {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.85rem 1.25rem;
            padding-bottom: 1rem;
        }

        /* ── Field ── */
        .md-field { display: flex; flex-direction: column; gap: 0.18rem; }
        .md-label {
            font-size: 0.68rem; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.07em;
            color: var(--text-muted);
        }
        .md-value {
            font-size: 0.875rem; font-weight: 500;
            color: var(--text-primary); line-height: 1.4;
            word-break: break-word;
        }

        /* ── Full-width field (address etc.) ── */
        .md-field.full { grid-column: 1 / -1; }

        /* ── Quick actions under hero ── */
        .md-quick-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center; margin-top: 0.9rem; }
        .md-qa {
            display: inline-flex; align-items: center;
            padding: 0.4rem 0.9rem; border-radius: 999px;
            font-size: 0.76rem; font-weight: 700;
            background: var(--bg-secondary); color: var(--text-primary);
            border: 1px solid var(--border-medium);
            text-decoration: none; cursor: pointer; font-family: inherit;
            transition: background 0.15s ease;
        }
        .md-qa:hover { background: var(--accent-soft); border-color: var(--accent-primary); color: var(--accent-primary); }

        /* ── Manager chips ── */
        .md-manager-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
        .md-chip {
            display: inline-block;
            background: var(--bg-secondary); color: var(--text-secondary);
            padding: 0.2rem 0.6rem; border-radius: var(--radius-sm);
            font-size: 0.78rem; font-weight: 500;
            border: 1px solid var(--border-medium);
        }

        /* ── Footer ── */
        .md-footer {
            flex-shrink: 0;
            padding: 1rem 1.5rem;
            background: var(--bg-secondary);
            border-top: 1px solid var(--border-light);
            display: flex; justify-content: flex-end; gap: 0.6rem; flex-wrap: wrap; align-items: center;
        }
        .md-btn {
            display: inline-flex; align-items: center; gap: 0.4rem;
            padding: 0.55rem 1.1rem; border-radius: 999px;
            font-size: 0.82rem; font-weight: 700;
            border: none; cursor: pointer;
            transition: all 0.18s ease;
            font-family: inherit;
        }
        .md-btn-primary { background: var(--accent-primary); color: #fff; }
        .md-btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
        .md-btn-secondary { background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border-medium); }
        .md-btn-secondary:hover { background: var(--bg-secondary); }
        .md-btn-danger { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(220,38,38,0.25); }
        .md-btn-danger:hover { background: var(--danger); color: #fff; }
        .md-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .md-remittance-note { font-size: 0.72rem; color: var(--text-muted); text-align: center; line-height: 1.4; padding: 0.4rem 0.75rem; }

        /* ── Image preview overlay ── */
        #md-img-preview {
            position: fixed; inset: 0; z-index: 9999;
            background: rgba(0,0,0,0.84);
            display: flex; align-items: center; justify-content: center;
            animation: mdFadeIn 0.18s ease-out;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
        }
        /* ── Photo preview ── */
        .md-preview-image-wrap {
            display: flex; flex-direction: column; align-items: center; gap: 1.25rem;
            animation: mdScaleIn 0.22s cubic-bezier(0.34,1.3,0.64,1);
        }
        .md-preview-image-wrap img {
            width: min(88vw, 144px * 4); max-width: min(88vw, 576px); max-height: 80vh;
            object-fit: contain; border-radius: 14px;
            box-shadow: 0 24px 80px rgba(0,0,0,0.65);
        }
        .md-preview-meta { display: flex; align-items: center; gap: 0.65rem; }
        .md-preview-initials-sm {
            width: 32px; height: 32px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 0.8rem; font-weight: 800; color: #fff; text-transform: uppercase;
            letter-spacing: 0.04em; flex-shrink: 0;
            border: 2px solid rgba(255,255,255,0.25);
        }
        /* ── Initials-only preview ── */
        .md-preview-initials-wrap {
            display: flex; flex-direction: column; align-items: center; gap: 1rem;
            animation: mdScaleIn 0.22s cubic-bezier(0.34,1.3,0.64,1);
        }
        .md-preview-initials-circle {
            width: 144px; height: 144px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 3.2rem; font-weight: 800; color: #ffffff;
            letter-spacing: 0.04em; text-transform: uppercase; user-select: none;
            box-shadow: 0 16px 60px rgba(0,0,0,0.45);
            border: 3px solid rgba(255,255,255,0.18);
        }
        /* ── Shared name label ── */
        .md-preview-name {
            color: rgba(255,255,255,0.92); font-size: 1.05rem; font-weight: 600;
            letter-spacing: 0.02em; text-shadow: 0 1px 6px rgba(0,0,0,0.6);
        }
        @keyframes mdScaleIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }

        /* ── Mobile ── */
        @media (max-width: 480px) {
            .md-card { max-height: 95vh; border-radius: var(--radius-md); }
            .md-section-body { grid-template-columns: 1fr; }
            .md-footer { justify-content: stretch; }
            .md-footer .md-btn { flex: 1; justify-content: center; }
        }
      </style>

      <div id="member-details-modal">
        <div class="md-card">

          <div class="md-header">
            <div class="md-header-title">Member Profile</div>
            <button class="md-close-btn" id="md-close-btn" aria-label="Close">&#x2715;</button>
          </div>

          <div class="md-body">

            <!-- Hero -->
            <div class="md-hero">
              <div class="md-avatar-wrap" id="md-avatar-wrap" ${!m.image_path ? `style="background-color: ${getAvatarColor(m.name)}"` : ''}>
                ${avatarHtml}
              </div>
              <h2 class="md-member-name">${escapeHtml(m.name)}</h2>
              <div class="md-badges">
                <span class="md-badge">Reg No: ${padRegNo}</span>
                ${isMeaningful(m.special_id) ? `<span class="md-badge">ID: ${escapeHtml(m.special_id)}</span>` : ''}
              </div>
              ${quickActionsHtml}
            </div>

            ${section('Personal Information', ICONS.personal, personalFields)}
            ${section('Membership Information', ICONS.membership, membershipFields)}
            ${section('Contact Information', ICONS.contact,
                [
                    fieldRow('Phone', m.mobile),
                    fieldRow('Email', m.email),
                    isMeaningful(m.address) ? `
                      <div class="md-field full">
                        <div class="md-label">Address</div>
                        <div class="md-value">${escapeHtml(m.address.trim())}</div>
                      </div>
                    ` : '',
                ].join('')
            )}
            ${section('Employment Information', ICONS.employment, employmentFields)}
            ${section('Next of Kin', ICONS.nok, nokFields)}
            ${section('Bank Details', ICONS.bank, bankFields)}
            ${section('Managers & Advice', ICONS.membership, [managersHtml, adviceHtml, signatureHtml].join(''))}
            ${section('Record History', ICONS.membership, auditFields)}

          </div>

          <div class="md-footer">
            ${editBtn}
            ${deleteBtn}
            ${remittanceMsg}
            ${ledgerBtn}
          </div>

        </div>
      </div>
    `

    document.body.insertAdjacentHTML('beforeend', modalHtml)
    
    const modal = document.getElementById('member-details-modal')

    // ── Close button / overlay / Escape ───────────────────────────────────────
    const closeModal = () => { hideOverlay(); modal.remove() }
    modal.querySelector('#md-close-btn').addEventListener('click', closeModal)
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
    const onEsc = (e) => { if (e.key === 'Escape') closeModal() }
    document.addEventListener('keydown', onEsc, { once: true })
    modal.querySelector('#md-close-btn')?.focus?.()

    // ── Copy mobile number ──────────────────────────────────────────────────
    modal.querySelector('#md-copy-mobile')?.addEventListener('click', async () => {
        const num = String(m.mobile || '')
        if (!num) return
        try {
            await navigator.clipboard.writeText(num)
            showToast('Number copied.', 'success')
        } catch {
            const ta = document.createElement('textarea')
            ta.value = num
            document.body.appendChild(ta)
            ta.select()
            try { document.execCommand('copy') } catch {}
            ta.remove()
            showToast('Number copied.', 'success')
        }
    })

    // ── Single-click image preview (photo only) + tap-to-enlarge signature ──
    // Each opens its own overlay: photo viewer shows just the photo,
    // signature viewer shows just the signature. Click outside or Escape closes.
    const showOverlay = (innerHtml) => {
        hideOverlay()
        const overlay = document.createElement('div')
        overlay.id = 'md-img-preview'
        overlay.innerHTML = innerHtml
        overlay.addEventListener('click', hideOverlay)
        document.body.appendChild(overlay)
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') {
                hideOverlay()
                document.removeEventListener('keydown', onKey)
            }
        })
    }
    const hideOverlay = () => {
        document.getElementById('md-img-preview')?.remove()
    }

    const avatarWrap = modal.querySelector('#md-avatar-wrap')
    if (avatarWrap) {
        avatarWrap.title = 'View photo'
        avatarWrap.addEventListener('click', (e) => {
            e.stopPropagation()
            const initials = getInitials(m.name)
            const color = getAvatarColor(m.name)
            showOverlay(m.image_path
                ? `<div class="md-preview-image-wrap">
                       <img src="${m.image_path}" alt="${escapeHtml(m.name)}" draggable="false">
                       <div class="md-preview-meta">
                           <div class="md-preview-initials-sm" style="background-color: ${color}">${escapeHtml(initials)}</div>
                           <div class="md-preview-name">${escapeHtml(m.name)}</div>
                       </div>
                   </div>`
                : `<div class="md-preview-initials-wrap">
                       <div class="md-preview-initials-circle" style="background-color: ${color}">${escapeHtml(initials)}</div>
                       <div class="md-preview-name">${escapeHtml(m.name)}</div>
                   </div>`)
        })
    }

    const sigThumb = modal.querySelector('#md-signature-thumb')
    if (sigThumb && m.signature_path) {
        sigThumb.addEventListener('click', (e) => {
            e.stopPropagation()
            showOverlay(`
                <div style="background: #fff; border-radius: 14px; padding: 1.5rem 1.75rem; max-width: min(88vw, 520px); width: 100%; box-shadow: 0 24px 80px rgba(0,0,0,0.65); animation: mdScaleIn 0.22s cubic-bezier(0.34,1.3,0.64,1);">
                    <div style="font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 0.75rem;">Signature — ${escapeHtml(m.name)}</div>
                    <img src="${m.signature_path}" alt="Signature of ${escapeHtml(m.name)}" draggable="false" style="width: 100%; max-height: 52vh; object-fit: contain;">
                </div>`)
        })
    }

    // ── Edit ─────────────────────────────────────────────────────────────────
    modal.querySelector('#edit-member-btn')?.addEventListener('click', () => {
        modal.remove()
        window.location.hash = `members/edit/${m.id}`
    })

    // ── Archive ───────────────────────────────────────────────────────────────
    modal.querySelector('#archive-member-btn')?.addEventListener('click', async () => {
        if (confirm(`Archive ${m.name}? The member remains in history and can be restored by changing the status.`)) {
            const btn = modal.querySelector('#archive-member-btn')
            btn.textContent = 'Archiving...'
            btn.disabled = true

            try {
                await archiveMember(m.id, user.username)
                modal.remove()
                const { loadMembersData } = await import('./membersState.js')
                const { renderMembersPage } = await import('./membersPage.js')
                await loadMembersData(user)
                const container = document.getElementById('dashboard-main-content')
                if (container) await renderMembersPage(container, user)
            } catch (err) {
                btn.innerHTML = `<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg> Delete`
                btn.disabled = false
                showToast('Archive failed: ' + err.message, 'error')
            }
        }
    })

    // ── View Ledger ───────────────────────────────────────────────────────────
    modal.querySelector('#view-ledger-btn')?.addEventListener('click', () => {
        const memberName = m.name || `${m.first_name || ''} ${m.last_name || ''}`.trim() || 'Selected Member'
        modal.remove()
        window.dispatchEvent(new CustomEvent('change-tab', { detail: { tab: 'ledger', memberId: m.id, memberName } }))
    })
}
