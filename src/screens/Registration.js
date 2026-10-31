import { registerCooperative } from '../services/dataService.js'
import { escapeHtml, escapeAttribute, wrapDateInput } from '../utils/formatters.js'
import { compressImage } from '../utils/imageUtils.js'
import { pickImageFile } from '../utils/photoPicker.js'
import { showToast } from '../services/toastService.js'

const REQ = '<span class="required-star">*</span>'
const OPT = '<span class="field-label-optional">(optional)</span>'

const SYS_CSS = `
<style>
#registration-wrap * { box-sizing: border-box; }

#registration-wrap {
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
        radial-gradient(at 100% 0%, hsla(217, 91%, 95%, 1) 0, transparent 50%),
        radial-gradient(at 50% 100%, hsla(221, 83%, 93%, 0.6) 0, transparent 55%),
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
#registration-wrap::before {
    content: "";
    position: absolute; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2394a3b8' fill-opacity='0.04'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
    pointer-events: none;
}
[data-theme='dark'] #registration-wrap {
    background:
        radial-gradient(at 0% 0%, hsla(222, 47%, 11%, 1) 0, transparent 50%),
        radial-gradient(at 100% 0%, hsla(222, 47%, 15%, 1) 0, transparent 50%),
        radial-gradient(at 50% 100%, hsla(222, 47%, 11%, 0.7) 0, transparent 55%),
        #0f172a;
}

#registration-wrap .page-shell {
    width: 100%;
    max-width: 1120px;
    position: relative;
    z-index: 1;
}

#registration-wrap .page-header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.5rem;
}
#registration-wrap .brand-badge {
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
#registration-wrap .clear-btn-top {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.9rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-card);
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all 0.2s;
    min-height: 36px;
}
#registration-wrap .clear-btn-top:hover {
    color: var(--danger);
    border-color: var(--danger);
    background: var(--danger-bg);
}

#registration-wrap .page-heading {
    text-align: center;
    margin-bottom: 2rem;
}
#registration-wrap .page-title {
    margin: 0 0 0.5rem;
    font-size: clamp(1.6rem, 2.4vw, 2.1rem);
    font-weight: 800;
    color: var(--text-primary);
    letter-spacing: -0.02em;
    line-height: 1.2;
}
#registration-wrap .page-sub {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text-muted);
    max-width: 560px;
    margin-inline: auto;
    line-height: 1.55;
}

#registration-wrap .main-card {
    background: var(--bg-card);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-premium);
    border: 1px solid var(--border-light);
    overflow: hidden;
}

#registration-wrap .card-grid {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 0;
    min-height: 0;
}
#registration-wrap .card-side {
    background: linear-gradient(160deg, var(--accent-primary) 0%, #1D4ED8 100%);
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 1.5rem;
    color: #fff;
    position: relative;
    overflow: hidden;
}
#registration-wrap .card-side::before {
    content: '';
    position: absolute;
    top: -80px; right: -80px;
    width: 200px; height: 200px;
    background: radial-gradient(circle, rgba(255,255,255,0.12) 0%, transparent 70%);
    border-radius: 50%;
}
#registration-wrap .card-side::after {
    content: '';
    position: absolute;
    bottom: -60px; left: -60px;
    width: 180px; height: 180px;
    background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
    border-radius: 50%;
}
#registration-wrap .side-title {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.85;
    text-align: center;
    z-index: 1;
}
#registration-wrap .logo-avatar-wrap {
    position: relative;
    z-index: 1;
    cursor: pointer;
    transition: transform 0.2s;
}
#registration-wrap .logo-avatar-wrap:hover {
    transform: scale(1.03);
}
#registration-wrap .logo-avatar {
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
#registration-wrap .logo-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
#registration-wrap .logo-avatar .logo-ph-ico {
    font-size: 3rem;
    opacity: 0.6;
}
#registration-wrap .logo-edit-badge {
    position: absolute;
    right: 2px; bottom: 2px;
    width: 36px; height: 36px;
    border-radius: 50%;
    background: #fff;
    color: var(--accent-primary);
    display: grid;
    place-items: center;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);
    border: 2px solid var(--accent-primary);
}
#registration-wrap .logo-edit-badge svg {
    width: 16px; height: 16px;
    stroke: currentColor;
    stroke-width: 2.2;
    fill: none;
}
#registration-wrap .side-hint {
    font-size: 0.78rem;
    opacity: 0.85;
    text-align: center;
    line-height: 1.5;
    z-index: 1;
    max-width: 200px;
}
#registration-wrap .side-hint b {
    display: block;
    font-weight: 700;
    margin-bottom: 0.25rem;
    font-size: 0.82rem;
}
#registration-wrap .side-feature-list {
    list-style: none;
    padding: 0; margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    z-index: 1;
    width: 100%;
}
#registration-wrap .side-feature-list li {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.78rem;
    opacity: 0.92;
    line-height: 1.4;
}
#registration-wrap .side-feature-list li svg {
    flex-shrink: 0;
    width: 16px; height: 16px;
}
#registration-wrap .logo-file-hidden {
    display: none !important;
}

#registration-wrap .card-body {
    padding: 1.25rem 1.25rem 1.25rem;
}

#registration-wrap .reg-section {
    margin-bottom: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-light);
}
#registration-wrap .reg-section:last-of-type {
    border-bottom: none;
    padding-bottom: 0;
    margin-bottom: 0;
}
#registration-wrap .reg-section-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.45rem;
}
#registration-wrap .section-ico {
    width: 32px; height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-primary);
    flex-shrink: 0;
}
#registration-wrap .section-ico svg {
    width: 17px; height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
}
#registration-wrap .reg-section-title {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-primary);
}
#registration-wrap .reg-section-sub {
    margin: 0.1rem 0 0;
    font-size: 0.78rem;
    color: var(--text-muted);
}

#registration-wrap .reg-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.3rem 0.25rem;
}
#registration-wrap .reg-grid.full {
    grid-template-columns: 1fr;
    gap: 0.3rem;
}

#registration-wrap .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: relative;
}
#registration-wrap .field > span {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary);
    display: inline-flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.25rem;
}
#registration-wrap .required-star { color: var(--danger); font-weight: 800; }
#registration-wrap .field-label-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.76rem;
}
#registration-wrap .field input:not([type=file]):not([type=checkbox]):not([type=radio]),
#registration-wrap .field textarea,
#registration-wrap .field select {
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
#registration-wrap .field textarea {
    min-height: 96px;
    padding: 0.8rem 0.9rem;
    line-height: 1.55;
    resize: vertical;
}
#registration-wrap .field input:focus,
#registration-wrap .field textarea:focus,
#registration-wrap .field select:focus {
    outline: none;
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 3px var(--accent-soft);
    background: var(--bg-card);
}
#registration-wrap .field input:disabled,
#registration-wrap .field textarea:disabled,
#registration-wrap .field select:disabled {
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
    border-color: var(--border-light);
    opacity: 0.9;
}
#registration-wrap .validation-message {
    display: block;
    font-size: 0.76rem;
    color: var(--danger);
    min-height: 0;
    line-height: 1.3;
    font-weight: 500;
}
#registration-wrap .validation-message.has-msg { padding-top: 0.15rem; }

#registration-wrap .alert-info {
    background: var(--accent-soft);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: var(--accent-primary);
    padding: 1rem 1.05rem;
    border-radius: var(--radius-md);
    display: flex;
    gap: 0.85rem;
    align-items: flex-start;
    font-size: 0.86rem;
    line-height: 1.55;
}
#registration-wrap .alert-info svg { flex-shrink: 0; margin-top: 0.1rem; }
#registration-wrap .alert-info .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 800;
    letter-spacing: 0.05em;
    background: var(--bg-card);
    padding: 0.12rem 0.45rem;
    border-radius: 6px;
    display: inline-block;
    margin: 0 0.15rem;
}

#registration-wrap .alert-success {
    background: var(--success-bg);
    border: 2px solid var(--success);
    color: var(--success);
    padding: 2rem 1.5rem;
    border-radius: var(--radius-lg);
    text-align: center;
    max-width: 520px;
    margin: 0 auto;
}
#registration-wrap .alert-success .success-ico {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: var(--bg-card);
    display: grid;
    place-items: center;
    margin: 0 auto 1rem;
    font-size: 2.2rem;
    box-shadow: 0 8px 20px var(--accent-soft);
}
#registration-wrap .alert-success .success-title {
    font-size: 1.2rem;
    font-weight: 800;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
}
#registration-wrap .alert-success .success-body {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-bottom: 1rem;
}
#registration-wrap .alert-success .password-badge {
    display: inline-block;
    padding: 0.6rem 1.25rem;
    background: var(--bg-card);
    border: 2px dashed var(--accent-primary);
    border-radius: var(--radius-md);
    margin: 0.25rem 0 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 800;
    font-size: 1.5rem;
    letter-spacing: 0.1em;
    color: var(--accent-primary);
}
#registration-wrap .alert-success .success-note {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0;
}
#registration-wrap .alert-success .success-countdown {
    margin-top: 1rem;
    font-size: 0.78rem;
    color: var(--text-muted);
}

#registration-wrap .alert-error {
    background: var(--danger-bg);
    border: 1px solid var(--danger);
    color: var(--danger);
    padding: 0.8rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.85rem;
    line-height: 1.5;
    font-weight: 500;
}
#registration-wrap .alert-error.top { margin-bottom: 1.25rem; }
#registration-wrap .alert-error.list { margin: 0 0 0.75rem; }

#registration-wrap .key-modal-overlay {
    position: fixed; inset: 0;
    background: rgba(15, 23, 42, 0.6);
    backdrop-filter: blur(5px);
    -webkit-backdrop-filter: blur(5px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 1.25rem;
}
#registration-wrap .key-modal {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-xl);
    width: 100%;
    max-width: 440px;
    padding: 1.75rem 1.5rem;
    box-shadow: 0 30px 80px rgba(15, 23, 42, 0.45);
    text-align: center;
}
#registration-wrap .key-modal .lock-ico {
    width: 56px; height: 56px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent-primary);
    display: grid;
    place-items: center;
    margin: 0 auto 1rem;
    font-size: 1.6rem;
}
#registration-wrap .key-modal h2 {
    margin: 0 0 0.35rem;
    font-weight: 800;
    font-size: 1.15rem;
    color: var(--text-primary);
}
#registration-wrap .key-modal .key-hint {
    color: var(--text-muted);
    font-size: 0.86rem;
    margin: 0 0 0.5rem;
    line-height: 1.5;
}
#registration-wrap .key-modal .key-example {
    display: inline-block;
    margin: 0 0 1rem;
    padding: 0.3rem 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--bg-secondary);
    color: var(--accent-primary);
    border-radius: 8px;
    font-weight: 700;
    letter-spacing: 0.15em;
    font-size: 0.82rem;
}
#registration-wrap .key-modal input.key-entry {
    width: 100%;
    padding: 0.85rem 1rem;
    border: 1.5px solid var(--border-medium);
    border-radius: var(--radius-md);
    background: var(--bg-input);
    color: var(--text-primary);
    text-align: center;
    font-size: 1.2rem;
    letter-spacing: 0.25em;
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    transition: all 0.18s;
}
#registration-wrap .key-modal input.key-entry:focus {
    outline: none;
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 3px var(--accent-soft);
}

#registration-wrap .reg-actions {
    display: flex;
    gap: 0.65rem;
    margin-top: 0.75rem;
    align-items: stretch;
}
#registration-wrap .reg-actions.primary {
    margin-top: 1rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border-light);
}
#registration-wrap .reg-actions button {
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
#registration-wrap .reg-actions .flex-2 { flex: 2; }
#registration-wrap .btn-loading {
    opacity: 0.75;
    cursor: not-allowed !important;
    position: relative;
}

@media (min-width: 1200px) {
    #registration-wrap .card-grid { grid-template-columns: 300px 1fr; }
    #registration-wrap .logo-avatar { width: 168px; height: 168px; }
}

@media (max-width: 860px) {
    #registration-wrap { padding: 1.25rem 0.75rem 2rem; }
    #registration-wrap .card-grid { grid-template-columns: 1fr; }
    #registration-wrap .card-side {
        padding: 1.75rem 1.25rem 1.5rem;
        gap: 1rem;
    }
    #registration-wrap .side-feature-list {
        display: none;
    }
    #registration-wrap .logo-avatar { width: 120px; height: 120px; }
    #registration-wrap .logo-avatar .logo-ph-ico { font-size: 2.4rem; }
    #registration-wrap .logo-edit-badge { width: 32px; height: 32px; }
    #registration-wrap .card-body { padding: 1.25rem 1rem 1.25rem; }
    #registration-wrap .reg-grid { gap: 0.5rem; }
}

@media (max-width: 560px) {
    #registration-wrap .page-header-bar {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.75rem;
    }
    #registration-wrap .page-heading { margin-bottom: 1.25rem; }
    #registration-wrap .reg-grid { grid-template-columns: 1fr; gap: 0.7rem; }
    #registration-wrap .reg-actions { flex-direction: column; gap: 0.7rem; }
    #registration-wrap .reg-actions.primary {
        flex-direction: column-reverse;
        margin-top: 1.5rem;
        padding-top: 1.25rem;
    }
    #registration-wrap .reg-actions button { width: 100%; }
    #registration-wrap .alert-info { flex-direction: column; gap: 0.6rem; }
    #registration-wrap .key-modal-overlay { padding: 0; align-items: flex-end; }
    #registration-wrap .key-modal {
        padding: 1.25rem 1rem calc(1.25rem + env(safe-area-inset-bottom));
        border-radius: 1.25rem 1.25rem 0 0;
        max-width: 100%;
    }
    #registration-wrap .success-wrap { padding: 1.5rem 1rem; }
}
</style>
`

function buildRegistrationHtml(ctx) {
    const {
        awaitingActivationKey,
        activationKeyError,
        formValues,
        errors,
        isSubmitting,
        topError,
        registrationSuccess,
        successPassword,
        selectedLogo
    } = ctx
    const v = formValues || {}
    const errs = errors || {}
    const locked = awaitingActivationKey || isSubmitting
    const lockAttr = locked ? 'disabled' : ''

    const yy = String(new Date().getFullYear()).slice(-2)
    const dd = String(new Date().getDate()).padStart(2, '0')
    const mm = String(new Date().getMonth() + 1).padStart(2, '0')
    const todayKeyExample = `${yy}${dd}${mm}`

    function fieldError(key) {
        const msg = errs[key]
        if (!msg) return '<span class="validation-message"></span>'
        return `<span class="validation-message has-msg">${escapeHtml(msg)}</span>`
    }

    const ERR_BORDER_STYLE = 'border: 1.5px solid var(--danger); box-shadow: 0 0 0 3px var(--danger-bg); outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease;'

    function fieldBorderErr(key) {
        return errs[key] ? ` style="${ERR_BORDER_STYLE}"` : ''
    }

    const logoErr = !!errs.logo_path
    const logoBorderStyle = logoErr
        ? 'border: 1.5px dashed var(--danger); box-shadow: 0 0 0 3px var(--danger-bg);'
        : ''

    const LOGO_AVATAR_INNER = v.logo_path
        ? `<img src="${escapeAttribute(v.logo_path)}" alt="Logo preview" />`
        : `<span class="logo-ph-ico">🏢</span>`

    const LOGO_REMOVE_BTN = selectedLogo
        ? `<button type="button" class="logo-remove-btn" aria-label="Remove logo" style="
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
          ">&times;</button>`
        : ''

    return SYS_CSS + `
        <div id="registration-wrap">
        <div class="page-shell">
            <div class="page-header-bar">
                <span class="brand-badge">CoopLog &middot; Registration</span>
                ${!awaitingActivationKey && !registrationSuccess ? `
                    <button type="button" class="clear-btn-top" id="clear-reg-form-btn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        Clear Form
                    </button>
                ` : ''}
            </div>

            <div class="page-heading">
                <h1 class="page-title">Register Your Cooperative</h1>
                <p class="page-sub">Set up your cooperative workspace in just a few minutes. Fill in your details below to get started.</p>
            </div>

            ${registrationSuccess ? `
                <div class="main-card success-wrap">
                    <div class="card-body" style="padding: 3rem 2rem;">
                        <div class="alert-success" style="border: none; background: transparent; box-shadow: none; padding: 0; max-width: 100%;">
                            <div class="success-ico">✅</div>
                            <div class="success-title">Registration Successful!</div>
                            <p class="success-body">Your cooperative and admin account have been created. Below is your temporary admin password:</p>
                            <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.35rem;">Admin Password</div>
                            <div class="password-badge">${escapeHtml(successPassword || '')}</div>
                            <p class="success-note">Save this password securely. You will be required to change it on first login.</p>
                            <button class="secondary-button" style="margin-top: 1rem; padding: 0.5rem 1rem; font-size: 0.9rem;">OK</button>
                        </div>
                    </div>
                </div>
            ` : `

            <div class="main-card">
                <div class="card-grid">
                    <aside class="card-side">
                        <div class="side-title">Cooperative Logo</div>
                        <div class="logo-avatar-wrap" id="logo-trigger" title="${logoErr ? 'Logo is required — tap to upload' : 'Tap to upload or change logo'}"${logoBorderStyle ? ` style="${logoBorderStyle}"` : ''}>
                            <div class="logo-avatar" id="logo-preview">
                                ${LOGO_AVATAR_INNER}
                                ${LOGO_REMOVE_BTN}
                            </div>
                            <span class="logo-edit-badge">
                                <svg viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                            </span>
                        </div>
                        <div class="side-hint">
                            <b>Add a logo</b>
                            Tap the circle above to upload a cooperative emblem (PNG or JPG). Auto-resized for all devices.
                        </div>
                        <ul class="side-feature-list">
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Offline-ready setup
                            </li>
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Instant admin account
                            </li>
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Member management
                            </li>
                            <li>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Loans, dues & reports
                            </li>
                        </ul>
                    </aside>

                    <div class="card-body">
                        <form id="registration-form" class="form" novalidate>
                            ${topError ? `<div class="alert-error top">${escapeHtml(topError)}</div>` : ''}
                            <input type="file" id="logo-input" class="logo-file-hidden" accept="image/*" ${lockAttr} aria-label="Upload cooperative logo" />

                            <section class="reg-section">
                                <div class="reg-section-head">
                                    <span class="section-ico">
                                        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v16"/><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M9 22V12h6v10"/></svg>
                                    </span>
                                    <div>
                                        <h3 class="reg-section-title">Cooperative Information</h3>
                                        <p class="reg-section-sub">Your cooperative's public identity</p>
                                    </div>
                                </div>
                                <div class="reg-grid">
                                    <label class="field">
                                        <span>Cooperative Full Name ${REQ}</span>
                                        <input name="full_name" type="text" placeholder="e.g. Apex Cooperative Society" required
                                            value="${escapeAttribute(v.full_name || '')}" ${lockAttr}${fieldBorderErr('full_name')} />
                                        ${fieldError('full_name')}
                                    </label>
                                    <label class="field">
                                        <span>Short Name / Acronym ${REQ}</span>
                                        <input name="short_name" type="text" placeholder="e.g. ACS" required
                                            value="${escapeAttribute(v.short_name || '')}" ${lockAttr}${fieldBorderErr('short_name')} />
                                        ${fieldError('short_name')}
                                    </label>
                                    <label class="field">
                                        <span>Contact Phone ${REQ}</span>
                                        <input name="contact_number" type="tel" placeholder="e.g. 08012345678" required
                                            value="${escapeAttribute(v.contact_number || '')}" ${lockAttr}${fieldBorderErr('contact_number')} />
                                        ${fieldError('contact_number')}
                                    </label>
                                    <label class="field">
                                        <span>Cooperative Email ${OPT}</span>
                                        <input name="email" type="email" placeholder="e.g. contact@apex.coop"
                                            value="${escapeAttribute(v.email || '')}" ${lockAttr}${fieldBorderErr('email')} />
                                        ${fieldError('email')}
                                    </label>
                                </div>
                            </section>

                            <section class="reg-section">
                                <div class="reg-section-head">
                                    <span class="section-ico" style="background: rgba(22,163,74,0.1); color: var(--success);">
                                        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                    </span>
                                    <div>
                                        <h3 class="reg-section-title">Location &amp; Year Start</h3>
                                        <p class="reg-section-sub">Where you're based and when your year begins</p>
                                    </div>
                                </div>
                                <div class="reg-grid">
                                    <label class="field">
                                        <span>Physical Address ${REQ}</span>
                                        <textarea name="address" rows="3" placeholder="Street, city, state…" ${lockAttr}${fieldBorderErr('address')}>${escapeHtml(v.address || '')}</textarea>
                                        ${fieldError('address')}
                                    </label>
                                    <div style="display: flex; flex-direction: column; gap: 1rem;">
                                        <label class="field">
                                            <span>Cooperative Year Start ${REQ}</span>
                                            <input name="first_month" type="date" required
                                                value="${escapeAttribute(v.first_month || '')}" ${lockAttr}${fieldBorderErr('first_month')} />
                                            ${fieldError('first_month')}
                                        </label>
                                    </div>
                                </div>
                            </section>

                            <section class="reg-section">
                                <div class="reg-section-head">
                                    <span class="section-ico" style="background: rgba(217,119,6,0.1); color: var(--warning);">
                                        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                    </span>
                                    <div>
                                        <h3 class="reg-section-title">Admin Account</h3>
                                        <p class="reg-section-sub">Access credentials for the first admin user</p>
                                    </div>
                                </div>
                                <div class="reg-grid">
                                    <label class="field">
                                        <span>Admin Username</span>
                                        <input name="admin_username" type="text" value="admin" disabled />
                                        <span class="validation-message"></span>
                                    </label>
                                    <div class="alert-info" style="margin: 0;">
                                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                        <div>
                                            Your default admin password will be <span class="mono">123456</span>.
                                            You will be prompted to change it after your first login.
                                        </div>
                                    </div>
                                </div>
                            </section>

                            <div id="reg-error" class="alert-error list" style="display:none;"></div>

                            ${!awaitingActivationKey ? `
                            <div class="reg-actions primary">
                                <button type="button" class="secondary-button" id="reg-back-btn" ${isSubmitting ? 'disabled' : ''}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                                    Back
                                </button>
                                <button type="submit" class="primary-button flex-2 ${isSubmitting ? 'btn-loading' : ''}" id="reg-submit-btn" ${isSubmitting ? 'disabled' : ''}>
                                    ${isSubmitting
                                        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 0.9s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Validating…`
                                        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Register Cooperative`
                                    }
                                </button>
                            </div>
                            ` : ''}
                        </form>
                    </div>
                </div>
            </div>

            ${awaitingActivationKey ? `
            <div class="key-modal-overlay" id="reg-key-modal">
                <div class="key-modal" role="dialog" aria-modal="true" aria-labelledby="reg-key-title">
                    <div class="lock-ico">🔐</div>
                    <h2 id="reg-key-title">Activation Key Required</h2>
                    <p class="key-hint">Enter today's activation key to finalize your cooperative creation.</p>
                    <div class="key-example" title="Example format YYDDMM">Format: YYDDMM</div>
                    ${activationKeyError ? `<div class="alert-error list">${escapeHtml(activationKeyError)}</div>` : ''}
                    <input type="text" id="reg-activation-key" class="key-entry" placeholder="XXXXXX"
                        autocomplete="off" spellcheck="false" maxlength="6" inputmode="numeric" ${isSubmitting ? 'disabled' : ''} />
                    <div class="reg-actions">
                        <button type="button" class="secondary-button" id="reg-key-cancel-btn" ${isSubmitting ? 'disabled' : ''}>Cancel</button>
                        <button type="button" class="primary-button flex-2 ${isSubmitting ? 'btn-loading' : ''}" id="reg-key-verify-btn" ${isSubmitting ? 'disabled' : ''}>
                            ${isSubmitting
                                ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 0.9s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Creating…`
                                : `Verify &amp; Create`
                            }
                        </button>
                    </div>
                </div>
            </div>
            ` : ''}
            `}
        </div>
        </div>
        <style>@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }</style>
    `
}

function expectedActivationKey() {
    const today = new Date()
    const yy = String(today.getFullYear()).slice(-2)
    const dd = String(today.getDate()).padStart(2, '0')
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    return `${yy}${dd}${mm}`
}

function normalizePhone(raw) {
    if (!raw) return ''
    const s = String(raw).replace(/[-\s()]/g, '')
    return s
}

async function checkCoopNameUniqueness(fullName, shortName) {
    const { getDb, collection, getDocs, query, where } = await import('../firebase.js')
    const db = getDb()
    
    // Check full_name uniqueness (case-insensitive)
    const fullNameSnap = await getDocs(
        query(collection(db, 'cooperatives'), where('full_name', '==', fullName.trim()), where('is_deleted', '!=', 1))
    )
    if (!fullNameSnap.empty) {
        return { isUnique: false, field: 'full_name', message: 'A cooperative with this full name already exists.' }
    }
    
    // Check short_name uniqueness (case-insensitive, store as uppercase)
    const shortNameUpper = shortName.trim().toUpperCase()
    const shortNameSnap = await getDocs(
        query(collection(db, 'cooperatives'), where('short_name', '==', shortNameUpper), where('is_deleted', '!=', 1))
    )
    if (!shortNameSnap.empty) {
        return { isUnique: false, field: 'short_name', message: 'A cooperative with this short name/acronym already exists.' }
    }
    
    return { isUnique: true }
}

function validateForm(values) {
    const errors = {}
    if (!values.full_name || values.full_name.trim().length < 2) {
        errors.full_name = 'Full name is required (min. 2 characters).'
    }
    if (!values.short_name || values.short_name.trim().length < 2) {
        errors.short_name = 'Short name / acronym is required (min. 2 characters).'
    }
    const phone = normalizePhone(values.contact_number)
    if (!phone || !/^[+\d]/.test(phone) || phone.replace(/\D/g, '').length < 8) {
        errors.contact_number = 'Enter a valid phone number (min. 8 digits).'
    }
    if (values.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
            errors.email = 'Enter a valid email or leave blank.'
        }
    }
    if (!values.address || values.address.trim().length < 5) {
        errors.address = 'Address is required (min. 5 characters).'
    }
    if (!values.first_month || isNaN(new Date(values.first_month).getTime())) {
        errors.first_month = 'Pick a valid year-start date.'
    }
    return errors
}

export async function renderRegistration(container, onBack, onSuccess) {
    const DRAFT_KEY = 'cooplog-reg-draft'

    const state = {
        selectedLogo: null,
        awaitingActivationKey: false,
        activationKeyError: '',
        pendingCoopData: null,
        errors: {},
        isSubmitting: false,
        topError: '',
        registrationSuccess: false,
        successPassword: '',
        registrationResult: null
    }

    function clearDraft() { sessionStorage.removeItem(DRAFT_KEY) }

    function render() {
        container.innerHTML = buildRegistrationHtml({
            awaitingActivationKey: state.awaitingActivationKey,
            activationKeyError: state.activationKeyError,
            formValues: state.pendingCoopData,
            errors: state.errors,
            isSubmitting: state.isSubmitting,
            topError: state.topError,
            registrationSuccess: state.registrationSuccess,
            successPassword: state.successPassword,
            selectedLogo: state.selectedLogo
        })
        bindEvents()
    }

    function bindEvents() {
        const form = container.querySelector('#registration-form')
        const errorDiv = container.querySelector('#reg-error')

        container.querySelectorAll('#registration-wrap input[type="date"]').forEach(wrapDateInput)
        const backBtn = container.querySelector('#reg-back-btn')
        const submitBtn = container.querySelector('#reg-submit-btn')
        const logoInput = container.querySelector('#logo-input')
        const logoPreview = container.querySelector('#logo-preview')

        function saveDraft() {
            if (!form || state.awaitingActivationKey) return
            const fd = new FormData(form)
            const draft = Object.fromEntries(fd.entries())
            if (state.selectedLogo) draft.logo_path = state.selectedLogo
            delete draft.admin_username
            sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
        }
        function loadDraft() {
            if (!form) return
            try {
                const raw = sessionStorage.getItem(DRAFT_KEY)
                if (!raw) return
                const draft = JSON.parse(raw)
                Object.keys(draft).forEach(key => {
                    if (key === 'logo_path') {
                        state.selectedLogo = draft.logo_path
                        if (logoPreview) logoPreview.innerHTML = `<img src="${draft.logo_path}" alt="Logo preview" />`
                        return
                    }
                    if (form[key]) form[key].value = draft[key]
                })
            } catch(e) { /* ignore */ }
        }
        if (!state.awaitingActivationKey && form) {
            const today = new Date()
            const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]
            if (form.first_month && !form.first_month.value) form.first_month.value = firstDay
            loadDraft()
        }

        if (backBtn) backBtn.addEventListener('click', onBack)

        const clearBtn = container.querySelector('#clear-reg-form-btn')
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to clear all inputs?')) {
                    clearDraft()
                    state.selectedLogo = null
                    state.pendingCoopData = null
                    state.errors = {}
                    state.topError = ''
                    state.awaitingActivationKey = false
                    state.activationKeyError = ''
                    renderRegistration(container, onBack, onSuccess)
                }
            })
        }

        if (logoInput) {
            const logoTrigger = container.querySelector('#logo-trigger')
            if (logoTrigger) {
                const uploadDisabled = state.awaitingActivationKey || state.isSubmitting
                if (!uploadDisabled) {
                    logoTrigger.addEventListener('click', (e) => {
                        e.preventDefault()
                        logoInput.click()
                    })
                    logoTrigger.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); logoInput.click() }
                    })
                } else {
                    logoTrigger.style.cursor = 'not-allowed'
                    logoTrigger.style.opacity = '0.6'
                }
                logoTrigger.setAttribute('role', 'button')
                logoTrigger.setAttribute('tabindex', uploadDisabled ? '-1' : '0')
            }
            logoInput.addEventListener('change', async (e) => {
                const file = e.target.files[0]
                if (file) {
                    try {
                        state.selectedLogo = await compressImage(file)
                        if (logoPreview) logoPreview.innerHTML = `<img src="${state.selectedLogo}" alt="Logo preview" />`
                        saveDraft()
                    } catch (err) {
                        console.error('Logo compression failed:', err)
                    }
                }
            })

            // Handle remove logo button
            const logoRemoveBtn = container.querySelector('.logo-remove-btn')
            if (logoRemoveBtn) {
                logoRemoveBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    state.selectedLogo = null
                    if (logoPreview) logoPreview.innerHTML = `<span class="logo-ph-ico">🏢</span>`
                    // Reset the file input value
                    const logoInput = container.querySelector('#logo-input')
                    if (logoInput) logoInput.value = ''
                    saveDraft()
                })
            }
        }

        if (form) {
            form.addEventListener('input', saveDraft)

            form.addEventListener('submit', async (e) => {
                e.preventDefault()
                if (state.isSubmitting) return
                const formData = new FormData(form)
                const submitted = {
                    full_name: formData.get('full_name') ? String(formData.get('full_name')).trim() : '',
                    short_name: formData.get('short_name') ? String(formData.get('short_name')).trim() : '',
                    contact_number: formData.get('contact_number') ? String(formData.get('contact_number')).trim() : '',
                    email: formData.get('email') ? String(formData.get('email')).trim() : '',
                    address: formData.get('address') ? String(formData.get('address')).trim() : '',
                    first_month: formData.get('first_month') || '',
                    logo_path: state.selectedLogo || null
                }

                const errors = validateForm(submitted)
                state.errors = errors
                state.topError = Object.keys(errors).length
                    ? 'Please fix the errors below before continuing.'
                    : ''

                if (Object.keys(errors).length > 0) {
                    render()
                    const fieldLabels = {
                        full_name: 'Full name',
                        short_name: 'Short name / Acronym',
                        contact_number: 'Contact number',
                        email: 'Email',
                        address: 'Address',
                        first_month: 'Year-start date'
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

                // Check uniqueness of full_name and short_name
                const uniqueCheck = await checkCoopNameUniqueness(submitted.full_name, submitted.short_name)
                if (!uniqueCheck.isUnique) {
                    state.errors = { [uniqueCheck.field]: uniqueCheck.message }
                    state.topError = uniqueCheck.message
                    render()
                    const labelMap = { full_name: 'Full name', short_name: 'Short name' }
                    const fld = labelMap[uniqueCheck.field] || uniqueCheck.field
                    showToast(`Submit failed: ${fld} — ${uniqueCheck.message}`, 'warning')
                    return
                }

                state.isSubmitting = true
                state.pendingCoopData = submitted
                render()
                await new Promise(r => setTimeout(r, 60))
                state.isSubmitting = false
                state.awaitingActivationKey = true
                state.activationKeyError = ''
                render()
                container.querySelector('#reg-activation-key')?.focus()
            })
        }

        const keyModal = container.querySelector('#reg-key-modal')
        if (keyModal) {
            keyModal.addEventListener('click', (e) => {
                if (e.target === keyModal && !state.isSubmitting) {
                    state.awaitingActivationKey = false
                    state.activationKeyError = ''
                    render()
                }
            })
            const closeKeyModal = () => {
                if (state.isSubmitting) return
                state.awaitingActivationKey = false
                state.activationKeyError = ''
                render()
            }
            const keyEntry = keyModal.querySelector('.key-entry')
            keyEntry?.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeKeyModal()
                else if (e.key === 'Enter') { e.preventDefault(); verifyKeyBtn?.click() }
            })
        }

        const cancelKeyBtn = container.querySelector('#reg-key-cancel-btn')
        if (cancelKeyBtn) {
            cancelKeyBtn.addEventListener('click', () => {
                if (state.isSubmitting) return
                state.awaitingActivationKey = false
                state.activationKeyError = ''
                render()
            })
        }

        const verifyKeyBtn = container.querySelector('#reg-key-verify-btn')
        if (verifyKeyBtn) {
            verifyKeyBtn.addEventListener('click', async () => {
                if (state.isSubmitting) return
                const keyInput = container.querySelector('#reg-activation-key')
                const key = keyInput ? keyInput.value.trim() : ''
                if (key.length < 6) {
                    state.activationKeyError = 'Please enter a 6-digit activation key.'
                    render()
                    showToast('Submit failed: please enter the 6-digit activation key.', 'warning')
                    keyInput?.focus()
                    return
                }
                if (key !== expectedActivationKey()) {
                    state.activationKeyError = 'Invalid activation key. Please try again.'
                    render()
                    showToast('Submit failed: invalid activation key. Format: YYDDMM (year day month).', 'error')
                    keyInput?.focus()
                    keyInput?.select()
                    return
                }

                state.isSubmitting = true
                state.activationKeyError = ''
                render()
                try {
                    await finishRegistration(state.pendingCoopData)
                } catch (err) {
                    state.isSubmitting = false
                    if (errorDiv) {
                        errorDiv.style.display = 'block'
                        errorDiv.textContent = 'Registration failed: ' + (err.message || 'Unknown error. Please try again.')
                    }
                    showToast(`Registration failed: ${err.message || 'Please check your connection and try again.'}`, 'error')
                    render()
                }
            })
        }

        // OK button to dismiss success message & redirect to login
        const okBtn = container.querySelector('.success-wrap .secondary-button')
        if (okBtn) {
            okBtn.addEventListener('click', () => {
                const result = state.registrationResult || {}
                state.registrationSuccess = false
                state.successPassword = ''
                state.registrationResult = null
                if (typeof onSuccess === 'function') {
                    onSuccess(result)
                } else {
                    render()
                }
            })
        }
    }

    async function finishRegistration(coopData) {
        const errorDiv = container.querySelector('#reg-error')
        try {
            if (errorDiv) { errorDiv.style.display = 'none'; errorDiv.textContent = '' }

            const result = await registerCooperative(coopData)

            clearDraft()
            state.isSubmitting = false
            state.registrationSuccess = true
            state.successPassword = result.generatedPassword || '123456'
            state.registrationResult = result
            render()
        } catch (err) {
            console.error('Registration Error:', err)
            state.isSubmitting = false
            state.activationKeyError = err.message || 'Creation failed. Please try again.'
            if (errorDiv) {
                errorDiv.style.display = 'block'
                errorDiv.textContent = 'Registration failed: ' + (err.message || 'Unknown error.')
            }
            render()
            showToast(`Registration failed: ${err.message || 'Please check your connection and try again.'}`, 'error')
            throw err
        }
    }

    render()
}
