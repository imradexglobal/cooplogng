/**
 * Landing.js — public marketing page for cooplogNg (Cooperative Log App).
 *
 * Static, offline-safe (bundled logo + inline SVG, no external assets), theme-aware
 * via the app's CSS variables. All demo figures are fictional and labelled.
 */

import logoUrl from '../icon/Logo.png';

/**
 * Download sources for first-time installs.
 * Primary source is the `releases/latest` Firestore document:
 *   { apkUrl, apkVersion, apkSize, exeUrl, exeVersion, exeSize, notes }
 * so publishing = edit that one doc, no redeploy. The constants below are
 * only the offline/fallback display until the doc loads (or if absent).
 */
const RELEASE_DOC_PATH = 'releases/latest';
const RELEASE_FALLBACK = {
  apkVersion: 'v1.0.0',
  apkSize: '',
  apkUrl: '',
  exeVersion: 'v1.0.0',
  exeSize: '',
  exeUrl: '',
  notes: '',
};

const DEMO_STATS = [
  { value: 1173, suffix: '+', label: 'Members managed' },
  { value: 59, suffix: '', label: 'Transactions this month' },
  { value: 100, suffix: '%', label: 'Works offline' },
  { value: 10, suffix: ' min', label: 'Inactivity auto-logout' },
];

const FEATURES = [
  {
    title: 'Offline-first, syncs later',
    text: 'No network? No problem. Record savings, loans and remittances offline — everything syncs to the cloud the moment you reconnect.',
    icon: '<path d="M13 10V3L4 14h7v7l9-11h-7z"/>',
  },
  {
    title: '6-digit PIN security',
    text: 'Members sign in with a simple numeric PIN. Weak or temporary passwords trigger an automatic forced change on next login.',
    icon: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  },
  {
    title: 'Remittance tracking & approvals',
    text: 'Log contributions in seconds, route withdrawals through approvals, and keep a clean trail from entry to bank.',
    icon: '<path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  },
  {
    title: 'Loans, guarantors & penalties',
    text: 'Configure enterprises with multipliers, interest and admin charges. Track guarantors, overdue loans and penalty accounts.',
    icon: '<path d="M9 14l6-6M9 8l6 6M12 3v18"/>',
  },
  {
    title: 'Live dashboard & reports',
    text: 'Watch savings, loans, cash and revenue update in real time. Export member lists and remittance history to Excel anytime.',
    icon: '<path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 00-2-2h-2a2 2 0 00-2 2v14"/>',
  },
  {
    title: 'Many cooperatives, one app',
    text: 'Run several cooperatives from a single install with per-user roles, permissions and enterprise-level access control.',
    icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 11-8 0 4 4 0 018 0zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  },
];

const STEPS = [
  { n: '1', title: 'Register your cooperative', text: 'Create your cooperative in under a minute and get an admin account instantly.' },
  { n: '2', title: 'Add members & enterprises', text: 'Import members in bulk or one by one, then set up savings, loans and Distributive enterprises.' },
  { n: '3', title: 'Record & report', text: 'Log daily remittances, approve withdrawals, and watch the dashboard and reports stay current.' },
];

const FAQS = [
  {
    q: 'Does cooplogNg work without internet?',
    a: 'Yes. It is offline-first: every screen works without a connection, and all changes sync automatically when you are back online.',
  },
  {
    q: 'How do members sign in?',
    a: 'With their username, mobile number, registration number or special ID plus a 6-digit numeric PIN. Complex legacy passwords from older setups keep working too.',
  },
  {
    q: 'Is my cooperative\u2019s data safe?',
    a: 'Sessions expire after 10 minutes of inactivity, weak passwords force an immediate change, and every write carries a full audit trail of who changed what and when.',
  },
  {
    q: 'Can one phone handle multiple cooperatives?',
    a: 'Yes. A single install can serve many cooperatives, and one person can belong to several — just pick the cooperative at sign-in.',
  },
  {
    q: 'How do we get started?',
    a: 'Tap "Register" below, fill in your cooperative details, and sign in with the admin account created for you.',
  },
];

function icon(svg, size = 22) {
  return `<svg width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${svg}</svg>`;
}

export function renderLanding(container, callbacks = {}) {
  const onLogin = callbacks.onLogin || (() => {});
  const onRegister = callbacks.onRegister || (() => {});

  container.innerHTML = `
  <div class="landing">
    <style>
      .landing { --lp-accent: var(--accent-primary, #3b82f6); --lp-card: var(--bg-card, var(--bg-secondary, #f1f5f9)); color: var(--text-primary); overflow-x: hidden; height: 100dvh; overflow-y: auto; overscroll-behavior-y: contain; }
      .landing a { color: inherit; }
      .lp-nav { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(12px); background: color-mix(in srgb, var(--bg-primary) 82%, transparent); border-bottom: 1px solid var(--border-light); }
      .lp-nav-inner { max-width: 1120px; margin: 0 auto; padding: 0.8rem 1.25rem; display: flex; align-items: center; gap: 1rem; }
      .lp-brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 800; font-size: 1.1rem; letter-spacing: 0.02em; }
      .lp-mark { width: 2.2rem; height: 2.2rem; border-radius: 0.7rem; background: linear-gradient(135deg, var(--lp-accent), #8b5cf6); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 900; }
      .lp-mark-img { width: 2.2rem; height: 2.2rem; border-radius: 0.7rem; object-fit: cover; display: block; }
      .lp-links { display: flex; gap: 1.25rem; margin-left: auto; font-size: 0.9rem; color: var(--text-muted); }
      .lp-links a { text-decoration: none; }
      .lp-links a:hover { color: var(--lp-accent); }
      .lp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 999px; padding: 0.7rem 1.6rem; font-weight: 700; font-size: 0.95rem; cursor: pointer; border: 1px solid transparent; transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease; text-decoration: none; }
      .lp-btn-primary { background: var(--lp-accent); color: #fff; box-shadow: 0 8px 24px -8px var(--lp-accent); }
      .lp-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 14px 30px -8px var(--lp-accent); }
      .lp-btn-ghost { background: transparent; border-color: var(--border-medium); color: var(--text-primary); }
      .lp-btn-ghost:hover { border-color: var(--lp-accent); color: var(--lp-accent); }
      .lp-btn-sm { padding: 0.5rem 1.1rem; font-size: 0.85rem; }
      .lp-hero { max-width: 1120px; margin: 0 auto; padding: 4rem 1.25rem 2rem; display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 3rem; align-items: center; }
      .lp-badge { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--lp-accent); background: color-mix(in srgb, var(--lp-accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--lp-accent) 35%, transparent); padding: 0.4rem 0.9rem; border-radius: 999px; }
      .lp-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #22c55e; animation: lp-pulse 1.6s infinite; }
      @keyframes lp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .lp-hero h1 { font-size: clamp(2.2rem, 5vw, 3.6rem); line-height: 1.08; margin: 1.25rem 0 1rem; font-weight: 900; letter-spacing: -0.02em; }
      .lp-hero h1 .grad { background: linear-gradient(92deg, var(--lp-accent), #8b5cf6 60%, #ec4899); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .lp-sub { font-size: 1.08rem; color: var(--text-muted); line-height: 1.7; max-width: 34rem; }
      .lp-cta { display: flex; gap: 0.9rem; margin-top: 2rem; flex-wrap: wrap; }
      .lp-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-top: 2.5rem; }
      .lp-stat { background: var(--lp-card); border: 1px solid var(--border-light); border-radius: 1rem; padding: 0.9rem 1rem; }
      .lp-stat b { font-size: 1.35rem; display: block; }
      .lp-stat span { font-size: 0.78rem; color: var(--text-muted); }
      .lp-phone { background: linear-gradient(160deg, color-mix(in srgb, var(--lp-accent) 16%, var(--bg-secondary)), var(--bg-secondary)); border: 1px solid var(--border-light); border-radius: 2rem; padding: 1.4rem; max-width: 340px; margin-left: auto; box-shadow: 0 30px 60px -30px rgba(0,0,0,0.45); animation: lp-float 6s ease-in-out infinite; }
      @keyframes lp-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
      .lp-phone-card { background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: 1.25rem; padding: 1.4rem 1.2rem; text-align: center; }
      .lp-phone-card .brand { font-size: 0.65rem; letter-spacing: 0.18em; color: var(--lp-accent); font-weight: 800; }
      .lp-phone-card h3 { margin: 0.4rem 0 1rem; font-size: 1.3rem; }
      .lp-fake-input { border: 1.5px solid var(--lp-accent); border-radius: 0.7rem; padding: 0.65rem 0.8rem; font-size: 0.8rem; color: var(--text-muted); text-align: left; margin-bottom: 0.9rem; }
      .lp-fake-btn { border-radius: 0.7rem; padding: 0.7rem; font-size: 0.85rem; font-weight: 700; margin-bottom: 0.6rem; }
      .lp-fake-primary { background: var(--lp-accent); color: #fff; }
      .lp-fake-white { background: #fff; color: #1f2937; }
      .lp-section { max-width: 1120px; margin: 0 auto; padding: 4rem 1.25rem 0.5rem; }
      .lp-kicker { font-size: 0.78rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lp-accent); }
      .lp-h2 { font-size: clamp(1.6rem, 3.4vw, 2.4rem); font-weight: 900; margin: 0.6rem 0 0.6rem; letter-spacing: -0.01em; }
      .lp-lead { color: var(--text-muted); max-width: 44rem; line-height: 1.7; }
      .lp-demo-tag { display: inline-block; font-size: 0.72rem; font-weight: 700; background: #fef3c7; color: #92400e; border-radius: 999px; padding: 0.25rem 0.75rem; margin-bottom: 1rem; }
      .lp-dash { border: 1px solid var(--border-light); border-radius: 1.5rem; overflow: hidden; background: var(--bg-secondary); box-shadow: 0 30px 60px -35px rgba(0,0,0,0.5); margin-top: 1.5rem; }
      .lp-dash-top { display: flex; align-items: center; gap: 0.5rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border-light); }
      .lp-tdot { width: 0.7rem; height: 0.7rem; border-radius: 50%; background: var(--border-medium); }
      .lp-dash-body { display: grid; grid-template-columns: 150px 1fr; min-height: 300px; }
      .lp-dash-side { border-right: 1px solid var(--border-light); padding: 1rem 0.7rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.75rem; }
      .lp-dash-side .on { background: var(--lp-accent); color: #fff; border-radius: 0.6rem; padding: 0.45rem 0.6rem; font-weight: 700; }
      .lp-dash-side span:not(.on) { padding: 0.45rem 0.6rem; color: var(--text-muted); }
      .lp-dash-main { padding: 1.1rem; }
      .lp-dash-main h4 { margin: 0 0 0.9rem; font-size: 1.05rem; }
      .lp-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.7rem; }
      .lp-card { border-radius: 0.9rem; padding: 0.8rem; color: #fff; min-height: 86px; }
      .lp-card small { font-size: 0.6rem; opacity: 0.9; display: block; line-height: 1.35; }
      .lp-card b { font-size: 1.02rem; display: block; margin-top: 0.25rem; }
      .lp-c1 { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
      .lp-c2 { background: linear-gradient(135deg, #f87171, #dc2626); }
      .lp-c3 { background: linear-gradient(135deg, #60a5fa, #2563eb); }
      .lp-c4 { background: linear-gradient(135deg, #34d399, #059669); }
      .lp-cards2 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.7rem; margin-top: 0.7rem; }
      .lp-ent { background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: 0.9rem; padding: 0.8rem; }
      .lp-ent small { font-size: 0.68rem; color: var(--text-muted); display: block; }
      .lp-ent b { font-size: 0.95rem; }
      .lp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.1rem; margin-top: 2rem; }
      .lp-feat { background: var(--lp-card); border: 1px solid var(--border-light); border-radius: 1.25rem; padding: 1.6rem 1.4rem; transition: transform 0.18s ease, box-shadow 0.25s ease; }
      .lp-feat:hover { transform: translateY(-5px); box-shadow: 0 20px 40px -22px rgba(0,0,0,0.5); }
      .lp-feat .ic { width: 2.8rem; height: 2.8rem; border-radius: 0.9rem; background: color-mix(in srgb, var(--lp-accent) 14%, transparent); color: var(--lp-accent); display: flex; align-items: center; justify-content: center; margin-bottom: 1rem; }
      .lp-feat h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
      .lp-feat p { margin: 0; color: var(--text-muted); font-size: 0.92rem; line-height: 1.65; }
      .lp-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.1rem; margin-top: 2rem; counter-reset: step; }
      .lp-step { position: relative; background: var(--lp-card); border: 1px solid var(--border-light); border-radius: 1.25rem; padding: 1.6rem 1.4rem; }
      .lp-step .n { width: 2.4rem; height: 2.4rem; border-radius: 50%; background: var(--lp-accent); color: #fff; font-weight: 900; display: flex; align-items: center; justify-content: center; margin-bottom: 1rem; }
      .lp-step h3 { margin: 0 0 0.5rem; }
      .lp-step p { margin: 0; color: var(--text-muted); font-size: 0.92rem; line-height: 1.65; }
      .lp-author { display: grid; grid-template-columns: 150px 1fr; gap: 1.8rem; align-items: center; background: var(--lp-card); border: 1px solid var(--border-light); border-radius: 1.5rem; padding: 2rem; margin-top: 2rem; }
      .lp-avatar { width: 150px; height: 150px; border-radius: 50%; background: linear-gradient(135deg, var(--lp-accent), #8b5cf6); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 3rem; font-weight: 900; }
      .lp-author h3 { margin: 0; font-size: 1.4rem; }
      .lp-role { color: var(--lp-accent); font-weight: 700; font-size: 0.9rem; margin: 0.25rem 0 0.9rem; }
      .lp-author p { color: var(--text-muted); line-height: 1.75; margin: 0 0 0.8rem; }
      .lp-faq { margin-top: 2rem; display: flex; flex-direction: column; gap: 0.7rem; }
      .lp-faq details { background: var(--lp-card); border: 1px solid var(--border-light); border-radius: 1rem; padding: 1rem 1.25rem; }
      .lp-faq summary { font-weight: 700; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
      .lp-faq summary::-webkit-details-marker { display: none; }
      .lp-faq summary::after { content: '+'; color: var(--lp-accent); font-size: 1.4rem; font-weight: 400; }
      .lp-faq details[open] summary::after { content: '–'; }
      .lp-faq details p { color: var(--text-muted); line-height: 1.7; margin: 0.8rem 0 0.2rem; }
      .lp-final { text-align: center; padding: 4.5rem 1.25rem 5rem; }
      .lp-dl-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.1rem; margin-top: 2rem; }
      .lp-dl-card { background: var(--lp-card); border: 1px solid var(--border-light); border-radius: 1.5rem; padding: 2rem 1.6rem; text-align: center; }
      .lp-dl-ic { width: 3.4rem; height: 3.4rem; border-radius: 1rem; background: color-mix(in srgb, var(--lp-accent) 14%, transparent); color: var(--lp-accent); display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; }
      .lp-dl-card h3 { margin: 0; font-size: 1.25rem; }
      .lp-dl-ver { font-weight: 800; color: var(--lp-accent); margin-top: 0.3rem; }
      .lp-dl-meta { font-size: 0.8rem; color: var(--text-muted); min-height: 1.2em; margin-top: 0.2rem; }
      .lp-dl-card a[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
      .lp-dl-steps { text-align: left; font-size: 0.85rem; color: var(--text-muted); line-height: 1.7; margin: 1.2rem 0 0; padding-left: 1.2rem; }
      .lp-dl-note { text-align: center; color: var(--text-muted); font-size: 0.9rem; margin-top: 1.4rem; }
      .lp-dl-note:empty { display: none; }      .lp-final h2 { font-size: clamp(1.8rem, 4vw, 2.8rem); font-weight: 900; margin: 0 0 0.8rem; }
      .lp-final p { color: var(--text-muted); margin: 0 0 2rem; }
      .lp-footer { border-top: 1px solid var(--border-light); padding: 1.6rem 1.25rem 2.2rem; text-align: center; color: var(--text-muted); font-size: 0.85rem; }
      .reveal { opacity: 0; transform: translateY(26px); transition: opacity 0.7s ease, transform 0.7s ease; }
      .reveal.in { opacity: 1; transform: none; }
      @media (max-width: 900px) {
        .lp-hero { grid-template-columns: 1fr; padding-top: 2.5rem; }
        .lp-phone { margin: 0 auto; }
        .lp-grid, .lp-steps { grid-template-columns: 1fr; }
        .lp-links { display: none; }
        .lp-stats { grid-template-columns: repeat(2, 1fr); }
        .lp-dash-body { grid-template-columns: 1fr; }
        .lp-dash-side { flex-direction: row; border-right: none; border-bottom: 1px solid var(--border-light); overflow-x: auto; }
        .lp-cards, .lp-cards2 { grid-template-columns: repeat(2, 1fr); }
        .lp-dl-grid { grid-template-columns: 1fr; }
        .lp-author { grid-template-columns: 1fr; text-align: center; justify-items: center; }
      }
      @media (prefers-reduced-motion: reduce) {
        .reveal { opacity: 1; transform: none; transition: none; }
        .lp-phone, .lp-dot { animation: none; }
      }
    </style>

    <nav class="lp-nav">
      <div class="lp-nav-inner">
        <div class="lp-brand"><img class="lp-mark-img" src="${logoUrl}" alt="cooplogNg logo"> cooplogNg</div>
        <div class="lp-links">
          <a href="#lp-features">Features</a>
          <a href="#lp-download">Download</a>
          <a href="#lp-preview">Preview</a>
          <a href="#lp-how">How it works</a>
          <a href="#lp-author">Author</a>
          <a href="#lp-faq">FAQ</a>
        </div>
        <button class="lp-btn lp-btn-ghost lp-btn-sm" data-lp="login" style="margin-left:auto;">Sign in</button>
      </div>
    </nav>

    <header class="lp-hero">
      <div>
        <span class="lp-badge"><span class="lp-dot"></span> Offline-first cooperative banking</span>
        <h1>Cooperative finance, <span class="grad">beautifully under control.</span></h1>
        <p class="lp-sub">cooplogNg (Cooperative Log App) puts your cooperative's savings, loans, remittances and reports in one fast app that works with or without internet — built for the way real cooperatives operate every day.</p>
        <div class="lp-cta">
          <button class="lp-btn lp-btn-primary" data-lp="login">Sign in →</button>
          <button class="lp-btn lp-btn-ghost" data-lp="register">Register</button>
        </div>
        <div class="lp-stats">
          ${DEMO_STATS.map(s => `<div class="lp-stat reveal"><b><span data-count="${s.value}">0</span>${s.suffix}</b><span>${s.label}</span></div>`).join('')}
        </div>
      </div>
      <div class="lp-phone" aria-hidden="true">
        <div class="lp-phone-card">
          <div class="brand">COOPERATIVE LOG APP</div>
          <h3>Welcome Back</h3>
          <div class="lp-fake-input">Username, Mobile, or Special ID</div>
          <div class="lp-fake-btn lp-fake-primary">Next</div>
          <div class="lp-fake-btn lp-fake-white">Sign In with Google</div>
          <div style="font-size:0.72rem;color:var(--lp-accent);font-weight:700;margin-top:0.6rem;">Register</div>
        </div>
      </div>
    </header>

    <section class="lp-section" id="lp-preview">
      <span class="lp-demo-tag">Sample preview — demo data, not real figures</span>
      <div class="lp-kicker">Live preview</div>
      <h2 class="lp-h2">One dashboard for the whole cooperative</h2>
      <p class="lp-lead">Savings, loans, cash, revenue, members and enterprise balances update the moment records are approved — online or offline.</p>
      <div class="lp-dash reveal" aria-hidden="true">
        <div class="lp-dash-top"><span class="lp-tdot"></span><span class="lp-tdot"></span><span class="lp-tdot"></span><span style="margin-left:0.6rem;font-size:0.75rem;color:var(--text-muted);">DEMO Cooperative — Dashboard</span></div>
        <div class="lp-dash-body">
          <div class="lp-dash-side"><span class="on">Dashboard</span><span>Members</span><span>Remittance</span><span>Account Summary</span><span>Reports</span><span>Settings</span></div>
          <div class="lp-dash-main">
            <h4>Dashboard <span style="font-weight:400;font-size:0.75rem;color:var(--text-muted);">Welcome back, Demo Admin!</span></h4>
            <div class="lp-cards">
              <div class="lp-card lp-c1"><small>TOTAL MEMBER SAVINGS (LIABILITY)</small><b>₦12,450,000.00</b></div>
              <div class="lp-card lp-c2"><small>TOTAL OUTSTANDING LOANS (ASSETS)</small><b>₦3,180,500.00</b></div>
              <div class="lp-card lp-c3"><small>CASH + BANK BALANCE</small><b>₦9,872,340.00</b></div>
              <div class="lp-card lp-c4"><small>TOTAL REVENUE COLLECTED</small><b>₦214,600.00</b></div>
            </div>
            <div class="lp-cards2">
              <div class="lp-ent"><small>Festival Savings</small><b>₦4,120,000.00</b></div>
              <div class="lp-ent"><small>Ordinary Loan</small><b style="color:#ef4444;">-₦3,180,500.00</b></div>
              <div class="lp-ent"><small>Ordinary Savings</small><b>₦7,560,000.00</b></div>
              <div class="lp-ent"><small>Target Savings</small><b>₦770,000.00</b></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="lp-section" id="lp-features">
      <div class="lp-kicker">Features</div>
      <h2 class="lp-h2">Everything a cooperative needs, nothing it doesn't</h2>
      <p class="lp-lead">Designed with cooperative officers and members — powerful enough for the office, simple enough for every phone.</p>
      <div class="lp-grid">
        ${FEATURES.map(f => `
          <div class="lp-feat reveal">
            <div class="ic">${icon(f.icon)}</div>
            <h3>${f.title}</h3>
            <p>${f.text}</p>
          </div>`).join('')}
      </div>
    </section>

    <section class="lp-section" id="lp-download">
      <div class="lp-kicker">Download</div>
      <h2 class="lp-h2">Get CoopLog for first-time install</h2>
      <p class="lp-lead">New here? Grab the app below. Already installed? Updates arrive automatically via the Play Store (Android) and your update site (Windows) — no need to re-download.</p>
      <div class="lp-dl-grid">
        <div class="lp-dl-card reveal">
          <div class="lp-dl-ic">${icon('<path d="M12 18v-6m0 0l-3 3m3-3l3 3M4 20h16"/>', 26)}</div>
          <h3>Android (APK)</h3>
          <div class="lp-dl-ver" data-rel="apkVersion">${RELEASE_FALLBACK.apkVersion}</div>
          <div class="lp-dl-meta" data-rel="apkSize"></div>
          <a class="lp-btn lp-btn-primary" data-rel-btn="apk" href="#" download style="width:100%;margin-top:1rem;">Download APK</a>
          <ol class="lp-dl-steps">
            <li>Tap Download, then open the file.</li>
            <li>Allow <b>“Install unknown apps”</b> for Chrome when asked.</li>
            <li>A Play Protect warning is normal for first installs — future updates come from the Play Store.</li>
          </ol>
        </div>
        <div class="lp-dl-card reveal">
          <div class="lp-dl-ic">${icon('<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>', 26)}</div>
          <h3>Windows (EXE)</h3>
          <div class="lp-dl-ver" data-rel="exeVersion">${RELEASE_FALLBACK.exeVersion}</div>
          <div class="lp-dl-meta" data-rel="exeSize"></div>
          <a class="lp-btn lp-btn-primary" data-rel-btn="exe" href="#" download style="width:100%;margin-top:1rem;">Download EXE</a>
          <ol class="lp-dl-steps">
            <li>Download and run the installer.</li>
            <li>If SmartScreen warns about an unknown publisher, choose <b>More info → Run anyway</b>.</li>
            <li>Later updates arrive from your update site — no reinstall needed.</li>
          </ol>
        </div>
      </div>
      <p class="lp-dl-note" data-rel="notes"></p>
    </section>

    <section class="lp-section" id="lp-how">
      <div class="lp-kicker">Getting started</div>
      <h2 class="lp-h2">Live in three steps</h2>
      <div class="lp-steps">
        ${STEPS.map(s => `
          <div class="lp-step reveal">
            <div class="n">${s.n}</div>
            <h3>${s.title}</h3>
            <p>${s.text}</p>
          </div>`).join('')}
      </div>
    </section>

    <section class="lp-section" id="lp-author">
      <div class="lp-kicker">About the author</div>
      <h2 class="lp-h2">Built by someone who loves data</h2>
      <div class="lp-author reveal">
        <div class="lp-avatar">AA</div>
        <div>
          <h3>Adebowale Abdul-wasiu</h3>
          <div class="lp-role">Software Developer &amp; Data Analyst</div>
          <p>Adebowale is a software developer and data analyst who believes good software should work for people, not the other way round. He started cooplogNg after watching cooperative officers struggle with paper ledgers and scattered spreadsheets — records that were hard to reconcile and impossible to trust at a glance.</p>
          <p>So he built the tool he wished existed: an offline-first app that treats every naira with the care of an analyst and the simplicity of a passbook. Every dashboard figure, every report and every audit trail in cooplogNg reflects that obsession with accuracy.</p>
        </div>
      </div>
    </section>

    <section class="lp-section" id="lp-faq">
      <div class="lp-kicker">FAQ</div>
      <h2 class="lp-h2">Questions, answered</h2>
      <div class="lp-faq">
        ${FAQS.map(f => `<details class="reveal"><summary>${f.q}</summary><p>${f.a}</p></details>`).join('')}
      </div>
    </section>

    <section class="lp-final">
      <h2>Ready to run your cooperative<br/>the smart way?</h2>
      <p>Join cooperatives already keeping clean, trustworthy books with cooplogNg.</p>
      <div class="lp-cta" style="justify-content:center;">
        <button class="lp-btn lp-btn-primary" data-lp="register">Register</button>
        <button class="lp-btn lp-btn-ghost" data-lp="login">Sign in</button>
      </div>
    </section>

    <footer class="lp-footer">
      cooplogNg — Cooperative Log App · Crafted by Imradex Global · Works online and offline
    </footer>
  </div>
  `;

  // Wire CTAs
  container.querySelectorAll('[data-lp="login"]').forEach(b => b.addEventListener('click', onLogin));
  container.querySelectorAll('[data-lp="register"]').forEach(b => b.addEventListener('click', onRegister));

  // Smooth-scroll in-page anchors. The app locks body scroll, so the
  // .landing element itself is the scroll container — scroll within it.
  const scroller = container.querySelector('.landing') || container;
  container.querySelectorAll('.lp-links a').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    const target = container.querySelector('#' + CSS.escape(id));
    if (!target) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 70;
    scroller.scrollTo({ top, behavior: 'smooth' });
  }));

  // Scroll-reveal on scroll
  const revealEls = container.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(el => io.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('in'));
  }

  // Animated counters
  const counters = container.querySelectorAll('[data-count]');
  const animate = (el) => {
    const target = parseInt(el.dataset.count, 10) || 0;
    const dur = 1200;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if ('IntersectionObserver' in window) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          animate(en.target);
          cio.unobserve(en.target);
        }
      });
    }, { threshold: 0.4 });
    counters.forEach(el => cio.observe(el));
  } else {
    counters.forEach(animate);
  }

  // Start at top (body doesn't scroll in this app — reset our container)
  try { scroller.scrollTo(0, 0); } catch {}

  // Load release info (first-install downloads) from Firestore.
  // Publishing a version = edit the `releases/latest` doc, nothing else.
  (async () => {
    const setText = (key, value) => {
      container.querySelectorAll(`[data-rel="${key}"]`).forEach(el => { el.textContent = value || ''; });
    };
    const setBtn = (which, url) => {
      container.querySelectorAll(`[data-rel-btn="${which}"]`).forEach(a => {
        if (url) {
          a.href = url;
          a.removeAttribute('aria-disabled');
        } else {
          a.href = '#lp-download';
          a.setAttribute('aria-disabled', 'true');
        }
      });
    };
    // Fallback state until the doc loads (or if it never does)
    setBtn('apk', RELEASE_FALLBACK.apkUrl);
    setBtn('exe', RELEASE_FALLBACK.exeUrl);
    try {
      const { getDb, doc, getDoc } = await import('../firebase.js');
      const snap = await getDoc(doc(getDb(), RELEASE_DOC_PATH));
      if (!snap.exists()) return;
      const r = { ...RELEASE_FALLBACK, ...snap.data() };
      setText('apkVersion', r.apkVersion);
      setText('apkSize', r.apkSize);
      setText('exeVersion', r.exeVersion);
      setText('exeSize', r.exeSize);
      setText('notes', r.notes);
      setBtn('apk', r.apkUrl);
      setBtn('exe', r.exeUrl);
    } catch (e) {
      console.warn('[Landing] Release info unavailable (offline or missing doc):', e?.message || e);
    }
  })();
}
