import { escapeHtml, escapeAttribute } from '../utils/formatters.js'
import { compressImage } from '../utils/imageUtils.js'
import { normalizePhone } from '../utils/normalize.js'
import { submitMembershipRequest } from '../services/data/membershipRequests.js'
import { pickImageFile } from '../utils/photoPicker.js'
import { showToast } from '../services/toastService.js'

const DRAFT_KEY = 'cooplog-join-draft'
const REQ = '<span class="required-star">*</span>'
const OPT = '<span class="field-label-optional">(optional)</span>'

const SYS_CSS = `
<style>
#join-coop-wrap * { box-sizing: border-box; }

#join-coop-wrap {
    min-height: 100dvh;
    height: auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 2rem 1.25rem 3rem;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    background:
        radial-gradient(at 0% 0%, hsla(221, 83%, 93%, 1) 0, transparent 50%),
        radial-gradient(at 100% 0%, hsla(187, 78%, 94%, 1) 0, transparent 50%),
        radial-gradient(at 50% 100%, hsla(221, 83%, 93%, 0.5) 0, transparent 55%),
        var(--bg-main);
    position: relative;
    -webkit-overflow-scrolling: touch;
}
html, body {
    overflow-x: hidden;
    overflow-y: auto;
    height: auto;
    min-height: 100dvh;
    -webkit-overflow-scrolling: touch;
}
#join-coop-wrap::before {
    content: "";
    position: absolute; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2394a3b8' fill-opacity='0.04'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
    pointer-events: none;
}
[data-theme='dark'] #join-coop-wrap {
    background:
        radial-gradient(at 0% 0%, hsla(222, 47%, 11%, 1) 0, transparent 50%),
        radial-gradient(at 100% 0%, hsla(215, 47%, 14%, 1) 0, transparent 50%),
        radial-gradient(at 50% 100%, hsla(222, 47%, 11%, 0.7) 0, transparent 55%),
        #0f172a;
}

#join-coop-wrap .page-shell {
    width: 100%;
    max-width: 1120px;
    position: relative;
    z-index: 1;
}

#join-coop-wrap .page-header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.5rem;
}
#join-coop-wrap .brand-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.8rem;
    background: var(--accent-soft);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent-primary);
}

#join-coop-wrap .page-heading {
    text-align: center;
    margin-bottom: 2rem;
}
#join-coop-wrap .page-title {
    margin: 0 0 0.5rem;
    font-size: clamp(1.6rem, 2.4vw, 2.1rem);
    font-weight: 800;
    color: var(--text-primary);
    letter-spacing: -0.02em;
    line-height: 1.2;
}
#join-coop-wrap .page-sub {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text-muted);
    max-width: 560px;
    margin-inline: auto;
    line-height: 1.55;
}

#join-coop-wrap .main-card {
    background: var(--bg-card);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-premium);
    border: 1px solid var(--border-light);
    overflow: hidden;
}

#join-coop-wrap .card-grid {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 0;
    min-height: 0;
}
#join-coop-wrap .card-side {
    background: linear-gradient(160deg, #0EA5E9 0%, #0369A1 100%);
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 1.25rem;
    color: #fff;
    position: relative;
    overflow: hidden;
}
#join-coop-wrap .card-side::before {
    content: '';
    position: absolute;
    top: -80px; right: -80px;
    width: 200px; height: 200px;
    background: radial-gradient(circle, rgba(255,255,255,0.12) 0%, transparent 70%);
    border-radius: 50%;
}
#join-coop-wrap .card-side::after {
    content: '';
    position: absolute;
    bottom: -60px; left: -60px;
    width: 180px; height: 180px;
    background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
    border-radius: 50%;
}
#join-coop-wrap .side-title {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.88;
    text-align: center;
    z-index: 1;
}
#join-coop-wrap .photo-avatar-wrap {
    position: relative;
    z-index: 1;
    cursor: pointer;
    transition: transform 0.2s;
}
#join-coop-wrap .photo-avatar-wrap:hover {
    transform: scale(1.03);
}
#join-coop-wrap .photo-avatar {
    width: 148px;
    height: 148px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    border: 3px solid rgba(255, 255, 255, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.25);
}
#join-coop-wrap .photo-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
#join-coop-wrap .photo-avatar .photo-ph-ico {
    font-size: 3.2rem;
    opacity: 0.65;
}
#join-coop-wrap .photo-edit-badge {
    position: absolute;
    right: 2px; bottom: 2px;
    width: 36px; height: 36px;
    border-radius: 50%;
    background: #fff;
    color: #0369A1;
    display: grid;
    place-items: center;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);
    border: 2px solid #0EA5E9;
}
#join-coop-wrap .photo-edit-badge svg {
    width: 16px; height: 16px;
    stroke: currentColor;
    stroke-width: 2.2;
    fill: none;
}
#join-coop-wrap .side-hint {
    font-size: 0.78rem;
    opacity: 0.88;
    text-align: center;
    line-height: 1.5;
    z-index: 1;
    max-width: 220px;
}
#join-coop-wrap .side-hint b {
    display: block;
    font-weight: 700;
    margin-bottom: 0.25rem;
    font-size: 0.82rem;
}
#join-coop-wrap .side-tips {
    list-style: none;
    padding: 0; margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    z-index: 1;
    width: 100%;
}
#join-coop-wrap .side-tips li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.76rem;
    opacity: 0.92;
    line-height: 1.45;
}
#join-coop-wrap .side-tips li svg {
    flex-shrink: 0;
    margin-top: 1px;
    width: 15px; height: 15px;
}
#join-coop-wrap .photo-file-hidden {
    display: none !important;
}

#join-coop-wrap .card-body {
    padding: 1.25rem 1.25rem 1.25rem;
}

#join-coop-wrap .reg-section {
    margin-bottom: 0.55rem;
    padding-bottom: 0.55rem;
    border-bottom: 1px solid var(--border-light);
}
#join-coop-wrap .reg-section:last-of-type {
    border-bottom: none;
    padding-bottom: 0;
    margin-bottom: 0;
}
#join-coop-wrap .reg-section-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.45rem;
}
#join-coop-wrap .section-ico {
    width: 32px; height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
}
#join-coop-wrap .section-ico svg {
    width: 17px; height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
}
#join-coop-wrap .reg-section-title {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-primary);
}
#join-coop-wrap .reg-section-sub {
    margin: 0.1rem 0 0;
    font-size: 0.78rem;
    color: var(--text-muted);
}

#join-coop-wrap .reg-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.35rem 0.3rem;
}
#join-coop-wrap .reg-grid.full {
    grid-template-columns: 1fr;
    gap: 0.35rem;
}

#join-coop-wrap .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: relative;
}
#join-coop-wrap .field > span {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary);
    display: inline-flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.25rem;
}
#join-coop-wrap .required-star { color: var(--danger); font-weight: 800; }
#join-coop-wrap .field-label-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.76rem;
}
#join-coop-wrap .field input:not([type=file]):not([type=checkbox]):not([type=radio]),
#join-coop-wrap .field textarea,
#join-coop-wrap .field select {
    width: 100%;
    min-height: 46px;
    padding: 0.72rem 0.9rem;
    border: 1.5px solid var(--border-medium);
    border-radius: var(--radius-md);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 0.92rem;
    font-family: inherit;
    font-weight: 500;
    transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
}
#join-coop-wrap .field textarea {
    min-height: 96px;
    padding: 0.8rem 0.9rem;
    line-height: 1.55;
    resize: vertical;
}
#join-coop-wrap .field input:focus,
#join-coop-wrap .field textarea:focus,
#join-coop-wrap .field select:focus {
    outline: none;
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 3px var(--accent-soft);
    background: var(--bg-card);
}
#join-coop-wrap .field input:disabled,
#join-coop-wrap .field textarea:disabled,
#join-coop-wrap .field select:disabled {
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
    border-color: var(--border-light);
    opacity: 0.9;
}
#join-coop-wrap .validation-message {
    display: block;
    font-size: 0.76rem;
    color: var(--danger);
    min-height: 0;
    line-height: 1.3;
    font-weight: 500;
}
#join-coop-wrap .validation-message.has-msg { padding-top: 0.15rem; }

#join-coop-wrap .alert-info {
    background: var(--accent-soft);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: var(--accent-primary);
    padding: 1rem 1.05rem;
    border-radius: var(--radius-md);
    font-size: 0.85rem;
    line-height: 1.6;
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
}
#join-coop-wrap .alert-info svg { flex-shrink: 0; margin-top: 0.1rem; }
#join-coop-wrap .alert-info strong { color: var(--accent-primary); font-weight: 700; }

#join-coop-wrap .alert-error {
    background: var(--danger-bg);
    border: 1px solid var(--danger);
    color: var(--danger);
    padding: 0.8rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.85rem;
    line-height: 1.5;
    font-weight: 500;
}
#join-coop-wrap .alert-error.top { margin-bottom: 1.25rem; }
#join-coop-wrap .alert-error.inline { margin-bottom: 0.75rem; }
#join-coop-wrap .alert-error .retry-btn { margin-top: 0.75rem; }
#join-coop-wrap .retry-btn button {
    min-height: 40px;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    font-weight: 600;
    border-radius: var(--radius-md);
    border: none;
    background: var(--accent-primary);
    color: #fff;
    cursor: pointer;
    transition: all 0.2s;
}
#join-coop-wrap .retry-btn button:hover { background: var(--accent-hover); }
#join-coop-wrap .retry-btn button:disabled {
    opacity: 0.5; cursor: not-allowed;
}

#join-coop-wrap .reg-actions {
    display: flex;
    gap: 0.65rem;
    margin-top: 0.8rem;
    border-top: 1px solid var(--border-light);
    padding-top: 0.9rem;
    align-items: stretch;
}
#join-coop-wrap .reg-actions button {
    min-height: 48px;
    border-radius: var(--radius-md);
    font-weight: 700;
    padding: 0 1.25rem;
    flex: 1;
    cursor: pointer;
    font-size: 0.95rem;
    border: none;
    transition: all 0.18s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
}
#join-coop-wrap .reg-actions .flex-2 { flex: 2; }
#join-coop-wrap .btn-loading { opacity: 0.75; cursor: not-allowed !important; }

#join-coop-wrap .success-card { padding: 3rem 2rem 2.5rem; text-align: center; }
#join-coop-wrap .success-card .success-ico-wrap {
    width: 72px; height: 72px;
    border-radius: 50%;
    background: var(--success-bg);
    display: grid;
    place-items: center;
    margin: 0 auto 1.25rem;
    box-shadow: 0 10px 24px rgba(22, 163, 74, 0.15);
}
#join-coop-wrap .success-card .check-mark {
    font-size: 2.4rem;
    display: inline-block;
    line-height: 1;
}
#join-coop-wrap .success-card h1 {
    margin: 0 0 0.75rem;
    font-weight: 800;
    font-size: 1.5rem;
    color: var(--text-primary);
    letter-spacing: -0.02em;
}
#join-coop-wrap .success-card .success-body {
    color: var(--text-secondary);
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
    line-height: 1.6;
}
#join-coop-wrap .success-card .success-note {
    color: var(--text-muted);
    font-size: 0.85rem;
    margin-bottom: 2rem;
    line-height: 1.6;
    max-width: 480px;
    margin-inline: auto;
}
#join-coop-wrap .success-card [data-action="go-login"] {
    min-height: 48px;
    padding: 0 1.5rem;
    border-radius: var(--radius-md);
    border: none;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    box-shadow: 0 6px 16px var(--accent-soft);
}
#join-coop-wrap .success-card [data-action="go-login"]:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
}

@media (min-width: 1200px) {
    #join-coop-wrap .card-grid { grid-template-columns: 300px 1fr; }
    #join-coop-wrap .photo-avatar { width: 160px; height: 160px; }
}

@media (max-width: 860px) {
    #join-coop-wrap { padding: 1.25rem 0.75rem 2rem; }
    #join-coop-wrap .card-grid { grid-template-columns: 1fr; }
    #join-coop-wrap .card-side {
        padding: 1.75rem 1.25rem 1.5rem;
        gap: 1rem;
    }
    #join-coop-wrap .side-tips { display: none; }
    #join-coop-wrap .photo-avatar { width: 120px; height: 120px; }
    #join-coop-wrap .photo-avatar .photo-ph-ico { font-size: 2.4rem; }
    #join-coop-wrap .photo-edit-badge { width: 32px; height: 32px; }
    #join-coop-wrap .card-body { padding: 1.5rem 1.1rem 1.5rem; }
}

@media (max-width: 560px) {
    #join-coop-wrap .page-header-bar {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.75rem;
    }
    #join-coop-wrap .page-heading { margin-bottom: 1.25rem; }
    #join-coop-wrap .reg-grid { grid-template-columns: 1fr; gap: 0.6rem; }
    #join-coop-wrap .reg-actions {
        flex-direction: column-reverse;
        gap: 0.7rem;
        margin-top: 1.25rem;
        padding-top: 1.25rem;
    }
    #join-coop-wrap .reg-actions button { width: 100%; }
    #join-coop-wrap .alert-info { flex-direction: column; gap: 0.6rem; }
    #join-coop-wrap .success-card { padding: 2rem 1.25rem 2rem; }
}
</style>
`

function normalizePhoneStrict(raw) {
    if (!raw) return ''
    const s = String(raw).replace(/[-\s()]/g, '')
    return s
}

function validateJoinForm(values) {
    const errors = {}
    if (!values.cooperative_id || String(values.cooperative_id).trim() === '') {
        errors.cooperative_id = 'Please select a cooperative from the list.'
    }
    if (!values.last_name || String(values.last_name).trim().length < 2) {
        errors.last_name = 'Last name is required (min. 2 characters).'
    }
    if (!values.first_name || String(values.first_name).trim().length < 2) {
        errors.first_name = 'First name is required (min. 2 characters).'
    }
    const phone = normalizePhoneStrict(values.mobile)
    if (!phone || !/^[+\d]/.test(phone) || phone.replace(/\D/g, '').length < 8) {
        errors.mobile = 'Enter a valid mobile number (min. 8 digits).'
    }
    return errors
}

function buildJoinHtml(ctx) {
    const {
        coops, coopsLoading, coopsError,
        submitted, selectedCoopName,
        formValues, errors, topError, submitError,
        isSubmitting, photoPreviewHtml, preSelectedCoopShortName, selectedPhoto
    } = ctx
    const v = formValues || {}
    const errs = errors || {}
    const lockAttr = isSubmitting ? 'disabled' : ''
    let listBroken
    if (preSelectedCoopShortName) {
        const preCoop = coops.find(c => c.shortName === preSelectedCoopShortName || c.short_name === preSelectedCoopShortName)
        if (preCoop) {
            listBroken = coopsError || isSubmitting
        } else {
            listBroken = coopsLoading || coopsError || isSubmitting
        }
    } else {
        listBroken = coopsLoading || coopsError || isSubmitting
    }
    const submitDisabled = listBroken ? 'disabled' : ''

    function fieldError(key) {
        const msg = errs[key]
        if (!msg) return '<span class="validation-message"></span>'
        return `<span class="validation-message has-msg">${escapeHtml(msg)}</span>`
    }

    const ERR_BORDER_STYLE = 'border: 1.5px solid var(--danger); box-shadow: 0 0 0 3px var(--danger-bg); outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease;'

    function fieldBorderErr(key) {
        return errs[key] ? ` style="${ERR_BORDER_STYLE}"` : ''
    }

    const photoErr = !!errs.image_path
    const photoBorderStyle = photoErr
        ? 'border: 1.5px dashed var(--danger); box-shadow: 0 0 0 3px var(--danger-bg);'
        : ''

    let coopFieldHtml
    if (preSelectedCoopShortName) {
        const preCoop = coops.find(c => c.shortName === preSelectedCoopShortName || c.short_name === preSelectedCoopShortName)
        if (preCoop) {
            coopFieldHtml = `
                <input type="hidden" name="cooperative_id" value="${escapeAttribute(preCoop.id)}" />
                <input type="text" value="${escapeAttribute(preCoop.name)}" disabled readonly />
                <span class="validation-message"></span>
            `
        } else if (coopsLoading) {
            coopFieldHtml = `
                <input type="hidden" name="cooperative_id" value="${escapeAttribute(preSelectedCoopShortName)}" />
                <input type="text" value="Loading cooperative details…" disabled readonly
                    style="color: var(--text-muted); font-style: italic;" />
                ${fieldError('cooperative_id')}
            `
        } else if (coopsError) {
            coopFieldHtml = `
                <div class="alert-error inline">
                    ⚠️ Could not load cooperatives. Please check your internet connection and try again.
                    <div class="retry-btn">
                        <button type="button" class="secondary-button" id="join-retry-btn" ${lockAttr}>Retry Loading Cooperatives</button>
                    </div>
                </div>
                <input type="hidden" name="cooperative_id" value="${escapeAttribute(preSelectedCoopShortName)}" />
                <input type="text" value="${escapeAttribute(preSelectedCoopShortName)}" disabled readonly />
                ${fieldError('cooperative_id')}
            `
        } else {
            coopFieldHtml = `
                <div class="alert-error inline">
                    ⚠️ Cooperative not found. The link may be invalid or the cooperative is no longer available.
                </div>
                <input type="hidden" name="cooperative_id" value="${escapeAttribute(preSelectedCoopShortName)}" />
                <span class="validation-message"></span>
            `
        }
    } else if (coopsLoading) {
        coopFieldHtml = `
            <select id="join-coop" name="cooperative_id" required disabled>
                <option value="">Loading cooperatives…</option>
            </select>
            <span class="validation-message"></span>
        `
    } else if (coopsError) {
        coopFieldHtml = `
            <div class="alert-error inline">
                ⚠️ Could not load cooperatives. Please check your internet connection and try again.
                <div class="retry-btn">
                    <button type="button" class="secondary-button" id="join-retry-btn" ${lockAttr}>Retry Loading Cooperatives</button>
                </div>
            </div>
            <select id="join-coop" name="cooperative_id" required disabled${fieldBorderErr('cooperative_id')}>
                <option value="">— No cooperatives loaded —</option>
            </select>
            ${fieldError('cooperative_id')}
        `
    } else {
        coopFieldHtml = `
            <select id="join-coop" name="cooperative_id" required ${lockAttr}${fieldBorderErr('cooperative_id')}>
                <option value="">— Select Cooperative —</option>
                ${coops.map(c => `<option value="${escapeAttribute(c.id)}" ${v.cooperative_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
            ${fieldError('cooperative_id')}
        `
    }

    if (submitted) {
        return SYS_CSS + `
            <div id="join-coop-wrap">
                <div class="page-shell">
                    <div class="page-header-bar">
                        <span class="brand-badge">CoopLog &middot; Join Request</span>
                    </div>
                    <div class="page-heading">
                        <h1 class="page-title">Join an Existing Cooperative</h1>
                        <p class="page-sub">Request membership and get access to your cooperative's workspace.</p>
                    </div>
                    <div class="main-card">
                        <div class="success-card">
                            <div class="success-ico-wrap">
                                <span class="check-mark">✅</span>
                            </div>
                            <h1>Request Submitted!</h1>
                            <p class="success-body">
                                Your application to join <strong>${escapeHtml(selectedCoopName || 'the cooperative')}</strong> has been successfully sent for review.
                            </p>
                            <p class="success-note">
                                The cooperative admin will review your application shortly. If approved, you can sign in with your mobile number and the default password <strong>123456</strong>. You will be asked to change it on first login.
                            </p>
                            <button type="button" data-action="go-login">
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                                Back to Login
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `
    }

    const PHOTO_INNER = photoPreviewHtml || '<span class="photo-ph-ico">👤</span>'

    return SYS_CSS + `
        <div id="join-coop-wrap">
        <div class="page-shell">
            <div class="page-header-bar">
                <span class="brand-badge">CoopLog &middot; Join Request</span>
            </div>

            <div class="page-heading">
                <h1 class="page-title">Join an Existing Cooperative</h1>
                <p class="page-sub">Request membership below. The cooperative admin will review your application and approve it.</p>
            </div>

            <div class="main-card">
                <div class="card-grid">
                    <aside class="card-side">
                        <div class="side-title">Passport Photo</div>
                        <div class="photo-avatar-wrap" id="photo-trigger" title="${photoErr ? 'Photo is required — tap to upload' : 'Tap to upload or change photo'}"${photoBorderStyle ? ` style="${photoBorderStyle}"` : ''}>
                            <div class="photo-avatar" id="join-photo-preview">
                                ${PHOTO_INNER}
                                ${ctx.selectedPhoto ? `
                                    <button type="button" class="photo-remove-btn" aria-label="Remove photo" style="
                                        position: absolute;
                                        top: 4px; right: 4px;
                                        width: 28px; height: 28px;
                                        border-radius: 50%;
                                        background: var(--bg-card);
                                        border: 2px solid var(--accent-primary);
                                        color: var(--accent-primary);
                                        font-size: 0.7rem;
                                        display: grid;
                                        place-items: center;
                                        box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);
                                        z-index: 10;
                                        padding: 0;
                                    ">&times;</button>
                                ` : ''}
                            </div>
                            <span class="photo-edit-badge">
                                <svg viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                            </span>
                        </div>
                        <div class="side-hint">
                            <b>Add a passport photo</b>
                            Tap the circle to take a photo or choose from gallery. Clear portrait helps admins approve you quickly.
                        </div>
                        <ul class="side-tips">
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                No payment or activation key
                            </li>
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Works fully offline
                            </li>
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Quick admin review
                            </li>
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Sign in with mobile number
                            </li>
                        </ul>
                        ${errs.image_path ? `<div style="width:100%;z-index:1;background:var(--danger-bg);border:1px solid var(--danger);color:var(--danger);padding:0.4rem 0.6rem;border-radius:var(--radius-md);font-size:0.76rem;font-weight:600;text-align:center;line-height:1.35;">⚠️ ${escapeHtml(errs.image_path)}</div>` : `<div style="width:100%;"></div>`}
                    </aside>

                    <div class="card-body">
                        <form id="join-form" class="form" novalidate>
                            ${topError ? `<div class="alert-error top">${escapeHtml(topError)}</div>` : ''}
                            ${submitError && !isSubmitting ? `<div class="alert-error top">${escapeHtml(submitError)}</div>` : ''}
                            <input type="file" id="join-photo-input" class="photo-file-hidden" accept="image/*" ${lockAttr} aria-label="Upload passport photo" />

                            <section class="reg-section">
                                <div class="reg-section-head">
                                    <span class="section-ico" style="background: rgba(59,130,246,0.1); color: var(--accent-primary);">
                                        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v16"/><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M9 22V12h6v10"/></svg>
                                    </span>
                                    <div>
                                        <h3 class="reg-section-title">Cooperative</h3>
                                        <p class="reg-section-sub">Choose which cooperative you're joining</p>
                                    </div>
                                </div>
                                <div class="reg-grid full">
                                    <label class="field">
                                        <span>Select Cooperative ${REQ}</span>
                                        ${coopFieldHtml}
                                    </label>
                                </div>
                            </section>

                            <section class="reg-section">
                                <div class="reg-section-head">
                                    <span class="section-ico" style="background: rgba(22,163,74,0.1); color: var(--success);">
                                        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                    </span>
                                    <div>
                                        <h3 class="reg-section-title">Personal Information</h3>
                                        <p class="reg-section-sub">Your full legal name as you want it recorded</p>
                                    </div>
                                </div>
                                <div class="reg-grid">
                                    <label class="field">
                                        <span>Surname / Last Name ${REQ}</span>
                                        <input name="last_name" type="text" required placeholder="e.g. Adeyemi"
                                            value="${escapeAttribute(v.last_name || '')}" ${lockAttr}${fieldBorderErr('last_name')} />
                                        ${fieldError('last_name')}
                                    </label>
                                    <label class="field">
                                        <span>First Name ${REQ}</span>
                                        <input name="first_name" type="text" required placeholder="e.g. Tunde"
                                            value="${escapeAttribute(v.first_name || '')}" ${lockAttr}${fieldBorderErr('first_name')} />
                                        ${fieldError('first_name')}
                                    </label>
                                </div>
                                <div class="reg-grid full" style="margin-top: 0.55rem;">
                                    <label class="field">
                                        <span>Middle Name ${OPT}</span>
                                        <input name="middle_name" type="text" placeholder="e.g. Oluwaseun"
                                            value="${escapeAttribute(v.middle_name || '')}" ${lockAttr}${fieldBorderErr('middle_name')} />
                                        ${fieldError('middle_name')}
                                    </label>
                                </div>
                            </section>

                            <section class="reg-section">
                                <div class="reg-section-head">
                                    <span class="section-ico" style="background: rgba(217,119,6,0.1); color: var(--warning);">
                                        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                    </span>
                                    <div>
                                        <h3 class="reg-section-title">Contact Details</h3>
                                        <p class="reg-section-sub">How the cooperative can reach you</p>
                                    </div>
                                </div>
                                <div class="reg-grid">
                                    <div style="display: flex; flex-direction: column; gap: 1rem;">
                                    <label class="field">
                                        <span>Mobile Number ${REQ}</span>
                                        <input name="mobile" type="tel" required placeholder="08012345678"
                                            value="${escapeAttribute(v.mobile || '')}" ${lockAttr}${fieldBorderErr('mobile')} />
                                        ${fieldError('mobile')}
                                    </label>
                                </div>
                                </div>
                                <div class="reg-grid full" style="margin-top: 0.55rem;">
                                    <label class="field">
                                        <span>Residential Address ${OPT}</span>
                                        <textarea name="address" rows="3" placeholder="Street, city, state…" ${lockAttr}${fieldBorderErr('address')}>${escapeHtml(v.address || '')}</textarea>
                                        ${fieldError('address')}
                                    </label>
                                </div>
                            </section>

                            <div class="alert-info">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                <div>
                                    <strong>No payment or activation key required.</strong><br/>
                                    Your application will be reviewed by the cooperative admin. Once approved, you can sign in with your mobile number.
                                    Default password: <strong>123456</strong> (you will be asked to change it on first login).
                                </div>
                            </div>

                            <div class="reg-actions">
                                <button type="button" class="secondary-button" id="join-back-btn" ${isSubmitting ? 'disabled' : ''}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                                    Back
                                </button>
                                <button type="submit" class="primary-button flex-2 ${isSubmitting ? 'btn-loading' : ''}" id="join-submit-btn" ${submitDisabled}>
                                    ${isSubmitting
                                        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 0.9s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Submitting…`
                                        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit Request`
                                    }
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </div>
        </div>
        <style>@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }</style>
    `
}

export async function renderJoinCooperative(container, onBack, preSelectedCoopShortName) {
    const SUBMITTED_KEY = 'cooplog-join-submitted'
    const state = {
        coops: [],
        coopsLoading: true,
        coopsError: false,
        submitted: false,
        selectedCoopName: '',
        formValues: {},
        photoPreviewHtml: null,
        selectedPhoto: null,
        errors: {},
        topError: '',
        submitError: '',
        isSubmitting: false,
        preSelectedCoopShortName: preSelectedCoopShortName || ''
    }
    try {
        const stored = sessionStorage.getItem(SUBMITTED_KEY)
        if (stored === '1') state.submitted = true
    } catch (e) { /* ignore */ }

    function render() {
        try {
            const stored = sessionStorage.getItem(SUBMITTED_KEY)
            if (stored === '1' && !state.submitted) state.submitted = true
        } catch (e) { /* ignore */ }
        if (!state.selectedCoopName && state.formValues.cooperative_id) {
            const match = state.coops.find(c => c.id === state.formValues.cooperative_id)
            if (match) state.selectedCoopName = match.name
        }
        container.innerHTML = buildJoinHtml({
            coops: state.coops,
            coopsLoading: state.coopsLoading,
            coopsError: state.coopsError,
            submitted: state.submitted,
            selectedCoopName: state.selectedCoopName,
            formValues: state.formValues,
            preSelectedCoopShortName: state.preSelectedCoopShortName,
            selectedPhoto: state.selectedPhoto,
            errors: state.errors,
            topError: state.topError,
            submitError: state.submitError,
            isSubmitting: state.isSubmitting,
            photoPreviewHtml: state.photoPreviewHtml
        })
        bindEvents()
    }

    function saveDraft() {
        try {
            const snapshot = { ...state.formValues }
            sessionStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot))
        } catch (e) { /* ignore */ }
    }
    function clearDraft() {
        try { sessionStorage.removeItem(DRAFT_KEY) } catch (e) {}
    }

    function bindEvents() {
        const form = container.querySelector('#join-form')
        const backBtn = container.querySelector('#join-back-btn')
        const retryBtn = container.querySelector('#join-retry-btn')
        const photoInput = container.querySelector('#join-photo-input')
        const photoPreview = container.querySelector('#join-photo-preview')
        const coopSelect = container.querySelector('#join-coop')

        if (backBtn) backBtn.addEventListener('click', () => {
            if (state.isSubmitting) return
            try { sessionStorage.removeItem(SUBMITTED_KEY) } catch (_) { /* ignore */ }
            if (typeof onBack === 'function') onBack()
        })
        if (retryBtn) retryBtn.addEventListener('click', () => loadCooperatives())

        const goLoginBtn = container.querySelector('[data-action="go-login"]')
        if (goLoginBtn) goLoginBtn.addEventListener('click', () => {
            try { sessionStorage.removeItem(SUBMITTED_KEY) } catch (_) { /* ignore */ }
            clearDraft()
            state.submitted = false
            // Ensure parent-level routing re-hydration sees a clean URL hash, not the join link
            // that would otherwise re-trigger join screen on the next render.
            try {
                if (window.parent === window) {
                    // no-op: the global delegated 'go-login' handler in main.js
                    // will rewrite the URL hash to #login for join/register routes.
                }
            } catch (_) { /* ignore cross-origin */ }
        })

        if (photoInput) {
            const photoTrigger = container.querySelector('#photo-trigger')
            if (photoTrigger) {
                const uploadDisabled = state.isSubmitting
                if (!uploadDisabled) {
                    photoTrigger.addEventListener('click', async (e) => {
                        e.preventDefault()
                        try {
                            const file = await pickImageFile({ title: 'Add passport photo' })
                            if (file) {
                                state.selectedPhoto = await compressImage(file)
                                state.photoPreviewHtml = `<img src="${state.selectedPhoto}" alt="Photo preview" />`
                                if (photoPreview) photoPreview.innerHTML = state.photoPreviewHtml
                            }
                        } catch (err) {
                            console.error('Photo selection failed:', err)
                        }
                    })
                    photoTrigger.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); /* picker invoked via click above */ }
                    })
                } else {
                    photoTrigger.style.cursor = 'not-allowed'
                    photoTrigger.style.opacity = '0.6'
                }
                photoTrigger.setAttribute('role', 'button')
                photoTrigger.setAttribute('tabindex', uploadDisabled ? '-1' : '0')
            }
        }

        if (coopSelect) {
            coopSelect.addEventListener('change', () => {
                const opt = coopSelect.options[coopSelect.selectedIndex]
                state.selectedCoopName = opt && coopSelect.value ? opt.text : ''
                if (form) {
                    const fd = new FormData(form)
                    state.formValues = Object.fromEntries(fd.entries())
                    state.formValues.cooperative_id = coopSelect.value || ''
                    saveDraft()
                }
            })

            // Handle remove photo button
            const photoRemoveBtn = container.querySelector('.photo-remove-btn')
            if (photoRemoveBtn) {
                photoRemoveBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    state.selectedPhoto = null
                    state.photoPreviewHtml = null
                    if (photoPreview) photoPreview.innerHTML = `<span class="photo-ph-ico">👤</span>`
                    // Reset the file input value
                    const photoInput = container.querySelector('#join-photo-input')
                    if (photoInput) photoInput.value = ''
                    saveDraft()
                })
            }
        }

        if (photoInput) {
            photoInput.addEventListener('change', async (e) => {
                const file = e.target.files[0]
                if (!file) return
                try {
                    state.selectedPhoto = await compressImage(file)
                    state.photoPreviewHtml = `<img src="${state.selectedPhoto}" alt="Photo preview" />`
                    if (photoPreview) photoPreview.innerHTML = state.photoPreviewHtml
                } catch (err) {
                    console.error('Photo compression failed:', err)
                }
            })
        }

        if (form) {
            form.addEventListener('input', () => {
                const fd = new FormData(form)
                state.formValues = Object.fromEntries(fd.entries())
                saveDraft()
            })

            form.addEventListener('submit', async (e) => {
                e.preventDefault()
                if (state.isSubmitting) return

                // Determine whether submission is blocked — mirrors submitDisabled
                // logic in buildJoinHtml so the submit button state and handler
                // guard always agree (handles cache-hit pre-selection even while
                // background coop list refresh is still loading).
                let submitBlocked = state.isSubmitting
                if (state.preSelectedCoopShortName) {
                    const preCoop = state.coops.find(c => c.shortName === state.preSelectedCoopShortName || c.short_name === state.preSelectedCoopShortName)
                    if (preCoop) {
                        submitBlocked = !!state.coopsError
                    } else {
                        submitBlocked = !!state.coopsLoading || !!state.coopsError
                    }
                } else {
                    submitBlocked = !!state.coopsLoading || !!state.coopsError
                }
                if (submitBlocked) {
                    const reason = state.coopsError
                        ? 'Cooperative list failed to load — please check your connection and tap Retry above before submitting.'
                        : 'Please wait for the cooperative list to finish loading before submitting.'
                    state.topError = reason
                    render()
                    showToast(`Submit blocked: ${reason}`, 'warning')
                    return
                }

                const fd = new FormData(form)
                state.formValues = Object.fromEntries(fd.entries())

                const errors = validateJoinForm(state.formValues)
                state.errors = errors
                state.topError = Object.keys(errors).length
                    ? 'Please fix the errors below.'
                    : (state.topError || '')
                state.submitError = ''

                // Photo is optional — allow submission without a selected image.
                // The image_path will be null if no photo was selected or was removed.
                // If a photo was previously selected and removed, it should not be submitted.

                if (Object.keys(errors).length > 0) {
                    render()
                    try {
                        const firstErr = document.querySelector('#join-coop-wrap .validation-message.has-msg, #join-coop-wrap .alert-error.top')
                        if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        else {
                            const wrap = document.getElementById('join-coop-wrap')
                            if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }
                    } catch (_) { /* ignore */ }

                    const fieldLabels = {
                        cooperative_id: 'Cooperative',
                        last_name: 'Last name',
                        first_name: 'First name',
                        mobile: 'Mobile number',
                        address: 'Address',
                        image_path: 'Passport photo'
                    }
                    const firstKey = Object.keys(errors)[0]
                    const firstName = fieldLabels[firstKey] || firstKey
                    const count = Object.keys(errors).length
                    const msg = count === 1
                        ? `Submit failed: ${firstName} — ${errors[firstKey]}`
                        : `Submit failed: ${firstName} (${errors[firstKey]}) and ${count - 1} other required field${count - 1 === 1 ? '' : 's'} need attention.`
                    showToast(msg, 'error')
                    return
                }

                state.isSubmitting = true
                state.submitError = ''
                render()

                // Resolve the true cooperative identifier: prefer the fully-qualified
                // id from a matched coop list entry, else fall back to the raw
                // form value (which may be a short-name placeholder while the
                // list is still loading for a pre-selected direct link).
                let cooperativeId = state.formValues.cooperative_id || state.preSelectedCoopShortName || ''
                if (state.preSelectedCoopShortName) {
                    const preCoop = state.coops.find(c => c.shortName === state.preSelectedCoopShortName || c.short_name === state.preSelectedCoopShortName)
                    if (preCoop) cooperativeId = preCoop.id
                }
                const lastName = String(state.formValues.last_name || '').trim()
                const firstName = String(state.formValues.first_name || '').trim()
                const middleName = String(state.formValues.middle_name || '').trim()
                const mobileRaw = String(state.formValues.mobile || '').trim()
                const address = String(state.formValues.address || '').trim()

                try {
                    await submitMembershipRequest({
                        cooperative_id: cooperativeId,
                        last_name: lastName,
                        first_name: firstName,
                        middle_name: middleName,
                        mobile: normalizePhone(mobileRaw),
                        address,
                        image_path: state.selectedPhoto
                    })
                    clearDraft()
                    state.formValues = {}
                    state.photoPreviewHtml = null
                    state.selectedPhoto = null
                    state.submitted = true
                    try { sessionStorage.setItem(SUBMITTED_KEY, '1') } catch (_) { /* ignore */ }
                } catch (err) {
                    console.error('Join request failed:', err)
                    state.submitError = 'Submission failed: ' + (err?.message || 'unknown error')
                    showToast(`Submit failed: ${err?.message || 'Please check your connection and try again.'}`, 'error')
                } finally {
                    state.isSubmitting = false
                    render()
                }
            })
        }
    }

    async function loadCooperatives() {
        let shouldRenderBefore = true
        let shouldRenderAfter = true
        try {
            const stored = sessionStorage.getItem(SUBMITTED_KEY)
            if (stored === '1') {
                state.submitted = true
                shouldRenderBefore = false
                shouldRenderAfter = false
            }
        } catch (e) { /* ignore */ }

        if (shouldRenderBefore) {
            state.coopsLoading = true
            state.coopsError = false
            state.topError = ''
            render()
        }
        try {
            const { getAllCooperativesCached } = await import('../services/authService.js')
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timed out. Please check your internet and try again.')), 15000)
            )
            // Same list as the old unbounded getDocs(collection,'cooperatives'),
            // but shared with the login search via a 5-minute cache — re-renders
            // of this screen no longer re-download the whole collection.
            const coopsRaw = await Promise.race([
                getAllCooperativesCached(),
                timeoutPromise
            ])
            state.coops = coopsRaw
                .filter(dat => {
                    return (dat.is_deleted !== 1) && (dat.is_extracted !== true)
                })
                .map(dat => ({
                    id: dat.id,
                    name: dat.full_name || dat.short_name || dat.id,
                    shortName: dat.short_name
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
            state.coopsLoading = false
            if (state.preSelectedCoopShortName) {
                const preCoop = state.coops.find(c => c.shortName === state.preSelectedCoopShortName)
                if (preCoop) {
                    state.selectedCoopName = preCoop.name
                    state.formValues.cooperative_id = preCoop.id
                }
            }
        } catch (err) {
            console.error('[JoinCooperative] Failed to load cooperatives:', err)
            state.coopsLoading = false
            state.coopsError = true
        }
        if (shouldRenderAfter) {
            render()
        }
    }

    try {
        const raw = sessionStorage.getItem(DRAFT_KEY)
        if (raw) {
            const draft = JSON.parse(raw)
            state.formValues = draft || {}
            if (state.preSelectedCoopId) {
                state.formValues.cooperative_id = state.preSelectedCoopShortName
            }
        }
    } catch (e) { /* ignore */ }

    render()
    loadCooperatives()
}
