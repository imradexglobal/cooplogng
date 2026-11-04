import { escapeHtml, formatDateForInput, generateRandom6Digit, wrapDateInput } from '../../utils/formatters.js'
import { compressImage } from '../../utils/imageUtils.js'
import { checkSignatureImage } from '../../utils/signatureCheck.js'
import { normalizePhone } from '../../utils/normalize.js'
import { addMember, updateMember, fetchCooperativeUsers } from '../../services/dataService.js'
import { getAllMembers, usersList, enterpriseList, loadMembersData } from './membersState.js'
import { getAllForCoop } from '../../services/sqliteService.js'
import { showToast } from '../../services/toastService.js'

export async function renderMembersForm(container, user, member = null) {
    const isEdit = !!member
    let activeFormTab = 'bio'
    // Default managers for new members: admins keep the legacy "all managers"
    // default; non-admin creators default to themselves so the record stays
    // visible to them (fetchAllMembers is manager-scoped) without leaking to
    // every manager. Falls back to all when the username isn't in usersList.
    const creatorIsomnipresent = (() => {
        try {
            const perms = user?.permissions
            const p = String(perms || '').toLowerCase()
            if (p.includes('admin')) return true
        } catch {}
        return String(user?.username || '').toLowerCase() === 'admin'
    })()
    let selectedManagers = isEdit
        ? String(member.account_manager || '').split(',').map(s => s.trim()).filter(Boolean)
        : (() => {
            const all = usersList.map(u => u.username)
            if (creatorIsomnipresent) return all
            const self = String(user?.username || '').trim()
            return self && all.includes(self) ? [self] : all
        })()
    let pendingManagers = [...selectedManagers]
    let selectedPassport = member?.image_path || null
    let selectedSignature = member?.signature_path || null

    // Normalize Special ID - trim only; case-insensitive search uses special_id_lower
    const normalizeSpecialId = (id) => {
        if (!id) return null
        return String(id).trim()
    }

    const updateFormTabs = () => {
        container.querySelectorAll('.tab-btn').forEach(btn => {
            const tabId = btn.dataset.tab
            const content = container.querySelector(`#tab-${tabId}`)
            if (tabId === activeFormTab) {
                btn.classList.add('active')
                content?.classList.remove('hidden')
            } else {
                btn.classList.remove('active')
                content?.classList.add('hidden')
            }
        })
    }

    const renderManagerDropdown = () => {
        const dropdown = container.querySelector('#manager-dropdown')
        if (!dropdown) return

        const triggerText = container.querySelector('#manager-trigger-text')
        if (triggerText) {
            triggerText.textContent = selectedManagers.length > 0 
                ? `${selectedManagers.length} Managers Selected` 
                : 'Select Managers...';
        }

        dropdown.innerHTML = `
            <div style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); margin-bottom: 0.75rem; text-transform: uppercase;">
                Select Managers
            </div>
            <div style="margin-bottom: 0.75rem;">
                <input type="text" id="mgr-dropdown-search" placeholder="Search managers..." 
                    style="width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-medium); font-size: 0.88rem; background: var(--bg-input); color: var(--text-primary);">
            </div>
            <div class="mgr-list" style="max-height: 240px; overflow-y: auto; margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.35rem; padding: 0.15rem;">
                <label class="field-option" data-key="all">
                    <input type="checkbox" id="mgr-chk-all" ${pendingManagers.length === usersList.length ? 'checked' : ''}>
                    <span style="font-weight: 700; font-size: 0.88rem;">All Managers</span>
                </label>
                ${usersList.map(u => {
                    const displayName = u.full_name || u.username;
                    return `
                    <label class="field-option mgr-item" data-key="${u.username}" data-search="${displayName.toLowerCase()}">
                        <input type="checkbox" class="mgr-chk" value="${u.username}" ${pendingManagers.includes(u.username) ? 'checked' : ''}>
                        <div style="display: flex; flex-direction: column; gap: 0.1rem;">
                            <span style="font-size: 0.88rem; color: var(--text-primary); font-weight: 500;">${escapeHtml(displayName)}</span>
                            ${u.full_name ? `<span style="font-size: 0.75rem; color: var(--text-muted);">@${escapeHtml(u.username)}</span>` : ''}
                        </div>
                    </label>
                `}).join('')}
            </div>
            <div style="display: flex; gap: 0.75rem;">
                <button type="button" class="primary-button" id="apply-mgrs" style="flex: 1; min-height: 2.5rem; font-size: 0.85rem; border-radius: 999px;">Apply</button>
                <button type="button" class="secondary-button" id="cancel-mgrs" style="flex: 1; min-height: 2.5rem; font-size: 0.85rem; border-radius: 999px; background: white; color: black;">Cancel</button>
            </div>
        `;

        const searchInput = dropdown.querySelector('#mgr-dropdown-search');
        searchInput?.addEventListener('input', (e) => {
            const val = e.target.value.toLowerCase();
            dropdown.querySelectorAll('.mgr-item').forEach(item => {
                const text = item.dataset.search || '';
                item.style.display = text.includes(val) ? 'flex' : 'none';
            });
        });

        dropdown.querySelector('#mgr-chk-all')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                pendingManagers = usersList.map(u => u.username);
            } else {
                pendingManagers = [];
            }
            dropdown.querySelectorAll('.mgr-chk').forEach(cb => {
                cb.checked = e.target.checked;
            });
        });

        dropdown.querySelectorAll('.mgr-chk').forEach(cb => {
            cb.addEventListener('change', () => {
                const key = cb.value;
                if (cb.checked) {
                    if (!pendingManagers.includes(key)) pendingManagers.push(key);
                } else {
                    pendingManagers = pendingManagers.filter(k => k !== key);
                }
                const allChk = dropdown.querySelector('#mgr-chk-all');
                if (allChk) allChk.checked = pendingManagers.length === usersList.length;
            });
        });

        dropdown.querySelector('#apply-mgrs')?.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedManagers = [...pendingManagers];
            dropdown.classList.add('hidden');
            if (triggerText) {
                triggerText.textContent = selectedManagers.length > 0 
                    ? `${selectedManagers.length} Managers Selected` 
                    : 'Select Managers...';
            }
        });

        dropdown.querySelector('#cancel-mgrs')?.addEventListener('click', (e) => {
            e.stopPropagation();
            pendingManagers = [...selectedManagers];
            dropdown.classList.add('hidden');
        });
    }

    container.innerHTML = `
      <style>
        .form-card {
            background: var(--bg-card);
            border-radius: var(--radius-lg);
            padding: 2rem;
            box-shadow: var(--shadow-xl);
            border: 1px solid var(--border-light);
            max-width: 1360px;
            margin: 0 auto;
            width: 100%;
            box-sizing: border-box;
        }
        /* Field styling inherits the global floating-outlined .field system
           from style.css (same as the remittance form) for app-wide consistency. */
        .tab-btn {
            background: transparent;
            border: none;
            padding: 0.75rem 1.5rem;
            font-weight: 600;
            color: var(--text-muted);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }
        .tab-btn.active {
            color: var(--accent-primary);
            border-bottom-color: var(--accent-primary);
        }
        .tab-btn.has-error {
            color: var(--danger);
        }
        .tab-btn.has-error::after {
            content: ' •';
            font-weight: 800;
        }
        @media (max-width: 1024px) {
            .bio-layout > .bio-photos { grid-column: span 12; grid-row: auto; }
            .bio-layout > label.field { grid-column: span 6 !important; }
        }
        @media (max-width: 640px) {
            .form-card { padding: 1.1rem; }
            .nok-bank-grid { grid-template-columns: 1fr !important; }
            .bio-layout > label.field { grid-column: span 12 !important; }
        }
        .duplicate-warning {
            color: #dc2626;
            font-size: 0.75rem;
            font-weight: 600;
            margin-top: 0.25rem;
        }
        .dropdown-btn {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 0.75rem;
            border-radius: var(--radius-md);
            border: 1px solid var(--border-medium);
            background: var(--bg-input);
            color: var(--text-primary);
            font-size: 0.85rem;
            cursor: pointer;
            width: 100%;
            height: 2.75rem;
        }
        .field-option { 
            display: flex; 
            align-items: center; 
            gap: 0.75rem; 
            padding: 0.65rem 0.75rem; 
            cursor: pointer; 
            border-radius: 8px;
            transition: background 0.2s; 
            font-size: 0.88rem; 
            color: var(--text-primary); 
            border: 1px solid transparent;
        }
        .field-option:hover { background: var(--bg-secondary); border-color: var(--border-light); }
        .field-option input[type="checkbox"] { 
            cursor: pointer; 
            width: 18px !important; 
            height: 18px !important; 
            margin: 0;
            flex-shrink: 0;
            accent-color: var(--accent-primary);
        }
        .dropdown-menu {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: var(--bg-card);
            border: 1px solid var(--border-medium);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-xl);
            z-index: 100;
            padding: 1rem;
            min-width: 280px;
        }
        /* Photo strip — sits top-left as the first grid cell, no boxes;
           fields flow around it. Tapping a photo opens the fullscreen
           preview (same as the members table); tapping an empty
           placeholder goes straight to add. */
        /* 12-column bio layout: photos take 3 cols x 3 rows top-left
           (just wide enough for both thumbs, no dead gap), field rows
           sit 3-across beside them, rest full-width. */
        .bio-layout {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            column-gap: 0.7rem;
            row-gap: 1.5rem;
        }
        .bio-layout > label.field { grid-column: span 3; min-width: 0; }
        .bio-layout > label.field.wide { grid-column: span 4; }
        /* Consistent rows form-wide: neutralize the global tall field
           margins inside every field grid; the grid gaps set rhythm. */
        .bio-layout > label.field:has(input),
        .bio-layout > label.field:has(select),
        .bio-layout > label.field:has(textarea),
        .nok-bank-grid > label.field:has(input),
        .nok-bank-grid > label.field:has(select),
        .nok-bank-grid > label.field:has(textarea),
        .emp-grid > label.field:has(input),
        .emp-grid > label.field:has(select),
        .emp-grid > label.field:has(textarea) { margin-top: 0; margin-bottom: 0; }
        .bio-photos {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            align-items: flex-start;
            padding-top: 0.25rem;
            min-width: 0;
            grid-column: span 3;
            grid-row: span 3;
            align-self: start;
        }
        .bio-photos-row {
            display: flex;
            gap: 1rem;
            align-items: flex-start;
        }
        .bio-photo {
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.3rem;
            min-width: 0;
        }
        .bio-photo-caption {
            font-size: 0.68rem;
            font-weight: 700;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .bio-thumb {
            cursor: pointer;
            flex-shrink: 0;
        }
        .bio-thumb:focus-visible {
            outline: 2px solid var(--accent-primary);
            outline-offset: 3px;
        }
        /* Small pill buttons under the photos (Edit / Reset PIN). */
        .bio-edit-btn {
            background: var(--bg-card);
            border: 1px solid var(--border-medium);
            color: var(--text-primary);
            border-radius: 999px;
            font-size: 0.75rem;
            font-weight: 700;
            cursor: pointer;
            padding: 0.35rem 0.9rem;
            font-family: inherit;
            white-space: nowrap;
        }
        .bio-edit-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
        /* Add/change chooser popover (Camera / Gallery / Remove). */
        .bio-chooser {
            position: absolute;
            top: calc(100% + 6px);
            left: 50%;
            transform: translateX(-50%);
            background: var(--bg-card);
            border: 1px solid var(--border-medium);
            border-radius: var(--radius-md);
            box-shadow: var(--shadow-xl);
            z-index: 60;
            min-width: 150px;
            padding: 0.35rem;
            display: flex;
            flex-direction: column;
            gap: 0.15rem;
        }
        .bio-chooser.hidden { display: none; }
        .bio-chooser button {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            width: 100%;
            padding: 0.5rem 0.65rem;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: var(--text-primary);
            font-size: 0.82rem;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
            white-space: nowrap;
        }
        .bio-chooser button:hover { background: var(--bg-secondary); }
        .bio-chooser button.danger { color: var(--danger); }
        /* Fullscreen photo preview — same look as the members table. */
        .mf-photo-overlay {
            position: fixed;
            inset: 0;
            z-index: 9999;
            background: rgba(0,0,0,0.84);
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
        }
        .mf-photo-wrap {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1.25rem;
        }
        .mf-photo-wrap img {
            max-width: min(88vw, 576px);
            max-height: 80vh;
            object-fit: contain;
            border-radius: 14px;
            box-shadow: 0 24px 80px rgba(0,0,0,0.65);
        }
        .mf-photo-name {
            color: rgba(255,255,255,0.92);
            font-size: 1.05rem;
            font-weight: 600;
            letter-spacing: 0.02em;
            text-shadow: 0 1px 6px rgba(0,0,0,0.6);
        }
      </style>

      <div class="members-page" style="padding-bottom: 4rem; background: var(--bg-main);">
        <div class="page-header" style="margin-bottom: 2rem; display: flex; align-items: center; gap: 1rem;">
          <button type="button" class="ghost-button" id="back-to-list-btn" style="padding: 0.5rem; border-radius: var(--radius-md); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; background: var(--bg-card); border: 1px solid var(--border-light); box-shadow: var(--shadow-sm); color: var(--text-primary);">
            <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"></path></svg>
          </button>
          <div>
            <h2 style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary);">${isEdit ? 'Edit Member' : 'Add New Member'}</h2>
            <p style="color: var(--text-muted); font-size: 0.9rem;">${isEdit ? escapeHtml(member.name) : 'Provide registration details below.'}</p>
          </div>
        </div>

        <div class="form-card">
          <div style="display: flex; border-bottom: 1px solid var(--border-light); margin-bottom: 2rem;">
              <button class="tab-btn active" data-tab="bio">Personal Info</button>
              <button class="tab-btn" data-tab="work">Employment</button>
              <button class="tab-btn" data-tab="nok">NOK & Bank</button>
              <button class="tab-btn" data-tab="pay">Payment Advice</button>
          </div>

          <form id="member-form">
            <!-- Bio Data Tab -->
            <div id="tab-bio">
                <div class="bio-layout">
                    <div class="bio-photos">
                    <div class="bio-photos-row">
                    <div class="bio-photo" id="passport-slot">
                            <span class="bio-photo-caption">Passport</span>
                            <div class="bio-thumb" id="passport-preview-wrap" role="button" tabindex="0" title="Passport photo — tap to view or add">
                                <div id="passport-preview" style="width: 120px; height: 120px; border-radius: 50%; background: var(--bg-secondary); display: flex; align-items: center; justify-content: center; overflow: hidden; border: 2px solid var(--border-light);">
                                </div>
                            </div>
                            <button type="button" class="bio-edit-btn" id="passport-edit">Edit</button>
                            <div class="bio-chooser hidden" id="passport-chooser">
                                <button type="button" id="passport-camera">Camera</button>
                                <button type="button" id="passport-gallery">Gallery</button>
                                <button type="button" id="passport-remove" class="danger">Remove</button>
                            </div>
                            <input type="file" id="passport-input" accept="image/*" hidden />
                        </div>
                        <div class="bio-photo" id="signature-slot">
                            <span class="bio-photo-caption">Signature</span>
                            <div class="bio-thumb" id="signature-preview-wrap" role="button" tabindex="0" title="Signature — tap to view or add">
                                <div id="signature-preview" style="width: 120px; height: 120px; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 2px solid var(--border-light); border-radius: 12px;">
                                </div>
                            </div>
                            <button type="button" class="bio-edit-btn" id="signature-edit">Edit</button>
                            <div class="bio-chooser hidden" id="signature-chooser">
                                <button type="button" id="signature-camera">Camera</button>
                                <button type="button" id="signature-gallery">Gallery</button>
                                <button type="button" id="signature-remove" class="danger">Remove</button>
                            </div>
                            <input type="file" id="signature-input" accept="image/*" hidden />
                        </div>
                    </div>
                    ${isEdit ? `<button type="button" id="reset-pwd-btn" class="bio-edit-btn">Reset 6-Digit PIN</button>` : ''}
                    </div>
                    <label class="field">
                        <span>Prefix (Optional)</span>
                        <select name="prefix">
                            ${(() => {
                                const opts = ['', 'Mr', 'Mrs', 'Miss', 'Ms', 'Alhaji', 'Alhaja', 'Dr', 'Prof', 'Pastor', 'Rev', 'Chief', 'Engr', 'Barr']
                                const cur = member?.prefix || ''
                                const extra = cur && !opts.includes(cur) ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>` : ''
                                return extra + opts.map(o => `<option value="${o}" ${cur === o ? 'selected' : ''}>${o ? o : '— (None)'}</option>`).join('')
                            })()}
                        </select>
                    </label>
                    <label class="field">
                        <span>Last Name *</span>
                        <input name="last_name" type="text" required value="${escapeHtml(member?.last_name || '')}">
                    </label>
                    <label class="field">
                        <span>First Name *</span>
                        <input name="first_name" type="text" required value="${escapeHtml(member?.first_name || '')}">
                    </label>
                    <label class="field">
                        <span>Middle Name</span>
                        <input name="middle_name" type="text" value="${escapeHtml(member?.middle_name || '')}">
                    </label>
                    <label class="field">
                        <span>Registration No</span>
                        <input name="registration_no" type="text" readonly value="${member ? String(member.registration_no || "").padStart(4, '0') : '(Auto-generated)'}" style="background: var(--bg-secondary); color: var(--text-muted);">
                    </label>
                    <label class="field">
                        <span>Special ID (Live Duplicate Check)</span>
                        <input name="special_id" id="special-id-input" type="text" value="${escapeHtml(member?.special_id || '')}">
                        <div id="special-id-duplicate-error" class="duplicate-warning hidden">This Special ID is already registered to another member.</div>
                    </label>
                    <label class="field">
                        <span>Mobile * (Live Duplicate Check)</span>
                        <input name="mobile" id="mobile-input" type="tel" required value="${escapeHtml(member?.mobile || '')}">
                        <div id="duplicate-error" class="duplicate-warning hidden">This mobile number is already registered to another member.</div>
                    </label>
                    <label class="field">
                        <span>Email</span>
                        <input name="email" type="email" value="${escapeHtml(member?.email || '')}">
                    </label>
                    <label class="field">
                        <span>Status</span>
                        <select name="status">
                            <option value="Active" ${member?.status === 'Active' ? 'selected' : ''}>Active</option>
                            <option value="Inactive" ${member?.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
                            <option value="Suspended" ${member?.status === 'Suspended' ? 'selected' : ''}>Suspended</option>
                        </select>
                    </label>
                    <label class="field">
                        <span>Sex</span>
                        <select name="sex">
                            <option value="Male" ${member?.sex === 'Male' ? 'selected' : ''}>Male</option>
                            <option value="Female" ${member?.sex === 'Female' ? 'selected' : ''}>Female</option>
                        </select>
                    </label>
                    <label class="field wide">
                        <span>Date Joined</span>
                        <input name="date_joined" type="date" value="${member ? formatDateForInput(member.date_joined) : formatDateForInput(new Date())}">
                    </label>
                    <label class="field wide">
                        <span>Date of Birth</span>
                        <input name="dob" type="date" value="${member ? formatDateForInput(member.dob) : ''}">
                    </label>
                    <label class="field wide">
                        <span>Marital Status</span>
                        <select name="marital_status">
                            ${(() => {
                                const opts = ['Single', 'Married', 'Divorced', 'Widowed']
                                const cur = member?.marital_status || ''
                                const extra = cur && !opts.includes(cur) ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>` : ''
                                const none = `<option value="" ${!cur ? 'selected' : ''}>—</option>`
                                return none + extra + opts.map(o => `<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`).join('')
                            })()}
                        </select>
                    </label>
                </div>

                <label class="field" style="margin: 1.5rem 0 0;">
                    <span>Home Address</span>
                    <textarea name="address" rows="2">${escapeHtml(member?.address || '')}</textarea>
                </label>

            </div>

            <!-- Employment & Managers Tab -->
            <div id="tab-work" class="hidden">
                <h4 style="margin: 0 0 1.5rem 0; font-size: 0.9rem; color: var(--text-primary);">Employment</h4>
                <div class="emp-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem 0.7rem;">
                    <label class="field">
                        <span>Employer</span>
                        <input name="employer" type="text" value="${escapeHtml(member?.employer || '')}">
                    </label>
                    <label class="field">
                        <span>Department</span>
                        <input name="department" type="text" value="${escapeHtml(member?.department || '')}">
                    </label>
                    <label class="field">
                        <span>Position</span>
                        <input name="position" type="text" value="${escapeHtml(member?.position || '')}">
                    </label>
                </div>

                <!-- Manager Dropdown UI -->
                <div class="field" style="margin-top: 1.5rem; position: relative;">
                    <span>Account Manager(s)</span>
                    <button type="button" class="dropdown-btn" id="manager-dropdown-trigger">
                        <span id="manager-trigger-text">Select Managers...</span>
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </button>
                    <div id="manager-dropdown" class="dropdown-menu hidden">
                        <!-- Rendered by renderManagerDropdown() -->
                    </div>
                </div>
            </div>

            <!-- NOK & Bank Tab -->
            <div id="tab-nok" class="hidden">
                <div class="nok-bank-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem 0.7rem;">
                    <div>
                        <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; color: var(--text-primary);">Next of Kin</h4>
                        <label class="field"><span>Full Name</span><input name="nok_name" type="text" value="${escapeHtml(member?.nok_name || '')}"></label>
                        <label class="field"><span>Relationship</span><input name="nok_relationship" type="text" value="${escapeHtml(member?.nok_relationship || '')}"></label>
                        <label class="field"><span>Mobile</span><input name="nok_mobile" type="tel" value="${escapeHtml(member?.nok_mobile || '')}"></label>
                        <label class="field"><span>Address</span><input name="nok_address" type="text" value="${escapeHtml(member?.nok_address || '')}"></label>
                    </div>
                    <div>
                        <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; color: var(--text-primary);">Bank Details</h4>
                        <label class="field"><span>Bank Name</span><input name="bank_name" type="text" value="${escapeHtml(member?.bank_name || '')}"></label>
                        <label class="field"><span>Account Number</span><input name="account_number" type="text" value="${escapeHtml(member?.account_number || '')}"></label>
                        <label class="field"><span>Account Name</span><input name="account_name" type="text" value="${escapeHtml(member?.account_name || '')}"></label>
                    </div>
                </div>
            </div>

            <!-- Payment Advice Tab -->
            <div id="tab-pay" class="hidden">
                <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Set monthly contribution expectations for this member.</p>
                <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; align-items: center;">
                    <input type="text" id="pay-advise-search" placeholder="Filter enterprises…" style="flex: 2; min-width: 160px; padding: 0.5rem 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem;">
                    <input type="number" id="pay-advise-bulk" step="0.01" min="0" placeholder="Set all to…" style="flex: 1; min-width: 110px; padding: 0.5rem 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem;">
                    <button type="button" id="pay-advise-apply" class="secondary-button" style="padding: 0.5rem 1rem; font-size: 0.78rem;">Apply</button>
                    <span id="pay-advise-total" style="margin-left: auto; font-size: 0.82rem; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums;"></span>
                </div>
                <div style="max-height: 400px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: var(--radius-lg);">
                    <table class="styled-table">
                        <thead><tr><th>Enterprise</th><th style="text-align: right;">Amount</th></tr></thead>
                        <tbody id="pay-advise-body">
                            ${enterpriseList.map(ent => {
                                const advice = member?.payment_advise?.find(a => a.enterprise_id === ent.id)
                                const amount = advice ? advice.amount : '0.00'
                                const isLoan = (ent.account_type || '').toLowerCase() === 'loan'
                                return `
                                    <tr class="pay-advise-row" data-search="${escapeHtml(String(ent.account_name || '').toLowerCase())}">
                                        <td>${escapeHtml(ent.account_name)}${isLoan ? ' <span style="font-size:0.7rem;color:var(--text-muted);font-style:italic;">(auto)</span>' : ''}</td>
                                        <td style="text-align: right;"><input type="number" step="0.01" min="0" class="pay-advise-input" data-ent-id="${ent.id}" value="${amount}" ${isLoan ? 'disabled title="Auto-calculated from active loans"' : ''} style="width: 120px; text-align: right;${isLoan ? 'opacity:0.6;' : ''}"></td>
                                    </tr>
                                `
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <div style="margin-top: 1.5rem; display: flex; justify-content: flex-end; gap: 1rem; border-top: 1px solid var(--border-light); padding-top: 1.5rem; flex-wrap: wrap;">
                <button type="button" class="secondary-button" id="cancel-btn" style="padding: 0.75rem 2rem;">Cancel</button>
                ${isEdit ? '' : `<button type="button" class="secondary-button" id="save-add-btn" style="padding: 0.75rem 1.5rem;">Save &amp; Add Another</button>`}
                <button type="submit" class="primary-button" id="save-member-btn" style="padding: 0.75rem 2rem; flex: 0 0 auto;">Save Member</button>
            </div>
          </form>
        </div>
      </div>
    `

    renderManagerDropdown()
    updateFormTabs()

    // Wrap all date inputs
    container.querySelectorAll('input[type="date"]').forEach(wrapDateInput);
    
    // Passport + Signature — separate cards, big touch targets, SVG icons
    // (emoji glyphs don't render on some devices). Hidden file inputs are
    // Gallery-only; Camera buttons go through the offline picker
    // (in-app camera -> native camera app, never needs internet).
    const passportInput = container.querySelector('#passport-input')
    const passportPreview = container.querySelector('#passport-preview')
    const signatureInput = container.querySelector('#signature-input')
    const signaturePreview = container.querySelector('#signature-preview')
    const EMPTY_AVATAR_SVG = `<svg width="44" height="44" fill="none" stroke="var(--text-muted)" stroke-width="1.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`
    const EMPTY_SIG_SVG = `<svg width="40" height="40" fill="none" stroke="#94a3b8" stroke-width="1.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"/></svg>`

    // Single source of truth for the thumbs: image (or placeholder),
    // Edit-button visibility, and Remove-option visibility.
    const paintPhotos = () => {
        if (passportPreview) passportPreview.innerHTML = selectedPassport
            ? `<img src="${selectedPassport}" style="width: 100%; height: 100%; object-fit: cover;" />`
            : EMPTY_AVATAR_SVG
        if (signaturePreview) signaturePreview.innerHTML = selectedSignature
            ? `<img src="${selectedSignature}" style="width: 100%; height: 100%; object-fit: contain;" />`
            : EMPTY_SIG_SVG
        const passportEdit = container.querySelector('#passport-edit')
        const signatureEdit = container.querySelector('#signature-edit')
        if (passportEdit) passportEdit.style.display = selectedPassport ? '' : 'none'
        if (signatureEdit) signatureEdit.style.display = selectedSignature ? '' : 'none'
        const passportRemove = container.querySelector('#passport-remove')
        const signatureRemove = container.querySelector('#signature-remove')
        if (passportRemove) passportRemove.style.display = selectedPassport ? '' : 'none'
        if (signatureRemove) signatureRemove.style.display = selectedSignature ? '' : 'none'
    }

    const applyPassportFile = async (file) => {
        if (!file) return
        try {
            selectedPassport = await compressImage(file)
            paintPhotos()
        } catch (err) {
            console.error('Passport compression failed:', err)
            showToast('Could not read that photo. Try another.', 'error')
        }
    }
    const applySignatureFile = async (file) => {
        if (!file) return
        try {
            selectedSignature = await compressImage(file)
            paintPhotos()
            // Warn-only signature sanity check (never blocks saving)
            checkSignatureImage(file).then(r => {
                if (r && (r.verdict === 'blank' || r.verdict === 'photo') && r.message) {
                    showToast(r.message, 'warning')
                }
            }).catch(() => {})
        } catch (err) {
            console.error('Signature compression failed:', err)
            showToast('Could not read that photo. Try another.', 'error')
        }
    }

    passportInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0]
        // Clear value so picking the same file twice still fires change.
        e.target.value = ''
        await applyPassportFile(file)
    })
    signatureInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        await applySignatureFile(file)
    })

    // Camera buttons: shared offline picker (in-app camera -> native camera).
    const runCameraFor = async (kind) => {
        const { pickImageFile } = await import('../../utils/photoPicker.js')
        const file = await pickImageFile({ title: kind === 'signature' ? 'Add signature photo' : 'Add passport photo' })
        if (!file) return
        try {
            const dataUrl = await compressImage(file)
            if (kind === 'signature') {
                selectedSignature = dataUrl
                checkSignatureImage(file).then(r => {
                    if (r && (r.verdict === 'blank' || r.verdict === 'photo') && r.message) {
                        showToast(r.message, 'warning')
                    }
                }).catch(() => {})
            } else {
                selectedPassport = dataUrl
            }
            paintPhotos()
        } catch (err) {
            console.error('Camera photo compression failed:', err)
        }
    }

    // Add/change chooser popovers (Camera / Gallery / Remove-when-present).
    const closeChoosers = () => {
        container.querySelector('#passport-chooser')?.classList.add('hidden')
        container.querySelector('#signature-chooser')?.classList.add('hidden')
    }
    const openChooser = (kind) => {
        const other = kind === 'passport' ? '#signature-chooser' : '#passport-chooser'
        container.querySelector(other)?.classList.add('hidden')
        container.querySelector(kind === 'passport' ? '#passport-chooser' : '#signature-chooser')?.classList.remove('hidden')
    }
    container.querySelector('#passport-camera')?.addEventListener('click', () => { closeChoosers(); runCameraFor('passport') })
    container.querySelector('#signature-camera')?.addEventListener('click', () => { closeChoosers(); runCameraFor('signature') })
    // Gallery buttons trigger the hidden file inputs (plain chooser, offline).
    container.querySelector('#passport-gallery')?.addEventListener('click', () => { closeChoosers(); passportInput?.click() })
    container.querySelector('#signature-gallery')?.addEventListener('click', () => { closeChoosers(); signatureInput?.click() })

    // Remove photo / signature (edit mode: saving persists the removal —
    // updateMember writes null when the key is present with a null value)
    container.querySelector('#passport-remove')?.addEventListener('click', () => {
        selectedPassport = null
        if (passportInput) passportInput.value = ''
        closeChoosers()
        paintPhotos()
    })
    container.querySelector('#signature-remove')?.addEventListener('click', () => {
        selectedSignature = null
        if (signatureInput) signatureInput.value = ''
        closeChoosers()
        paintPhotos()
    })

    // Fullscreen preview — same look as the members table. Single click on
    // a shown image opens it; click anywhere or Escape closes.
    const hidePhotoPreview = () => document.getElementById('mf-photo-preview')?.remove()
    const showPhotoPreview = (src, title) => {
        if (!src) return
        hidePhotoPreview()
        const g = (n) => container.querySelector(`input[name="${n}"]`)?.value || ''
        const name = [g('last_name'), g('first_name'), g('middle_name')].map(s => String(s || '').trim()).filter(Boolean).join(' ') || member?.name || ''
        const overlay = document.createElement('div')
        overlay.className = 'mf-photo-overlay'
        overlay.id = 'mf-photo-preview'
        overlay.innerHTML = `<div class="mf-photo-wrap">
            <img src="${src}" alt="${escapeHtml(title)}" draggable="false">
            <div class="mf-photo-name">${escapeHtml(name ? `${name} — ${title}` : title)}</div>
        </div>`
        overlay.addEventListener('click', hidePhotoPreview)
        document.body.appendChild(overlay)
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') {
                hidePhotoPreview()
                document.removeEventListener('keydown', onKey)
            }
        })
    }

    // Thumb clicks: image present -> fullscreen preview; empty ->
    // straight to the add chooser. Edit buttons open the chooser.
    const bindPhotoSlot = (kind) => {
        const wrap = container.querySelector(kind === 'passport' ? '#passport-preview-wrap' : '#signature-preview-wrap')
        const editBtn = container.querySelector(kind === 'passport' ? '#passport-edit' : '#signature-edit')
        const hasImage = () => kind === 'passport' ? !!selectedPassport : !!selectedSignature
        const onThumb = (e) => {
            e?.stopPropagation?.()
            if (hasImage()) {
                closeChoosers()
                showPhotoPreview(kind === 'passport' ? selectedPassport : selectedSignature, kind === 'passport' ? 'Passport Photo' : 'Signature')
            } else {
                openChooser(kind)
            }
        }
        wrap?.addEventListener('click', onThumb)
        wrap?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onThumb(e) }
        })
        editBtn?.addEventListener('click', (e) => { e?.stopPropagation?.(); openChooser(kind) })
    }
    bindPhotoSlot('passport')
    bindPhotoSlot('signature')
    container.addEventListener('click', (e) => {
        if (!e.target.closest('.bio-photo')) closeChoosers()
    })
    // Bound once globally (form re-renders per navigation) — Escape closes
    // any open add/change chooser.
    if (!document.__mfChooserKeyBound) {
        document.__mfChooserKeyBound = true
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') document.querySelectorAll('.bio-chooser').forEach(c => c.classList.add('hidden'))
        })
    }
    paintPhotos()

    // Payment-advice helpers: filter, bulk-set visible rows, live total
    const updatePayTotal = () => {
        let sum = 0
        container.querySelectorAll('.pay-advise-input').forEach(inp => {
            if (inp.closest('tr')?.style.display === 'none') return
            sum += parseFloat(inp.value || 0) || 0
        })
        const totalEl = container.querySelector('#pay-advise-total')
        if (totalEl) totalEl.textContent = `Total: ₦${sum.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }
    container.querySelector('#pay-advise-search')?.addEventListener('input', (e) => {
        const term = String(e.target.value || '').trim().toLowerCase()
        container.querySelectorAll('.pay-advise-row').forEach(row => {
            row.style.display = !term || (row.dataset.search || '').includes(term) ? '' : 'none'
        })
        updatePayTotal()
    })
    container.querySelector('#pay-advise-apply')?.addEventListener('click', () => {
        const raw = container.querySelector('#pay-advise-bulk')?.value
        if (raw === '' || raw === undefined) {
            showToast('Enter an amount to apply to visible enterprises.', 'warning')
            return
        }
        container.querySelectorAll('.pay-advise-row').forEach(row => {
            if (row.style.display === 'none') return
            const inp = row.querySelector('.pay-advise-input')
            if (inp && !inp.disabled) inp.value = raw
        })
        updatePayTotal()
    })
    container.querySelectorAll('.pay-advise-input').forEach(inp => {
        inp.addEventListener('input', updatePayTotal)
    })
    updatePayTotal()

    // Manager Dropdown Trigger
    const trigger = container.querySelector('#manager-dropdown-trigger')
    const menu = container.querySelector('#manager-dropdown')
    trigger?.addEventListener('click', (e) => {
        e.stopPropagation()
        menu?.classList.toggle('hidden')
        if (!menu?.classList.contains('hidden')) {
            renderManagerDropdown()
            menu.querySelector('#mgr-dropdown-search')?.focus()
        }
    })

    // Close dropdown on click outside (remove previous form's handler first —
    // renderMembersForm re-runs on every add/edit navigation and would otherwise
    // stack document listeners that reference stale containers).
    if (window._membersFormOutsideClick) {
        document.removeEventListener('click', window._membersFormOutsideClick)
    }
    window._membersFormOutsideClick = (e) => {
        if (!container.isConnected) return
        if (!container.querySelector('#manager-dropdown-trigger')?.parentElement?.contains(e.target)) {
            container.querySelector('#manager-dropdown')?.classList.add('hidden')
        }
    }
    document.addEventListener('click', window._membersFormOutsideClick)

    // Tab switcher
    container.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeFormTab = btn.dataset.tab
            btn.classList.remove('has-error')
            updateFormTabs()
        })
    })

    // Jump to the tab holding the first invalid field so required errors on
    // hidden tabs are visible (native bubbles only show on visible fields).
    // Also flags the tab button until the user edits inside it.
    const memberFormEl = container.querySelector('#member-form')
    memberFormEl?.addEventListener('invalid', (e) => {
        const field = e.target
        const pane = field.closest?.('#tab-bio, #tab-work, #tab-nok, #tab-pay')
        if (pane) {
            const tabId = pane.id.replace('tab-', '')
            if (tabId !== activeFormTab) {
                activeFormTab = tabId
                updateFormTabs()
            }
            container.querySelector(`.tab-btn[data-tab="${tabId}"]`)?.classList.add('has-error')
        }
    }, true)
    memberFormEl?.addEventListener('input', (e) => {
        const pane = e.target.closest?.('#tab-bio, #tab-work, #tab-nok, #tab-pay')
        if (pane) {
            container.querySelector(`.tab-btn[data-tab="${pane.id.replace('tab-', '')}"]`)?.classList.remove('has-error')
        }
    }, true)

    // Back & Cancel
    const goBack = () => window.location.hash = 'members'
    container.querySelector('#back-to-list-btn')?.addEventListener('click', goBack)
    container.querySelector('#cancel-btn')?.addEventListener('click', goBack)

    // Save & Add Another flag (add-mode only button; read by the submit handler)
    let saveAndAdd = false
    container.querySelector('#save-add-btn')?.addEventListener('click', () => {
        saveAndAdd = true
        container.querySelector('#member-form')?.requestSubmit()
    })

    // DUPLICATE CHECK LOGIC — coop-scoped (not manager-filtered) so a member
    // created by another manager / device still warns. Falls back to the
    // in-memory filtered list if the full coop read fails (offline edge).
    let coopMembersCache = null
    try {
        coopMembersCache = await getAllForCoop(String(user.cooperativeId), 'members')
    } catch { coopMembersCache = null }
    const dupScope = () => (Array.isArray(coopMembersCache) && coopMembersCache.length >= 0)
        ? coopMembersCache
        : getAllMembers()
    const mobileInput = container.querySelector('#mobile-input')
    const errorDiv = container.querySelector('#duplicate-error')
    mobileInput?.addEventListener('input', (e) => {
        const val = normalizePhone(e.target.value || '')
        if (val.length >= 7) {
            const isDup = dupScope().some(m => normalizePhone(m.mobile || '') === val && String(m.id) !== String(member?.id))
            if (isDup) errorDiv.classList.remove('hidden')
            else errorDiv.classList.add('hidden')
        } else {
            errorDiv.classList.add('hidden')
        }
    })

    // SPECIAL ID DUPLICATE CHECK LOGIC (trim + case-insensitive; blanks never collide)
    const specialIdInput = container.querySelector('#special-id-input')
    const specialIdErrorDiv = container.querySelector('#special-id-duplicate-error')
    specialIdInput?.addEventListener('input', (e) => {
        const val = normalizeSpecialId(e.target.value)
        if (val) {
            const key = String(val).toLowerCase()
            const isDup = dupScope().some(m => String(m.special_id || '').trim().toLowerCase() === key && String(m.id) !== String(member?.id))
            if (isDup) specialIdErrorDiv.classList.remove('hidden')
            else specialIdErrorDiv.classList.add('hidden')
        } else {
            specialIdErrorDiv.classList.add('hidden')
        }
    })

    // PASSWORD RESET
    container.querySelector('#reset-pwd-btn')?.addEventListener('click', async () => {
        const newPwd = '123456'
        if (confirm(`Reset PIN to ${newPwd}? The member will set a new PIN on next login.`)) {
            try {
                await updateMember(member.id, { ...member, password_hash: newPwd, force_password_change: true }, user.username)
                showToast(`PIN successfully reset to: ${newPwd}`, 'success')
            } catch (err) {
                showToast("Reset failed: " + err.message, 'error')
            }
        }
    })

    // FORM SUBMISSION
    container.querySelector('#member-form').addEventListener('submit', async (e) => {
        e.preventDefault()
        const submitBtn = container.querySelector('#save-member-btn')
        const fd = new FormData(e.target)

        // NORMALIZATION: Mobile Number (Last 10 Digits)
        const normalizePhone = (num) => {
            const cleaned = (num || '').replace(/\D/g, '')
            return cleaned.length > 10 ? cleaned.slice(-10) : cleaned
        }

        const rawMobile = fd.get('mobile')
        const normalizedMobile = normalizePhone(rawMobile)
        
        // NORMALIZATION: Special ID (trim; search is case-insensitive via special_id_lower)
        const rawSpecialId = fd.get('special_id')
        const normalizedSpecialId = normalizeSpecialId(rawSpecialId)
        
        // PROPER CASE: Names
        const properCase = (str) => (str || '').trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')

        const data = {
            cooperative_id: user.cooperativeId,
            prefix: String(fd.get('prefix') || '').trim(),
            last_name: properCase(fd.get('last_name')),
            first_name: properCase(fd.get('first_name')),
            middle_name: properCase(fd.get('middle_name')),
            email: fd.get('email') ? String(fd.get('email')).trim().toLowerCase() : null,
            mobile: normalizedMobile,
            special_id: normalizedSpecialId,
            status: fd.get('status'),
            sex: fd.get('sex'),
            date_joined: fd.get('date_joined'),
            dob: fd.get('dob') || '',
            marital_status: fd.get('marital_status') ? String(fd.get('marital_status')).trim() : '',
            employer: fd.get('employer')?.trim(),
            department: fd.get('department')?.trim(),
            position: fd.get('position')?.trim(),
            address: fd.get('address')?.trim(),
            nok_name: properCase(fd.get('nok_name')),
            nok_relationship: fd.get('nok_relationship')?.trim(),
            nok_mobile: normalizePhone(fd.get('nok_mobile')),
            nok_address: fd.get('nok_address')?.trim(),
            bank_name: fd.get('bank_name')?.trim(),
            account_number: fd.get('account_number')?.trim(),
            account_name: properCase(fd.get('account_name')),
            account_manager: selectedManagers.join(','),
            image_path: selectedPassport,
            signature_path: selectedSignature,
            payment_advise: Array.from(container.querySelectorAll('.pay-advise-input')).filter(inp => !inp.disabled).map(inp => ({
                enterprise_id: inp.dataset.entId,
                amount: parseFloat(inp.value || 0)
            }))
        }

        // Check for duplicates before submission — fresh coop-scoped read so a
        // member synced/created after the form opened still blocks. The data
        // layer re-checks anyway (defense in depth); this is for instant UX.
        let submitScope = null
        try {
            submitScope = await getAllForCoop(String(user.cooperativeId), 'members')
            coopMembersCache = submitScope
        } catch { submitScope = null }
        const members = Array.isArray(submitScope) ? submitScope : getAllMembers()
        const mobileDup = normalizedMobile
            ? members.some(m => normalizePhone(m.mobile || '') === normalizedMobile && String(m.id) !== String(member?.id))
            : false
        if (mobileDup) {
            showToast('This mobile number is already registered to another member.', 'error')
            errorDiv.classList.remove('hidden')
            return
        }

        if (normalizedSpecialId) {
            const specialIdDup = members.some(m => String(m.special_id || '').trim().toLowerCase() === String(normalizedSpecialId).toLowerCase() && String(m.id) !== String(member?.id))
            if (specialIdDup) {
                showToast('This Special ID is already registered to another member.', 'error')
                specialIdErrorDiv.classList.remove('hidden')
                return
            }
        }

        try {
            submitBtn.disabled = true; submitBtn.innerText = 'Saving...'
            if (isEdit) {
                await updateMember(member.id, data, user.username)
            } else {
                data.password_hash = generateRandom6Digit()
                const res = await addMember(data, user.username)
                if (res?.generatedPassword) {
                    showToast(`Member created! Initial Password: ${res.generatedPassword}`, 'success')
                }
            }
            await loadMembersData(user)
            window.dispatchEvent(new Event('refresh-members'))
            if (saveAndAdd && !isEdit) {
                // Fresh blank form for the next registration (same module, no nav).
                const { renderMembersForm } = await import('./membersForm.js')
                await renderMembersForm(container, user, null)
                return
            }
            goBack()
        } catch (err) {
            saveAndAdd = false
            submitBtn.disabled = false; submitBtn.innerText = 'Save Member'
            showToast("Save failed: " + err.message, 'error')
        }
    })
}
