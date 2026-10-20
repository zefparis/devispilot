'use strict';

/* ============================================================
   Perspecta — frontend
   Toutes les données passent par l'API (session cookie HttpOnly).
   Sans session valide : seules la page commerciale et les écrans
   d'authentification sont accessibles.
   ============================================================ */

// URL de base de l'API : injectée par config.js (déploiement front séparé).
// Chaîne vide = même origine (auto-hébergement X3, dev local).
const API_BASE = (window.DP_API_URL || '').replace(/\/+$/, '');

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const day = d => {
  const a = new Date();
  a.setDate(a.getDate() + d);
  return new Date(a.getTime() - a.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const money = n => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => new Date(s + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtDateTime = s => new Date(s).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00').getTime());

const labels = { sent: 'Envoyé', replied: 'Réponse reçue', won: 'Signé', lost: 'Perdu' };
const statusIcon = { sent: 'i-send', replied: 'i-msg', won: 'i-check', lost: 'i-x' };
const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* ---------- État global ---------- */
let mode = 'landing';            // 'landing' | 'live'
let session = null;              // { user, company }
let signupEnabled = false;
let cgvVersion = '';             // version des CGV lue depuis /api/config
function emptyState() {
  return { settings: { company: '', signature: '', stripe: '' }, quotes: [] };
}
let state = emptyState();

/* ---------- Toast ---------- */
let toastTimer;
function toast(text, type = 'success') {
  const t = $('#toast');
  const ic = { success: 'i-check', error: 'i-alert', info: 'i-info' }[type] || 'i-info';
  t.innerHTML = icon(ic) + esc(text);
  t.className = `show t-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

/* Protection anti double-soumission */
function busy(el) {
  el.disabled = true; el.classList.add('is-busy');
  return () => { el.disabled = false; el.classList.remove('is-busy'); };
}

/* ---------- Dialogue de confirmation ---------- */
let confirmResolve = null;
const confirmDlg = $('#confirm');
function askConfirm(title, text, okLabel = 'Confirmer') {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  confirmDlg.showModal();
  return new Promise(res => { confirmResolve = res; });
}
$('#confirm-ok').onclick = () => { confirmDlg.close(); confirmResolve?.(true); confirmResolve = null; };
$('#confirm-cancel').onclick = () => { confirmDlg.close(); confirmResolve?.(false); confirmResolve = null; };
confirmDlg.addEventListener('cancel', () => { confirmResolve?.(false); confirmResolve = null; });
confirmDlg.addEventListener('close', () => { confirmResolve?.(false); confirmResolve = null; });

/* Fermeture des dialogues au clic sur le fond */
$$('dialog').forEach(d => d.addEventListener('click', e => {
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
}));

/* ---------- Couche API ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(API_BASE + '/api' + path, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-devispilot-client': '1',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* réponse vide */ }
  if (!r.ok) {
    const err = Object.assign(new Error(data?.error || 'Erreur serveur.'), { status: r.status, code: data?.code });
    if (r.status === 401 && mode === 'live') {
      session = null; mode = 'landing';
      showAuth('Votre session a expiré. Reconnectez-vous.');
    }
    throw err;
  }
  return data;
}

/* Recharge les données serveur */
async function refresh() {
  const [{ quotes }, st] = await Promise.all([api('/quotes'), api('/settings')]);
  state.quotes = quotes.map(q => ({ ...q, fups: Number(q.followup_count) || 0 }));
  state.settings = { company: st.company, signature: st.signature, stripe: st.stripe_link };
}

/* ---------- Navigation entre vues ---------- */
function show(view) {
  $('.site-header').hidden = view !== 'landing';
  $('#landing').hidden = view !== 'landing';
  $('#auth').hidden = view !== 'auth';
  $('#onboard').hidden = view !== 'onboard';
  $('#app').hidden = view !== 'app';
  $('#admin').hidden = view !== 'admin';
  $('#legal').hidden = view !== 'legal';
  window.scrollTo(0, 0);
}
async function enterLive() {
  try { await refresh(); } catch (e) { return toast(e.message, 'error'); }
  show('app');
  render();
}
// data-open = appel à l'action principal → inscription ; data-auth → connexion.
$$('[data-open]').forEach(b => b.onclick = () => mode === 'live' ? enterLive() : showAuth('signup'));
$$('[data-auth]').forEach(b => b.onclick = () => mode === 'live' ? enterLive() : showAuth('login'));
$$('[data-landing]').forEach(b => b.onclick = () => show('landing'));
$('#auth-home').onclick = e => { e.preventDefault(); show('landing'); };
$('#brand-home').onclick = e => { e.preventDefault(); show('landing'); };

async function logout() {
  try { await api('/auth/sign-out', { method: 'POST', body: {} }); } catch { /* session déjà close */ }
  session = null; mode = 'landing'; state = emptyState();
  show('landing');
  toast('Vous êtes déconnecté.', 'info');
}
$('#logout').onclick = logout;
$('#logout-m').onclick = logout;
$('#menu-logout').onclick = () => { hideMenu(); logout(); };
$('#menu-admin').onclick = () => { hideMenu(); enterAdmin(); };
$('#admin-back').onclick = () => { history.replaceState(null, '', '/'); enterLive(); };

/* Menu utilisateur (en-tête) */
const menuPop = $('#user-menu');
function hideMenu() { menuPop.hidden = true; $('#top-avatar').setAttribute('aria-expanded', 'false'); }
$('#top-avatar').onclick = e => {
  e.stopPropagation();
  menuPop.hidden = !menuPop.hidden;
  $('#top-avatar').setAttribute('aria-expanded', String(!menuPop.hidden));
};
document.addEventListener('click', e => { if (!e.target.closest('.user-menu')) hideMenu(); });

const tabNames = { pipeline: "Vue d'ensemble", followups: 'Relances à préparer', settings: 'Paramètres', account: 'Compte' };
function tab(id) {
  $$('.tab').forEach(el => { el.hidden = el.id !== id; });
  $$('.nav-item[data-tab], .mobile-item[data-tab], .user-menu-item[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  $('#breadcrumb').textContent = tabNames[id];
  if (id === 'account') loadAccount();
  if (id === 'settings') loadBilling();
  render();
  window.scrollTo(0, 0);
}
/* data-tab géré par délégation (éléments dynamiques inclus) — voir listener global. */

/* ---------- Authentification ---------- */
/* ---------- Pages légales (publiques) ---------- */
const LEGAL_PATHS = { '/mentions-legales': 'legal-mentions', '/cgv': 'legal-cgv', '/confidentialite': 'legal-privacy' };
function showLegal(path) {
  const article = LEGAL_PATHS[path];
  if (!article) return false;
  show('legal');
  for (const id of Object.values(LEGAL_PATHS)) $('#' + id).hidden = id !== article;
  $$('.legal-nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === path));
  if (location.pathname !== path) history.pushState(null, '', path);
  document.title = 'Perspecta — ' + ({ mentions: 'Mentions légales', cgv: 'CGV', confidentialite: 'Confidentialité' })[path === '/mentions-legales' ? 'mentions' : path === '/cgv' ? 'cgv' : 'confidentialite'];
  return true;
}
// Remplit les informations légales injectées au build (jamais codées en dur).
function fillLegal() {
  const L = window.DP_LEGAL || {};
  $$('[data-legal]').forEach(el => { el.textContent = L[el.dataset.legal] || '—'; });
  $$('[data-legal-email]').forEach(el => { el.href = `mailto:${L.email || ''}`; });
  $$('[data-legal-version]').forEach(el => { el.textContent = cgvVersion || '—'; });
  $('#legal-warn').hidden = !(window.DP_LEGAL_MISSING?.length);
}
$('[data-legal-back]').onclick = () => { location.href = '/'; };

const authForms = ['login-form', 'signup-form', 'forgot-form', 'reset-form', 'verify-note'];
function showAuthForm(id) {
  authForms.forEach(f => { $('#' + f).hidden = f !== id; });
}
function showAuth(which = 'login', msg) {
  show('auth');
  if (which === 'signup' && signupEnabled) $('#tab-signup').click();
  else if (which === 'reset') showAuthForm('reset-form');
  else if (which === 'verify') showAuthForm('verify-note');
  else { $('#tab-login').click(); }
  if (msg) toast(msg, 'info');
}
$('#tab-login').onclick = () => {
  $('#tab-login').classList.add('active'); $('#tab-signup').classList.remove('active');
  showAuthForm('login-form');
};
$('#tab-signup').onclick = () => {
  $('#tab-signup').classList.add('active'); $('#tab-login').classList.remove('active');
  showAuthForm('signup-form');
};
$('#forgot-link').onclick = () => showAuthForm('forgot-form');
$('#forgot-back').onclick = () => showAuthForm('login-form');
$('#verify-back').onclick = () => showAuthForm('login-form');

async function afterAuth() {
  const me = await api('/me');
  session = me;
  if (!me?.company) { show('onboard'); return; }
  mode = 'live';
  await enterLive();
}

$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#login-btn')), err = $('#err-login');
  err.hidden = true;
  const email = f.elements.email.value.trim();
  try {
    await api('/auth/sign-in/email', { method: 'POST', body: { email, password: f.elements.password.value } });
    f.reset();
    await afterAuth();
  } catch (err2) {
    err.hidden = false;
    if (err2.status === 403 || /vérifi|verif/i.test(err2.message || '')) {
      err.textContent = 'Email non confirmé. Cliquez sur le lien reçu par email, ou ';
      const a = document.createElement('button');
      a.className = 'btn btn-quiet btn-sm'; a.type = 'button'; a.textContent = 'renvoyez-le';
      a.onclick = async () => {
        try { await api('/auth/send-verification-email', { method: 'POST', body: { email, callbackURL: location.origin + '/?verifie=1' } }); toast('Email de confirmation renvoyé.', 'info'); }
        catch (e3) { toast(e3.message, 'error'); }
      };
      err.appendChild(a);
    } else {
      err.textContent = err2.status === 401 ? 'Email ou mot de passe incorrect.' : (err2.message || 'Connexion impossible.');
    }
  } finally { unbusy(); }
};

$('#signup-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#signup-btn')), err = $('#err-signup');
  err.hidden = true;
  const payload = {
    name: f.elements.name.value.trim(),
    email: f.elements.email.value.trim(),
    password: f.elements.password.value,
    cgvAccepted: true,
    cgvVersion,
  };
  const cgvErr = $('#err-cgv');
  cgvErr.hidden = true;
  if (!$('#s-cgv').checked) {
    cgvErr.hidden = false; cgvErr.textContent = 'Acceptez les CGV pour créer votre compte.';
    unbusy(); return;
  }
  if (payload.password.length < 12) { err.hidden = false; err.textContent = 'Mot de passe : 12 caractères minimum.'; unbusy(); return; }
  try {
    await api('/auth/sign-up/email', { method: 'POST', body: payload });
    // L'entreprise sera créée à la première connexion (après vérification).
    sessionStorage.setItem('dp-pending-company', f.elements.company.value.trim());
    $('#verify-email-addr').textContent = payload.email;
    f.reset();
    showAuthForm('verify-note');
  } catch (err2) {
    err.hidden = false;
    err.textContent = err2.status === 422 ? 'Cet email est déjà utilisé.' : (err2.message || 'Inscription impossible.');
  } finally { unbusy(); }
};

$('#forgot-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#forgot-btn')), err = $('#err-forgot'), ok = $('#ok-forgot');
  err.hidden = ok.hidden = true;
  try {
    await api('/auth/request-password-reset', { method: 'POST', body: { email: f.elements.email.value.trim(), redirectTo: location.origin + '/reinitialiser' } });
    ok.hidden = false;
    ok.textContent = 'Si un compte correspond à cet email, un lien de réinitialisation vient de partir (valable 1 h).';
    f.reset();
  } catch (err2) { err.hidden = false; err.textContent = err2.message || 'Demande impossible.'; }
  finally { unbusy(); }
};

$('#reset-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#reset-btn')), err = $('#err-reset');
  err.hidden = true;
  const p1 = f.elements.password.value, p2 = f.elements.password2.value;
  if (p1.length < 12) { err.hidden = false; err.textContent = 'Mot de passe : 12 caractères minimum.'; unbusy(); return; }
  if (p1 !== p2) { err.hidden = false; err.textContent = 'Les deux mots de passe ne correspondent pas.'; unbusy(); return; }
  const token = new URLSearchParams(location.search).get('token') || '';
  try {
    await api('/auth/reset-password', { method: 'POST', body: { newPassword: p1, token } });
    history.replaceState(null, '', '/');
    f.reset();
    $('#tab-login').click();
    toast('Mot de passe mis à jour. Connectez-vous.', 'success');
  } catch (err2) {
    err.hidden = false;
    err.textContent = 'Lien expiré ou déjà utilisé. Redemandez un lien de réinitialisation.';
  } finally { unbusy(); }
};

$('#company-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#company-btn')), err = $('#err-company-name');
  err.hidden = true;
  try {
    const c = await api('/companies', { method: 'POST', body: { name: f.elements.name.value.trim() } });
    session.company = c;
    sessionStorage.removeItem('dp-pending-company');
    mode = 'live';
    await enterLive();
    toast('Espace créé. Bienvenue !');
  } catch (err2) { err.hidden = false; err.textContent = err2.message; }
  finally { unbusy(); }
};

/* ---------- Rendu ---------- */
const active = q => ['sent', 'replied'].includes(q.status);
const due = () => state.quotes.filter(q => active(q) && q.next <= day(0)).sort((a, b) => a.next.localeCompare(b.next));

function initials(name) {
  return String(name || 'DP').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'DP';
}
function badge(status) {
  return `<span class="badge badge-${status}">${icon(statusIcon[status])}${labels[status]}</span>`;
}
function nextInfo(q) {
  if (!active(q)) return { text: 'Suivi clôturé', sub: q.status === 'won' ? 'Signature déclarée, non encaissée' : 'Sans suite', kind: 'closed' };
  const late = q.next < day(0);
  const today = q.next === day(0);
  return {
    text: fmtDate(q.next),
    sub: late ? 'Relance en retard' : today ? 'Relance à préparer' : 'Relance planifiée',
    kind: late ? 'late' : today ? 'today' : 'planned',
  };
}
const fups = q => q.fups ?? q.history?.length ?? 0;

function render() {
  const open = state.quotes.filter(active);
  const won = state.quotes.filter(q => q.status === 'won');
  const queue = due();
  const sends = state.quotes.reduce((n, q) => n + fups(q), 0);

  $('#today').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();

  $('#stats').innerHTML = [
    { icon: 'i-bell', cls: 'highlight', label: 'Relances à préparer', value: queue.length, sub: `${money(queue.reduce((n, q) => n + q.amount, 0))} de devis concernés` },
    { icon: 'i-clock', cls: '', label: 'Devis ouverts', value: money(open.reduce((n, q) => n + q.amount, 0)), sub: `${open.length} devis en attente de réponse` },
    { icon: 'i-check', cls: '', label: 'Devis signés (déclarés)', value: money(won.reduce((n, q) => n + q.amount, 0)), sub: `${won.length} signature(s) · paiement non vérifié` },
    { icon: 'i-info', cls: 'neutral', label: 'Paiements non connectés', value: '—', sub: 'Aucune intégration de paiement active' },
  ].map(s => `<article class="stat ${s.cls}">
      <div class="stat-head">${icon(s.icon)}<p>${s.label}</p></div>
      <strong>${s.value}</strong><small>${s.sub}</small>
    </article>`).join('');

  /* Bandeau contextuel */
  $('#data-label').textContent = `Connecté · ${state.settings.company}`;
  $('#notice-text').textContent = 'Données sauvegardées côté serveur, isolées par entreprise.';
  $('#notice-action').hidden = true;

  /* Bande relances du jour + badges nav */
  const strip = $('#due-strip');
  $('#nav-due').hidden = $('#nav-due-m').hidden = !queue.length;
  $('#nav-due').textContent = $('#nav-due-m').textContent = queue.length;
  if (queue.length) {
    strip.hidden = false;
    $('#due-list').innerHTML = queue.slice(0, 4).map(q => {
      const ni = nextInfo(q);
      return `<div class="due-item">
        <span class="avatar">${esc(initials(q.client))}</span>
        <div class="due-item-main">
          <strong>${esc(q.client)}</strong>
          <small>${esc(q.project)} · ${money(q.amount)} HT · ${ni.sub.toLowerCase()}</small>
        </div>
        <span class="badge ${q.next < day(0) ? 'badge-late' : 'badge-due'}">${icon('i-clock')}${q.next < day(0) ? 'En retard' : "Aujourd'hui"}</span>
        <button class="btn btn-outline btn-sm" data-compose="${esc(q.id)}">Préparer</button>
      </div>`;
    }).join('') + (queue.length > 4 ? `<p class="subtle" style="padding-top:10px">+ ${queue.length - 4} autre(s) dans l'onglet Relances.</p>` : '');
  } else strip.hidden = true;

  renderRows();

  $('#queue').innerHTML = queue.length ? queue.map(q => `
    <article class="queue-card">
      <div>
        <p class="eyebrow">${q.next < day(0) ? 'Suivi en retard' : 'À suivre aujourd’hui'}</p>
        <h3>${esc(q.client)}</h3>
        <p class="q-meta">${esc(q.project)} · ${money(q.amount)} HT · devis envoyé le ${fmtDate(q.sent)}</p>
        <p class="q-notes">${icon('i-msg')}${esc(q.notes || 'Aucune note')} · ${fups(q)} relance(s) déclarée(s)</p>
      </div>
      <button class="btn btn-primary" data-compose="${esc(q.id)}">Préparer la relance</button>
    </article>`).join('')
    : `<div class="panel empty-state">
         ${icon('i-check', 'icon empty-icon')}
         <h3>Aucune relance échue</h3>
         <p>Tout est à jour. Retrouvez vos devis dans la vue d'ensemble pour planifier le prochain suivi.</p>
         <button class="btn btn-outline" data-tab="pipeline">Voir mes devis</button>
       </div>`;

  /* Réglages */
  const f = $('#settings-form');
  if (document.activeElement?.form !== f) {
    f.elements.company.value = state.settings.company;
    // Signature : valeur serveur, sinon pré-remplie avec le nom de l'utilisateur.
    f.elements.signature.value = state.settings.signature || session?.user?.name || '';
    f.elements.stripe.value = state.settings.stripe;
  }
  $('#ws-name').textContent = state.settings.company;
  $('#ws-avatar').textContent = initials(session?.user?.name || state.settings.company);
  $('#top-avatar').textContent = initials(session?.user?.name || state.settings.company);
  $('#user-menu-email').textContent = session?.user?.email || '';
  $('#menu-admin').hidden = !session?.admin;
  // CGV : version courante non acceptée → bandeau jusqu'à acceptation.
  if (session?.user && session.cgv_current === false) showCgvBanner();
}

/* ---------- Table + cartes ---------- */
function filtered() {
  const query = $('#search').value.toLocaleLowerCase('fr');
  const filter = $('#filter').value;
  return state.quotes.filter(q => {
    const matchQuery = `${q.client} ${q.project}`.toLocaleLowerCase('fr').includes(query);
    const matchFilter = filter === 'all' ? true : filter === 'due' ? (active(q) && q.next <= day(0)) : q.status === filter;
    return matchQuery && matchFilter;
  });
}

function renderRows() {
  const rows = filtered();
  $('#count').textContent = `${rows.length} devis affiché(s) · montants hors taxes`;

  $('#rows').innerHTML = rows.map(q => {
    const ni = nextInfo(q);
    return `<tr>
      <td><strong>${esc(q.client)}</strong><span class="cell-sub">${esc(q.project)}</span></td>
      <td class="amount"><strong>${money(q.amount)}</strong></td>
      <td>${badge(q.status)}</td>
      <td><span class="${ni.kind === 'late' ? 'due-text' : ni.kind === 'today' ? 'soon-text' : ''}">${ni.text}</span><span class="cell-sub">${ni.sub} · ${fups(q)} relance(s)</span></td>
      <td><div class="row-actions">
        ${active(q) ? `<button class="btn btn-outline" data-compose="${esc(q.id)}">Relancer</button>` : ''}
        <button class="btn btn-quiet" data-edit="${esc(q.id)}" aria-label="Modifier le devis ${esc(q.client)}">${icon('i-pen')}Modifier</button>
      </div></td>
    </tr>`;
  }).join('');

  $('#cards').innerHTML = rows.map(q => {
    const ni = nextInfo(q);
    return `<article class="q-card">
      <div class="q-card-top">
        <div><strong>${esc(q.client)}</strong><small>${esc(q.project)}</small></div>
        ${badge(q.status)}
      </div>
      <div class="q-card-meta">
        <span class="amount">${money(q.amount)} HT</span>
        <span class="q-card-next">${icon('i-cal')}<span class="${ni.kind === 'late' ? 'due-text' : ni.kind === 'today' ? 'soon-text' : ''}">${ni.text}</span> · ${ni.sub}</span>
      </div>
      <div class="q-card-actions">
        ${active(q) ? `<button class="btn btn-primary btn-sm" data-compose="${esc(q.id)}">Préparer la relance</button>` : ''}
        <button class="btn btn-outline btn-sm" data-edit="${esc(q.id)}">Modifier</button>
      </div>
    </article>`;
  }).join('');

  const empty = $('#empty');
  if (!state.quotes.length) {
    empty.hidden = false;
    $('#empty-title').textContent = "Aucun devis pour l'instant";
    $('#empty-text').textContent = 'Ajoutez votre première opportunité, ou importez un CSV pour reprendre un portefeuille existant.';
    $('#empty-add').innerHTML = icon('i-plus') + 'Ajouter un devis';
    $('#empty-add').dataset.mode = 'add';
  } else if (!rows.length) {
    empty.hidden = false;
    $('#empty-title').textContent = 'Aucun devis ne correspond';
    $('#empty-text').textContent = 'Modifiez la recherche ou le filtre de statut pour élargir la liste.';
    $('#empty-add').innerHTML = icon('i-x') + 'Réinitialiser les filtres';
    $('#empty-add').dataset.mode = 'reset';
  } else empty.hidden = true;
}

$('#search').oninput = renderRows;
$('#filter').onchange = renderRows;
$('#empty-add').onclick = () => {
  if ($('#empty-add').dataset.mode === 'reset') { $('#search').value = ''; $('#filter').value = 'all'; renderRows(); }
  else editQuote();
};

/* ---------- Actions déléguées ---------- */
document.addEventListener('click', e => {
  const edit = e.target.closest('[data-edit]');
  const compose = e.target.closest('[data-compose]');
  const close = e.target.closest('[data-close]');
  const tabBtn = e.target.closest('[data-tab]');
  const revoke = e.target.closest('[data-revoke]');
  const adminAct = e.target.closest('[data-admin-act]');
  const subscribe = e.target.closest('[data-subscribe]');
  const portalBtn = e.target.closest('[data-portal]');
  const legalLink = e.target.closest('a[href^="/"]');
  if (edit) editQuote(edit.dataset.edit);
  if (compose) composeQuote(compose.dataset.compose);
  if (close) close.closest('dialog')?.close();
  if (tabBtn) { hideMenu(); tab(tabBtn.dataset.tab); }
  if (revoke) revokeSession(revoke.dataset.revoke);
  if (adminAct) adminAction(adminAct.dataset.adminAct, adminAct.dataset.id, adminAct.dataset.email, adminAct);
  if (subscribe) billingSubscribe(subscribe.dataset.subscribe, subscribe);
  if (portalBtn) billingPortal(portalBtn);
  if (legalLink && LEGAL_PATHS[new URL(legalLink.href).pathname]) {
    e.preventDefault();
    showLegal(new URL(legalLink.href).pathname);
  }
});

/* ---------- Validation de champs ---------- */
function setErr(input, errEl, msg) {
  errEl.hidden = !msg;
  errEl.textContent = msg || '';
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
}
function validateQuote(f) {
  const el = f.elements;
  let first = null;
  const check = (input, err, msg) => { setErr(input, err, msg); if (msg && !first) first = input; };
  check(el.client, $('#err-client'), el.client.value.trim() ? '' : 'Indiquez le nom du client.');
  check(el.project, $('#err-project'), el.project.value.trim() ? '' : 'Décrivez le projet en quelques mots.');
  const amount = Number(el.amount.value);
  check(el.amount, $('#err-amount'), !el.amount.value ? 'Indiquez le montant HT.' : (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) ? 'Montant invalide (0,01 à 10 000 000 €).' : '');
  check(el.sent, $('#err-sent'), isDate(el.sent.value) ? '' : 'Choisissez la date d’envoi du devis.');
  check(el.next, $('#err-next'), isDate(el.next.value) ? '' : 'Choisissez la date de la prochaine relance.');
  const em = el.email.value.trim();
  check(el.email, $('#err-email'), !em || el.email.validity.valid ? '' : 'Adresse email invalide.');
  first?.focus();
  return !first;
}
$('#quote-form').addEventListener('input', e => {
  const err = $(`#err-${e.target.name}`);
  if (err && !err.hidden) setErr(e.target, err, '');
});

/* ---------- Édition de devis ---------- */
function editQuote(id) {
  const q = state.quotes.find(x => x.id === id);
  const f = $('#quote-form');
  f.reset();
  $$('#quote-form [aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
  $$('#quote-form .field-error').forEach(i => { i.hidden = true; });
  $('#editor-title').textContent = q ? 'Modifier le devis' : 'Ajouter un devis';
  for (const k of ['id', 'client', 'email', 'project', 'amount', 'sent', 'status', 'next', 'notes'])
    f.elements[k].value = q?.[k] ?? ({ sent: day(0), next: day(3), status: 'sent' }[k] || '');
  $('#delete').hidden = !q;
  $('#editor').showModal();
}
$('#add').onclick = () => editQuote();

$('#quote-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  if (!validateQuote(f)) return;
  const unbusy = busy(f.querySelector('button[type=submit]'));
  const o = Object.fromEntries(new FormData(f));
  o.amount = Number(o.amount);
  o.client = o.client.trim(); o.project = o.project.trim(); o.email = o.email.trim(); o.notes = o.notes.trim();
  const old = state.quotes.find(q => q.id === o.id);
  try {
    const body = { client: o.client, email: o.email, project: o.project, amount: o.amount, sent: o.sent, next: o.next, status: o.status, notes: o.notes };
    if (old) await api(`/quotes/${o.id}`, { method: 'PATCH', body });
    else await api('/quotes', { method: 'POST', body });
    await refresh();
    $('#editor').close();
    render();
    toast(old ? 'Devis mis à jour.' : 'Devis enregistré.');
  } catch (err) {
    if (err.code === 'PLAN_LIMIT') {
      // Limite de l'offre Gratuit : message clair + porte de sortie vers Pro.
      $('#plan-limit-text').textContent = err.message;
      $('#plan-limit-note').hidden = false;
    }
    toast(err.message || 'Enregistrement impossible.', 'error');
    // La boîte reste ouverte : la saisie est conservée.
  } finally { unbusy(); }
};
$('#plan-limit-upgrade').onclick = () => {
  $('#plan-limit-note').hidden = true;
  $('#editor').close();
  tab('settings');
};

$('#delete').onclick = async () => {
  const id = $('#quote-form').elements.id.value;
  const q = state.quotes.find(x => x.id === id);
  if (!q) return;
  if (!await askConfirm('Supprimer ce devis ?', `« ${q.client} — ${q.project} » et son historique seront définitivement supprimés.`, 'Supprimer')) return;
  try {
    await api(`/quotes/${id}`, { method: 'DELETE' });
    await refresh();
    $('#editor').close(); render();
    toast('Devis supprimé.', 'info');
  } catch (err) { toast(err.message, 'error'); }
};

/* ---------- Composition de relance ---------- */
let current = null, composeKey = null;
function composeQuote(id) {
  current = id;
  composeKey = crypto.randomUUID();      // clé d'idempotence : retry sans doublon
  $('#tone').value = 'gentle';
  $('#next-date').value = day(7);
  makeMessage();
  $('#composer').showModal();
}
function makeMessage() {
  const q = state.quotes.find(q => q.id === current);
  if (!q) return;
  $('#compose-title').textContent = q.client;
  $('#subject').value = `Votre projet : ${q.project}`;
  const middle = {
    gentle: 'Avez-vous pu regarder notre proposition ? Je reste disponible pour répondre à vos questions.',
    help: 'Souhaitez-vous que nous prenions quelques minutes pour faire le point sur la proposition et vos besoins ? Vous pouvez me communiquer vos disponibilités.',
    closing: 'Votre projet est-il toujours d’actualité ? Si vous préférez que nous arrêtions le suivi, dites-le-moi simplement. Je respecterai votre choix.',
  }[$('#tone').value];
  const footer = [state.settings.signature || session?.user?.name || '', state.settings.company].filter(Boolean).join('\n');
  $('#message').value = `Bonjour,\n\nJe reviens vers vous concernant notre devis du ${fmtDate(q.sent)} pour votre projet « ${q.project} ».\n\n${middle}\n\nBien cordialement,\n${footer}`;
}
$('#tone').onchange = makeMessage;

$('#copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#message').value); toast('Message copié.'); }
  catch { $('#message').select(); toast('Sélectionnez puis copiez le message.', 'info'); }
};
$('#mail').onclick = () => {
  const q = state.quotes.find(q => q.id === current);
  if (!q?.email) return toast('Ajoutez un email au devis, ou copiez le message.', 'info');
  location.href = `mailto:${encodeURIComponent(q.email)}?subject=${encodeURIComponent($('#subject').value)}&body=${encodeURIComponent($('#message').value)}`;
};
$('#done').onclick = async () => {
  const q = state.quotes.find(q => q.id === current);
  if (!q) return;
  const next = $('#next-date').value;
  if (!isDate(next)) return toast('Choisissez la date du prochain suivi.', 'error');
  const unbusy = busy($('#done'));
  try {
    await api(`/quotes/${current}/followups`, {
      method: 'POST',
      body: { subject: $('#subject').value, next, idemKey: composeKey },
    });
    await refresh();
    $('#composer').close(); render();
    toast(`Relance déclarée envoyée. Prochain suivi le ${fmtDate(next)}.`);
  } catch (err) { toast(err.message, 'error'); }
  finally { unbusy(); }
};

/* ---------- Réglages ---------- */
$('#settings-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, s = Object.fromEntries(new FormData(f));
  let ok = true;
  setErr(f.elements.company, $('#err-company'), s.company.trim() ? '' : 'Indiquez le nom de votre entreprise.');
  setErr(f.elements.signature, $('#err-signature'), s.signature.trim() ? '' : 'Indiquez une signature pour vos messages.');
  const stripe = (s.stripe || '').trim();
  const stripeOk = !stripe || (() => { try { const u = new URL(stripe); return u.protocol === 'https:' && u.hostname === 'buy.stripe.com'; } catch { return false; } })();
  setErr(f.elements.stripe, $('#err-stripe'), stripeOk ? '' : 'Lien invalide : utilisez une URL https://buy.stripe.com/…');
  if (!f.elements.company.value.trim() || !f.elements.signature.value.trim() || !stripeOk) ok = false;
  if (!ok) return;

  const unbusy = busy(f.querySelector('button[type=submit]'));
  try {
    await api('/settings', { method: 'PATCH', body: { company: s.company.trim(), signature: s.signature.trim(), stripe } });
    await refresh(); render();
    toast('Paramètres enregistrés.');
  } catch (err) {
    setErr(f.elements.stripe, $('#err-stripe'), err.status === 400 && /stripe|lien/i.test(err.message) ? err.message : '');
    toast(err.message, 'error');
  } finally { unbusy(); }
};
$('#settings-form').addEventListener('input', e => {
  const err = $(`#err-${e.target.name}`);
  if (err && !err.hidden) setErr(e.target, err, '');
});
/* ---------- Abonnement ---------- */
const PLAN_NAMES = { free: 'Gratuit', pro: 'Perspecta Pro', team: 'Perspecta Équipe' };
const STATUS_TXT = {
  active: 'Abonnement actif', trialing: 'Période d\'essai',
  past_due: 'Paiement en échec — Stripe retente le prélèvement',
  canceled: 'Abonnement résilié', unpaid: 'Impayé',
};
const fmtPrice = c => c == null ? '—' : (c / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' €';

async function loadBilling() {
  const panel = $('#sub-panel'), body = $('#sub-body');
  if (mode !== 'live') return;
  panel.hidden = false;
  body.innerHTML = '<p class="form-intro">Chargement…</p>';
  try {
    const b = await api('/billing');
    if (!b.enabled) {
      body.innerHTML = '<p class="form-intro">La facturation n\'est pas encore activée.</p>';
      return;
    }
    const paid = b.plan !== 'free';
    let html = `<div class="sub-line">
      <span class="plan-badge${paid ? '' : ' free'}">${PLAN_NAMES[b.plan] ?? b.plan}</span>
      <strong>${STATUS_TXT[b.status] ?? (paid ? 'Abonnement actif' : 'Offre gratuite')}</strong>
    </div>`;
    if (b.usage.limit != null) {
      const pct = Math.min(100, Math.round(b.usage.active / b.usage.limit * 100));
      html += `<div class="usage">
        <div class="usage-bar${b.usage.active >= b.usage.limit ? ' full' : ''}"><i style="width:${pct}%"></i></div>
        <p class="usage-text">${b.usage.active} / ${b.usage.limit} devis actifs utilisés</p>
      </div>`;
    }
    if (paid && b.currentPeriodEnd) {
      html += `<p class="sub-meta">${b.cancelAtPeriodEnd
        ? `Résiliation programmée — accès jusqu'au ${new Date(b.currentPeriodEnd).toLocaleDateString('fr-FR')}.`
        : `Prochain renouvellement le ${new Date(b.currentPeriodEnd).toLocaleDateString('fr-FR')}.`}</p>`;
    }
    html += '<div class="sub-actions">';
    if (!paid) {
      const labels = { pro_monthly: 'Perspecta Pro mensuel', pro_yearly: 'Perspecta Pro annuel', team_monthly: 'Perspecta Équipe mensuel', team_yearly: 'Perspecta Équipe annuel' };
      html += (b.prices || []).map(p =>
        `<button class="btn btn-primary btn-sm" data-subscribe="${p.id}">${labels[p.key] ?? p.key} — ${fmtPrice(p.amount_cents)}${p.interval === 'year' ? '/an' : '/mois'}</button>`).join('')
        || '<p class="form-intro">Aucune offre configurée.</p>';
      const vat = window.DP_LEGAL?.vatMention;
      html += `<p class="sub-meta">Prix affichés sans TVA${vat ? ` · ${esc(vat)}` : ''}. Paiement sécurisé par Stripe.</p>`;
    }
    if (b.hasCustomer)
      html += `<button class="btn btn-quiet btn-sm" data-portal>${paid ? 'Gérer mon abonnement' : 'Portail de facturation'}<svg class="icon"><use href="#i-arrow"/></svg></button>`;
    html += '</div>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<p class="form-intro">${esc(e.message || 'Abonnement indisponible.')}</p>`;
  }
}

async function billingSubscribe(priceId, btn) {
  const unbusy = busy(btn);
  try {
    const { url } = await api('/billing/checkout', { method: 'POST', body: { priceId } });
    window.location.href = url;
  } catch (e) {
    if (e.code === 'CGV_REQUIRED') { showCgvBanner(); toast(e.message, 'error'); }
    else toast(e.message, 'error');
    unbusy();
  }
}

/* ---------- Bandeau CGV (ré-acceptation après mise à jour) ---------- */
function showCgvBanner() {
  $('#cgv-version-label').textContent = cgvVersion;
  $('#cgv-banner').hidden = false;
}
$('#cgv-accept').onclick = async e => {
  const unbusy = busy(e.target);
  try {
    await api('/legal/accept', { method: 'POST', body: { version: cgvVersion } });
    $('#cgv-banner').hidden = true;
    toast('CGV acceptées, merci.');
  } catch (err) { toast(err.message, 'error'); }
  finally { unbusy(); }
};
async function billingPortal(btn) {
  const unbusy = busy(btn);
  try {
    const { url } = await api('/billing/portal', { method: 'POST', body: {} });
    window.location.href = url;
  } catch (e) { toast(e.message, 'error'); unbusy(); }
}

/* ---------- Compte : profil, entreprise, sécurité ---------- */
let accountLoaded = false;
async function loadAccount() {
  if (mode !== 'live') return;
  try {
    const [me, company, sessions] = await Promise.all([
      api('/me'), api('/company'), api('/auth/list-sessions'),
    ]);
    session = { ...session, user: me.user, session_id: me.session_id };
    $('#p-name').value = me.user?.name || '';
    $('#p-email').value = me.user?.email || '';
    const cf = $('#company-info-form');
    if (document.activeElement?.form !== cf) {
      cf.elements.name.value = company.name || '';
      cf.elements.siren.value = company.siren || '';
      cf.elements.address.value = company.address || '';
      cf.elements.phone.value = company.phone || '';
      cf.elements.contact_email.value = company.contact_email || '';
    }
    renderLogo(company.has_logo);
    renderSessions(sessions || []);
    accountLoaded = true;
  } catch (err) { toast(err.message, 'error'); }
}

async function renderLogo(hasLogo) {
  const img = $('#logo-preview'), rm = $('#logo-remove');
  if (!hasLogo) { img.hidden = rm.hidden = true; img.removeAttribute('src'); return; }
  try {
    const r = await fetch(API_BASE + '/api/company/logo', { credentials: 'include' });
    if (!r.ok) throw 0;
    img.src = URL.createObjectURL(await r.blob());
    img.hidden = rm.hidden = false;
  } catch { img.hidden = rm.hidden = true; }
}

function renderSessions(list) {
  const mine = session?.session_id || '';
  $('#session-list').innerHTML = list.length ? list.map(s => `
    <li>
      <div>
        <strong>${esc((s.userAgent || 'Appareil inconnu').split(')')[0].replace(/^Mozilla\/[\d.]+ \(/, '').slice(0, 60) || 'Appareil')}</strong>
        ${mine && s.id === mine ? ' <span class="session-here">Cette session</span>' : ''}
        <small>Connecté le ${fmtDateTime(s.createdAt)} · expire le ${fmtDateTime(s.expiresAt)}${s.ipAddress ? ' · ' + esc(s.ipAddress) : ''}</small>
      </div>
      ${mine && s.id === mine ? '' : `<button class="btn btn-quiet btn-sm" data-revoke="${esc(s.token)}">Révoquer</button>`}
    </li>`).join('') : '<li class="subtle">Aucune autre session.</li>';
}

async function revokeSession(token) {
  if (!await askConfirm('Révoquer cette session ?', 'L\'appareil correspondant sera déconnecté immédiatement.', 'Révoquer')) return;
  try {
    await api('/auth/revoke-session', { method: 'POST', body: { token } });
    renderSessions(await api('/auth/list-sessions'));
    toast('Session révoquée.', 'info');
  } catch (err) { toast(err.message, 'error'); }
}
$('#revoke-others').onclick = async () => {
  if (!await askConfirm('Déconnecter les autres appareils ?', 'Toutes les sessions sauf celle-ci seront révoquées.', 'Tout déconnecter')) return;
  try {
    await api('/auth/revoke-other-sessions', { method: 'POST', body: {} });
    renderSessions(await api('/auth/list-sessions'));
    toast('Autres sessions révoquées.', 'info');
  } catch (err) { toast(err.message, 'error'); }
};

$('#profile-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#profile-btn')), errN = $('#err-pname'), errE = $('#err-pemail');
  errN.hidden = errE.hidden = true;
  const name = f.elements.name.value.trim();
  const newEmail = f.elements.newemail.value.trim();
  if (!name) { errN.hidden = false; errN.textContent = 'Indiquez votre nom.'; unbusy(); return; }
  try {
    await api('/profile', { method: 'PATCH', body: { name } });
    if (newEmail) {
      await api('/auth/change-email', { method: 'POST', body: { newEmail, callbackURL: location.origin + '/?verifie=1' } });
      f.elements.newemail.value = '';
      toast('Nom enregistré. Confirmez la nouvelle adresse via l\'email reçu.', 'info');
    } else {
      session.user.name = name;
      toast('Profil enregistré.');
    }
    render();
  } catch (err) {
    const msg = err.message || 'Enregistrement impossible.';
    if (/email/i.test(msg)) { errE.hidden = false; errE.textContent = msg; }
    else toast(msg, 'error');
  } finally { unbusy(); }
};

$('#company-info-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#company-info-btn')), errS = $('#err-siren'), errC = $('#err-cemail'), errN = $('#err-coname');
  errS.hidden = errC.hidden = errN.hidden = true;
  const siren = f.elements.siren.value.replace(/\s/g, '');
  if (siren && !/^\d{9}$|^\d{14}$/.test(siren)) { errS.hidden = false; errS.textContent = 'SIREN ou SIRET : 9 ou 14 chiffres.'; unbusy(); return; }
  if (!f.elements.name.value.trim()) { errN.hidden = false; errN.textContent = 'Indiquez la raison sociale.'; unbusy(); return; }
  try {
    await api('/company', { method: 'PATCH', body: {
      name: f.elements.name.value.trim(), siren,
      address: f.elements.address.value.trim(),
      phone: f.elements.phone.value.trim(),
      contact_email: f.elements.contact_email.value.trim(),
    } });
    state.settings.company = f.elements.name.value.trim();
    render();
    toast('Fiche entreprise enregistrée.');
  } catch (err) {
    const msg = err.message || 'Enregistrement impossible.';
    if (/siren/i.test(msg)) { errS.hidden = false; errS.textContent = msg; }
    else if (/contact/i.test(msg)) { errC.hidden = false; errC.textContent = msg; }
    else toast(msg, 'error');
  } finally { unbusy(); }
};

$('#co-logo').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 200 * 1024) return toast('Logo trop lourd : 200 Ko maximum.', 'error');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return toast('Format attendu : PNG, JPEG ou WebP.', 'error');
  const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  try {
    await api('/company/logo', { method: 'PUT', body: { data } });
    renderLogo(true);
    toast('Logo enregistré.');
  } catch (err) { toast(err.message, 'error'); }
};
$('#logo-remove').onclick = async () => {
  try { await api('/company/logo', { method: 'DELETE' }); renderLogo(false); toast('Logo retiré.', 'info'); }
  catch (err) { toast(err.message, 'error'); }
};

$('#password-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#password-btn')), err = $('#err-password');
  err.hidden = true;
  if (f.elements.next.value.length < 12) { err.hidden = false; err.textContent = 'Nouveau mot de passe : 12 caractères minimum.'; unbusy(); return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: {
      currentPassword: f.elements.current.value,
      newPassword: f.elements.next.value,
      revokeOtherSessions: true,
    } });
    f.reset();
    renderSessions(await api('/auth/list-sessions'));
    toast('Mot de passe changé. Les autres appareils ont été déconnectés.');
  } catch (err2) {
    err.hidden = false;
    err.textContent = /invalid|password|credential/i.test(err2.message || '') ? 'Mot de passe actuel incorrect.' : (err2.message || 'Changement impossible.');
  } finally { unbusy(); }
};

$('#export-data').onclick = async () => {
  try {
    const r = await fetch(API_BASE + '/api/export-data', { credentials: 'include' });
    if (!r.ok) throw new Error('Export impossible.');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `perspecta-export-${day(0)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Export JSON téléchargé.');
  } catch (err) { toast(err.message, 'error'); }
};

$('#delete-account').onclick = () => {
  $('#del-password').value = '';
  $('#err-delete-account').hidden = true;
  $('#delete-account-dlg').showModal();
};
$('#delete-account-confirm').onclick = async () => {
  const err = $('#err-delete-account'), unbusy = busy($('#delete-account-confirm'));
  err.hidden = true;
  try {
    await api('/auth/delete-user', { method: 'POST', body: { password: $('#del-password').value } });
    $('#delete-account-dlg').close();
    session = null; mode = 'landing'; state = emptyState();
    show('landing');
    toast('Compte supprimé. Vos données ont été effacées.', 'info');
  } catch (err2) {
    err.hidden = false;
    err.textContent = 'Mot de passe incorrect, ou session trop ancienne — reconnectez-vous puis réessayez.';
  } finally { unbusy(); }
};

/* ---------- Back-office administration ---------- */
const adminApi = (path, opts) => api('/admin' + path, opts);

async function enterAdmin() {
  if (!session?.admin) { history.replaceState(null, '', '/'); return; }
  history.replaceState(null, '', '/admin');
  show('admin');
  try {
    await Promise.all([loadAdminStats(), loadAdminCompanies(), loadAdminUsers(), loadAdminSettings(), loadAdminAudit()]);
  } catch (e) { toast(e.message, 'error'); }
}

async function loadAdminStats() {
  const s = await adminApi('/stats');
  const cards = [
    { label: 'Entreprises', value: s.companies },
    { label: 'Utilisateurs', value: s.users },
    { label: 'Inscriptions 7 j', value: s.signups7 },
    { label: 'Inscriptions 30 j', value: s.signups30 },
    { label: 'Emails non vérifiés', value: s.unverified },
    { label: 'Comptes suspendus', value: s.suspended },
    { label: 'Devis enregistrés', value: s.quotes },
    { label: 'Abonnés payants', value: s.paying ?? 0 },
    { label: 'Revenu mensuel récurrent', value: s.mrrCents != null ? fmtPrice(s.mrrCents) : '—' },
  ];
  $('#admin-stats').innerHTML = cards.map(c => `<article class="stat">
    <div class="stat-head">${icon('i-info')}<p>${c.label}</p></div>
    <strong>${c.value}</strong>
  </article>`).join('');
}

async function loadAdminCompanies() {
  const search = $('#admin-co-search').value.trim();
  const sort = $('#admin-co-sort').value;
  const { companies } = await adminApi(`/companies?search=${encodeURIComponent(search)}&sort=${sort}`);
  $('#admin-companies-count').textContent = `${companies.length} entreprise(s)`;
  $('#admin-companies').innerHTML = companies.map(c => {
    const paidPlan = ['active', 'trialing', 'past_due'].includes(c.subscription_status) && c.plan !== 'free';
    const planLabel = paidPlan ? (PLAN_NAMES[c.plan] ?? c.plan) : 'Gratuit';
    const sub = paidPlan && c.subscription_status !== 'active' ? ` · ${STATUS_TXT[c.subscription_status] ?? c.subscription_status}` : '';
    return `<tr>
    <td><strong>${esc(c.name)}</strong></td>
    <td>${esc(c.siren || '—')}</td>
    <td><span class="plan-badge${paidPlan ? '' : ' free'}">${planLabel}</span>${esc(sub)}</td>
    <td>${new Date(c.created_at).toLocaleDateString('fr-FR')}</td>
    <td>${c.users_count}</td>
    <td>${c.quotes_count}</td>
    <td>${c.last_activity ? fmtDateTime(c.last_activity) : '—'}</td>
  </tr>`;
  }).join('') || '<tr><td colspan="7" class="subtle">Aucune entreprise.</td></tr>';
}
let adminSearchTimer;
$('#admin-co-search').oninput = () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(loadAdminCompanies, 300); };
$('#admin-co-sort').onchange = loadAdminCompanies;

async function loadAdminUsers() {
  const search = $('#admin-u-search').value.trim();
  const { users } = await adminApi(`/users?search=${encodeURIComponent(search)}`);
  $('#admin-users-count').textContent = `${users.length} utilisateur(s)`;
  $('#admin-users').innerHTML = users.map(u => `<tr${u.suspended_at ? ' class="row-suspended"' : ''}>
    <td><strong>${esc(u.name)}</strong><span class="cell-sub">${esc(u.email)}${u.suspended_at ? ' <span class="badge-suspended">Suspendu</span>' : ''}</span></td>
    <td>${esc(u.company_name || '—')}</td>
    <td>${u.email_verified ? '<span class="badge-verified">Vérifié</span>' : '<span class="badge-unverified">Non vérifié</span>'}</td>
    <td>${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
    <td>${u.last_seen ? fmtDateTime(u.last_seen) : '—'}</td>
    <td><div class="admin-actions">
      ${!u.email_verified ? `<button class="btn btn-quiet btn-sm" data-admin-act="verify" data-id="${u.id}" data-email="${esc(u.email)}">Forcer vérif.</button>
      <button class="btn btn-quiet btn-sm" data-admin-act="resend" data-id="${u.id}" data-email="${esc(u.email)}">Renvoyer l'email</button>` : ''}
      <button class="btn btn-quiet btn-sm" data-admin-act="${u.suspended_at ? 'reactivate' : 'suspend'}" data-id="${u.id}" data-email="${esc(u.email)}">${u.suspended_at ? 'Réactiver' : 'Suspendre'}</button>
      <button class="btn btn-quiet btn-sm" data-admin-act="revoke" data-id="${u.id}" data-email="${esc(u.email)}">Révoquer sessions</button>
      <button class="btn btn-quiet btn-sm" data-admin-act="delete" data-id="${u.id}" data-email="${esc(u.email)}">Supprimer</button>
    </div></td>
  </tr>`).join('') || '<tr><td colspan="6" class="subtle">Aucun utilisateur.</td></tr>';
}
let adminUSearchTimer;
$('#admin-u-search').oninput = () => { clearTimeout(adminUSearchTimer); adminUSearchTimer = setTimeout(loadAdminUsers, 300); };

async function loadAdminSettings() {
  const s = await adminApi('/settings');
  $('#admin-signup-toggle').checked = !!s.signupEnabled;
}
$('#admin-signup-toggle').onchange = async e => {
  try {
    await adminApi('/settings', { method: 'PUT', body: { signupEnabled: e.target.checked } });
    toast(`Inscription publique ${e.target.checked ? 'ouverte' : 'fermée'}.`, 'info');
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, 'error');
  }
};

$('#admin-invite-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#invite-btn')), err = $('#err-invite');
  err.hidden = true;
  try {
    await adminApi('/accounts', { method: 'POST', body: {
      email: f.elements.email.value.trim(), name: f.elements.name.value.trim(),
    } });
    f.reset();
    toast('Compte créé. Email d\'invitation envoyé.');
    loadAdminUsers();
  } catch (err2) { err.hidden = false; err.textContent = err2.message || 'Création impossible.'; }
  finally { unbusy(); }
};

async function loadAdminAudit() {
  const { entries } = await adminApi('/audit');
  $('#admin-audit').innerHTML = entries.map(en => `<tr>
    <td>${fmtDateTime(en.created_at)}</td>
    <td>${esc(en.admin_email)}</td>
    <td><strong>${esc(en.action)}</strong></td>
    <td>${esc([en.target_type, en.target_id].filter(Boolean).join(' · ') || '—')}</td>
    <td>${esc(en.ip || '—')}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="subtle">Aucune action enregistrée.</td></tr>';
}

let adminDeleteTarget = null;
async function adminAction(act, id, email) {
  const done = msg => { toast(msg, 'info'); Promise.all([loadAdminUsers(), loadAdminAudit(), loadAdminStats()]).catch(() => {}); };
  try {
    switch (act) {
      case 'verify':
        if (!await askConfirm('Forcer la vérification ?', `L'email de ${email} sera marqué vérifié.`, 'Forcer')) return;
        await adminApi(`/users/${id}/verify`, { method: 'POST', body: {} });
        return done('Email marqué vérifié.');
      case 'resend':
        await adminApi(`/users/${id}/resend-verification`, { method: 'POST', body: {} });
        return done('Email de vérification renvoyé.');
      case 'suspend':
        if (!await askConfirm('Suspendre ce compte ?', `${email} ne pourra plus se connecter et toutes ses sessions seront révoquées.`, 'Suspendre')) return;
        await adminApi(`/users/${id}/suspend`, { method: 'POST', body: { suspended: true } });
        return done('Compte suspendu.');
      case 'reactivate':
        await adminApi(`/users/${id}/suspend`, { method: 'POST', body: { suspended: false } });
        return done('Compte réactivé.');
      case 'revoke':
        if (!await askConfirm('Révoquer les sessions ?', `Toutes les sessions de ${email} seront fermées.`, 'Révoquer')) return;
        await adminApi(`/users/${id}/revoke-sessions`, { method: 'POST', body: {} });
        return done('Sessions révoquées.');
      case 'delete':
        adminDeleteTarget = { id, email };
        $('#admin-delete-email').textContent = email;
        $('#admin-delete-confirm-email').value = '';
        $('#err-admin-delete').hidden = true;
        $('#admin-delete-dlg').showModal();
        return;
    }
  } catch (err) { toast(err.message, 'error'); }
}

$('#admin-delete-confirm').onclick = async () => {
  const err = $('#err-admin-delete'), unbusy = busy($('#admin-delete-confirm'));
  err.hidden = true;
  const typed = $('#admin-delete-confirm-email').value.trim().toLowerCase();
  if (typed !== adminDeleteTarget?.email?.toLowerCase()) {
    err.hidden = false; err.textContent = 'L\'email saisi ne correspond pas.'; unbusy(); return;
  }
  try {
    await adminApi(`/users/${adminDeleteTarget.id}`, { method: 'DELETE' });
    $('#admin-delete-dlg').close();
    toast('Compte supprimé.', 'info');
    Promise.all([loadAdminUsers(), loadAdminAudit(), loadAdminStats()]).catch(() => {});
  } catch (err2) { err.hidden = false; err.textContent = err2.message || 'Suppression impossible.'; }
  finally { unbusy(); }
};

/* ---------- CSV ---------- */
function csvCell(x) {
  let s = String(x ?? '');
  if (/^[=+@\-\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export').onclick = async () => {
  try {
    const r = await fetch(API_BASE + '/api/export.csv', { credentials: 'include' });
    if (r.status === 401) { session = null; mode = 'landing'; showAuth('login', 'Votre session a expiré.'); return; }
    if (!r.ok) throw new Error('Export impossible.');
    download('perspecta-devis.csv', await r.text());
    toast('Export des devis téléchargé. Historique détaillé non inclus.');
  } catch (err) { toast(err.message, 'error'); }
};
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0], delim = first.includes(';') ? ';' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === delim && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some(x => x.trim())) rows.push(row);
      row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw Error('Guillemets non fermés.');
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
/* Empreinte stable de ligne → import CSV idempotent. */
function rowKey(q) {
  let h = 0x811c9dc5;
  const s = [q.client, q.email, q.project, q.amount, q.sent, q.status, q.next].join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'csv-' + (h >>> 0).toString(36);
}
$('#import').onclick = () => $('#csv').click();
$('#csv').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 2000000) return toast('CSV trop volumineux : maximum 2 Mo.', 'error');
  try {
    const [header, ...rows] = parseCSV(await file.text());
    if (!header || !rows.length) throw Error('Le CSV ne contient pas de devis.');
    const keys = header.map(s => s.trim().toLowerCase());
    for (const k of ['client', 'project', 'amount', 'sent', 'status', 'next'])
      if (!keys.includes(k)) throw Error('Colonnes requises : client, project, amount, sent, status, next. Exportez le modèle pour obtenir le format.');
    if (rows.length > 2000) throw Error('Maximum 2 000 lignes par import.');
    const incoming = rows.map((r, i) => {
      const q = Object.fromEntries(keys.map((k, j) => [k, (r[j] || '').trim()]));
      q.amount = Number(q.amount.replace(',', '.'));
      if (!q.client || !q.project || q.client.length > 100 || q.project.length > 200
        || !Number.isFinite(q.amount) || q.amount <= 0 || q.amount > 10000000
        || !Object.hasOwn(labels, q.status)
        || ![q.sent, q.next].every(isDate))
        throw Error('Données invalides à la ligne ' + (i + 2) + '. Aucun devis importé.');
      return {
        import_key: rowKey(q),
        client: q.client, email: (q.email || '').slice(0, 200), project: q.project,
        amount: q.amount, sent: q.sent, next: q.next, status: q.status,
        notes: (q.notes || '').slice(0, 2000), history: [],
      };
    });
    if (!await askConfirm('Importer ces devis ?', `${incoming.length} devis seront ajoutés à votre portefeuille. L'import est idempotent : relancer le même fichier ne crée pas de doublons.`, 'Importer')) return;

    const res = await api('/import', { method: 'POST', body: { quotes: incoming } });
    await refresh(); render();
    toast(`${res.imported} devis importé(s), ${res.skipped} ignoré(s)` + (res.errors?.length ? `, ${res.errors.length} erreur(s)` : '') + '.');
  } catch (err) { toast(err.message, 'error'); }
};

/* ---------- Démarrage ---------- */
(async function boot() {
  // Lien de réinitialisation : /reinitialiser?token=…
  const params = new URLSearchParams(location.search);
  const resetToken = location.pathname === '/reinitialiser' && params.get('token');
  const justVerified = params.get('verifie') === '1';
  const billingResult = params.get('billing');

  try {
    const c = await api('/config');
    signupEnabled = !!c.signupEnabled;
    cgvVersion = c.cgvVersion ?? '';
  } catch { signupEnabled = false; }
  fillLegal();
  $('#auth-tabs').hidden = !signupEnabled;
  $('#tab-signup').hidden = !signupEnabled;

  // Montants des offres relus depuis Stripe (endpoint public, cache serveur).
  // L'offre Équipe est masquée tant que le serveur ne la publie pas.
  try {
    const { prices } = await api('/billing/prices');
    const keys = new Set((prices || []).map(p => p.key));
    const team = document.querySelector('[data-plan-card="team"]');
    if (team) team.hidden = ![...keys].some(k => k.startsWith('team_'));
    $$('[data-price]').forEach(el => {
      const p = (prices || []).find(x => x.key === el.dataset.price);
      if (p?.amount_cents != null) el.textContent = fmtPrice(p.amount_cents);
    });
  } catch { /* prix non disponibles : « — » affiché */ }

  if (resetToken) { showAuth('reset'); return; }
  // Pages légales : publiques, sans connexion.
  if (showLegal(location.pathname)) return;

  try {
    const me = await api('/me');
    if (me?.user) {
      session = me;
      if (me.company) {
        mode = 'live'; await refresh(); render();
        // Route directe /admin : réservée aux superadmins (ADMIN_EMAILS côté API).
        if (location.pathname === '/admin' && me.admin) { enterAdmin(); return; }
        if (location.pathname === '/admin') history.replaceState(null, '', '/');
        // Retour de Stripe Checkout : le webhook a déjà mis à jour l'offre.
        if (billingResult === 'success') { history.replaceState(null, '', '/'); toast('Abonnement activé, merci !'); }
        else if (billingResult === 'cancel') { history.replaceState(null, '', '/'); toast('Souscription annulée — rien n\'a été débité.', 'info'); }
      }
      else {
        // Nom d'entreprise saisi à l'inscription, conservé en sessionStorage.
        const pending = sessionStorage.getItem('dp-pending-company');
        if (pending) $('#company-form').elements.name.value = pending;
        show('onboard');
        return;
      }
    }
  } catch { /* pas de session : page commerciale */ }
  if (justVerified) { history.replaceState(null, '', '/'); showAuth('login', 'Email confirmé. Connectez-vous pour accéder à votre espace.'); }
  render();
})();
