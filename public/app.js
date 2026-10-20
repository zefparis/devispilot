'use strict';

/* ============================================================
   DevisPilot — frontend
   Deux modes strictement séparés :
   - « demo » : données fictives en mémoire, rien n'est envoyé au serveur ;
   - « live » : toutes les données passent par l'API (session cookie HttpOnly).
   ============================================================ */

// URL de base de l'API : injectée par config.js (déploiement front séparé).
// Chaîne vide = même origine (auto-hébergement X3, dev local).
const API_BASE = (window.DP_API_URL || '').replace(/\/+$/, '');

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LEGACY_KEY = 'devispilot-v1';      // ancien stockage local (migration)
const MIG_DISMISS = 'dp-mig-dismissed';

const day = d => {
  const a = new Date();
  a.setDate(a.getDate() + d);
  return new Date(a.getTime() - a.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const money = n => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => new Date(s + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00').getTime());

const labels = { sent: 'Envoyé', replied: 'Réponse reçue', won: 'Signé', lost: 'Perdu' };
const statusIcon = { sent: 'i-send', replied: 'i-msg', won: 'i-check', lost: 'i-x' };
const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* ---------- État global ---------- */
let mode = 'landing';            // 'landing' | 'demo' | 'live'
let session = null;              // { user, company } en mode live
let signupEnabled = false;
function emptyState() {
  return { settings: { company: 'Atelier Confort', signature: 'Votre artisan', stripe: '' }, quotes: [] };
}
let state = emptyState();

function seedQuotes() {
  const demo = q => ({ ...q, id: crypto.randomUUID(), email: '', history: [], seed: true });
  return [
    demo({ client: 'Maison Laurent', project: 'Installation pompe à chaleur', amount: 6480, sent: day(-7), next: day(-1), status: 'sent', notes: 'Exemple fictif. Valider les disponibilités pour une visite.' }),
    demo({ client: 'Résidence des Oliviers', project: 'Climatisation réversible · 3 unités', amount: 4250, sent: day(-10), next: day(0), status: 'replied', notes: 'Exemple fictif. Une question sur le niveau sonore.' }),
    demo({ client: 'Atelier Martin', project: 'Entretien annuel chaudière', amount: 390, sent: day(-3), next: day(4), status: 'sent', notes: 'Exemple fictif.' }),
    demo({ client: 'Maison Vidal', project: 'Remplacement chaudière', amount: 5120, sent: day(-15), next: day(0), status: 'won', notes: 'Exemple fictif. Signature déclarée ; paiement non vérifié.' }),
    demo({ client: 'Cabinet des Cèdres', project: 'Climatisation du cabinet', amount: 2890, sent: day(-8), next: day(2), status: 'sent', notes: 'Exemple fictif.' }),
    demo({ client: 'Studio des Vignes', project: 'Installation monosplit', amount: 1850, sent: day(-20), next: day(0), status: 'lost', notes: 'Exemple fictif. Projet reporté.' }),
  ];
}
const demoState = () => ({ settings: { company: 'Atelier Confort', signature: 'Votre artisan', stripe: '' }, quotes: seedQuotes() });

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
    const err = Object.assign(new Error(data?.error || 'Erreur serveur.'), { status: r.status });
    if (r.status === 401 && mode === 'live') {
      session = null; mode = 'landing';
      showAuth('Votre session a expiré. Reconnectez-vous.');
    }
    throw err;
  }
  return data;
}

/* Recharge les données serveur (live uniquement) */
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
  window.scrollTo(0, 0);
}
function openDemo() {
  mode = 'demo';
  state = demoState();
  show('app');
  render();
}
async function enterLive() {
  try { await refresh(); } catch (e) { return toast(e.message, 'error'); }
  show('app');
  render();
  maybeMigrate();
}
$$('[data-open]').forEach(b => b.onclick = () => mode === 'live' ? enterLive() : openDemo());
$$('[data-demo]').forEach(b => b.onclick = openDemo);
$$('[data-auth]').forEach(b => b.onclick = () => showAuth());
$$('[data-landing]').forEach(b => b.onclick = () => show('landing'));
$('#back').onclick = () => { if (mode === 'demo') state = emptyState(); show('landing'); };
$('#back-m').onclick = () => { if (mode === 'demo') state = emptyState(); show('landing'); };
$('#brand-home').onclick = e => { e.preventDefault(); $('#back').click(); };
$('#auth-home').onclick = e => { e.preventDefault(); show('landing'); };
$('#session-btn').onclick = async () => {
  if (mode === 'demo') { state = emptyState(); mode = 'landing'; show('landing'); return; }
  try { await api('/auth/sign-out', { method: 'POST', body: {} }); } catch { /* session déjà close */ }
  session = null; mode = 'landing'; state = emptyState();
  show('landing');
  toast('Vous êtes déconnecté.', 'info');
};
$('#logout').onclick = () => $('#session-btn').click();

const tabNames = { pipeline: "Vue d'ensemble", followups: 'Relances à préparer', settings: 'Offre & réglages' };
function tab(id) {
  $$('.tab').forEach(el => { el.hidden = el.id !== id; });
  $$('.nav-item[data-tab], .mobile-item[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  $('#breadcrumb').textContent = tabNames[id];
  render();
  window.scrollTo(0, 0);
}
/* data-tab géré par délégation (éléments dynamiques inclus) — voir listener global. */

/* ---------- Authentification ---------- */
function showAuth(msg) {
  show('auth');
  $('#login-form').hidden = false;
  if (msg) toast(msg, 'info');
}
$('#tab-login').onclick = () => {
  $('#tab-login').classList.add('active'); $('#tab-signup').classList.remove('active');
  $('#login-form').hidden = false; $('#signup-form').hidden = true;
};
$('#tab-signup').onclick = () => {
  $('#tab-signup').classList.add('active'); $('#tab-login').classList.remove('active');
  $('#signup-form').hidden = false; $('#login-form').hidden = true;
};

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
  try {
    await api('/auth/sign-in/email', { method: 'POST', body: { email: f.elements.email.value.trim(), password: f.elements.password.value } });
    f.reset();
    await afterAuth();
  } catch (err2) {
    err.hidden = false;
    err.textContent = err2.status === 401 ? 'Email ou mot de passe incorrect.' : (err2.message || 'Connexion impossible.');
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
  };
  if (payload.password.length < 10) { err.hidden = false; err.textContent = 'Mot de passe : 10 caractères minimum.'; unbusy(); return; }
  try {
    await api('/auth/sign-up/email', { method: 'POST', body: payload });
    const me = await api('/me');
    session = me;
    const c = await api('/companies', { method: 'POST', body: { name: f.elements.company.value.trim() } });
    session.company = c;
    f.reset();
    mode = 'live';
    await enterLive();
    toast('Espace créé. Bienvenue !');
  } catch (err2) {
    err.hidden = false;
    err.textContent = err2.status === 422 ? 'Cet email est déjà utilisé.' : (err2.message || 'Inscription impossible.');
  } finally { unbusy(); }
};

$('#company-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, unbusy = busy($('#company-btn')), err = $('#err-company-name');
  err.hidden = true;
  try {
    const c = await api('/companies', { method: 'POST', body: { name: f.elements.name.value.trim() } });
    session.company = c;
    mode = 'live';
    await enterLive();
  } catch (err2) { err.hidden = false; err.textContent = err2.message; }
  finally { unbusy(); }
};

/* ---------- Rendu ---------- */
const hasSeed = () => state.quotes.some(q => q.seed);
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

/* Devis locaux (ancien localStorage) importables — exemples exclus. */
function localQuotes() {
  try {
    const x = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (!x?.quotes) return [];
    // Les exemples (flag seed ou note « Exemple fictif » de l'ancien format) sont exclus.
    return x.quotes.filter(q => !q.seed && !/exemple fictif/i.test(q.notes || '')
      && q.client && q.project && Number.isFinite(q.amount) && isDate(q.sent) && isDate(q.next) && labels[q.status]);
  } catch { return []; }
}

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
  const notice = $('#notice'), label = $('#data-label'), text = $('#notice-text'), act = $('#notice-action');
  const localCount = mode === 'live' ? localQuotes().length : 0;
  notice.classList.toggle('local', mode !== 'demo' && !hasSeed());
  if (mode === 'demo') {
    label.textContent = 'Mode démo · données fictives';
    text.textContent = 'Exploration libre : rien n’est enregistré ni envoyé au serveur.';
    act.textContent = 'Se connecter';
    act.onclick = () => showAuth();
  } else if (localCount && !localStorage.getItem(MIG_DISMISS)) {
    label.textContent = 'Migration disponible';
    text.textContent = `${localCount} devis conservés sur cet appareil peuvent rejoindre votre espace serveur.`;
    act.textContent = 'Importer mes devis locaux';
    act.onclick = () => openMigrate(localCount);
  } else {
    label.textContent = `Connecté · ${state.settings.company}`;
    text.textContent = 'Données sauvegardées côté serveur, isolées par entreprise.';
    act.hidden = true;
    act.textContent = '';
  }
  if (!(mode === 'demo') && !(localCount && !localStorage.getItem(MIG_DISMISS))) act.hidden = true;
  else act.hidden = false;

  /* Éléments démo vs live */
  $('#storage-note').innerHTML = mode === 'demo'
    ? `${icon('i-info')}Mode démo : données fictives en mémoire, rien n'est envoyé au serveur.`
    : `${icon('i-info')}Données serveur · session sécurisée, isolée par entreprise.`;
  $('#logout').hidden = mode !== 'live';
  $('#session-btn').hidden = false;
  $('#session-btn').textContent = mode === 'demo' ? 'Quitter la démo' : 'Se déconnecter';
  $('#remove-seed').closest('.form-panel').hidden = mode === 'live';
  $('#reset').hidden = $('#clear').hidden = $('#remove-seed').hidden = mode === 'live';

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
    f.elements.signature.value = state.settings.signature;
    f.elements.stripe.value = state.settings.stripe;
  }
  $('#ws-name').textContent = state.settings.company;
  $('#ws-avatar').textContent = $('#top-avatar').textContent = initials(state.settings.company);
  $('#buy').textContent = state.settings.stripe ? 'Accéder au paiement Stripe' : 'Vérifier la disponibilité de l\'offre';
  $('#payment-note').textContent = state.settings.stripe
    ? 'Paiement hébergé par Stripe · vérifiez le récapitulatif'
    : 'Paiement non configuré · aucun prélèvement';
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
      <td><strong>${esc(q.client)}</strong><span class="cell-sub">${esc(q.project)}${q.seed ? ' · exemple' : ''}</span></td>
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
        <div><strong>${esc(q.client)}</strong><small>${esc(q.project)}${q.seed ? ' · exemple' : ''}</small></div>
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
  if (edit) editQuote(edit.dataset.edit);
  if (compose) composeQuote(compose.dataset.compose);
  if (close) close.closest('dialog')?.close();
  if (tabBtn) tab(tabBtn.dataset.tab);
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
    if (mode === 'demo') {
      o.id = old?.id || crypto.randomUUID();
      o.history = old?.history || [];
      o.seed = old?.seed || false;
      if (old) state.quotes = state.quotes.map(q => q.id === o.id ? o : q);
      else state.quotes.unshift(o);
    } else {
      const body = { client: o.client, email: o.email, project: o.project, amount: o.amount, sent: o.sent, next: o.next, status: o.status, notes: o.notes };
      if (old) await api(`/quotes/${o.id}`, { method: 'PATCH', body });
      else await api('/quotes', { method: 'POST', body });
      await refresh();
    }
    $('#editor').close();
    render();
    toast(old ? 'Devis mis à jour.' : 'Devis enregistré.');
  } catch (err) {
    toast(err.message || 'Enregistrement impossible.', 'error');
    // La boîte reste ouverte : la saisie est conservée.
  } finally { unbusy(); }
};

$('#delete').onclick = async () => {
  const id = $('#quote-form').elements.id.value;
  const q = state.quotes.find(x => x.id === id);
  if (!q) return;
  if (!await askConfirm('Supprimer ce devis ?', `« ${q.client} — ${q.project} » et son historique seront définitivement supprimés.`, 'Supprimer')) return;
  try {
    if (mode === 'demo') state.quotes = state.quotes.filter(x => x.id !== id);
    else { await api(`/quotes/${id}`, { method: 'DELETE' }); await refresh(); }
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
  $('#message').value = `Bonjour,\n\nJe reviens vers vous concernant notre devis du ${fmtDate(q.sent)} pour votre projet « ${q.project} ».\n\n${middle}\n\nBien cordialement,\n${state.settings.signature}\n${state.settings.company}`;
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
    if (mode === 'demo') {
      q.history = q.history || [];
      q.history.push({ at: new Date().toISOString(), subject: $('#subject').value });
      q.fups = q.history.length;
      q.next = next;
    } else {
      await api(`/quotes/${current}/followups`, {
        method: 'POST',
        body: { subject: $('#subject').value, next, idemKey: composeKey },
      });
      await refresh();
    }
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

  if (mode === 'demo') {
    state.settings = { company: s.company.trim(), signature: s.signature.trim(), stripe };
    render();
    return toast('Paramètres appliqués à la démo (non persistés).', 'info');
  }
  const unbusy = busy(f.querySelector('button[type=submit]'));
  try {
    await api('/settings', { method: 'PATCH', body: { company: s.company.trim(), signature: s.signature.trim(), stripe } });
    await refresh(); render();
    toast('Paramètres enregistrés. Aucun abonnement activé par cette action.');
  } catch (err) {
    setErr(f.elements.stripe, $('#err-stripe'), err.status === 400 && /stripe|lien/i.test(err.message) ? err.message : '');
    toast(err.message, 'error');
  } finally { unbusy(); }
};
$('#settings-form').addEventListener('input', e => {
  const err = $(`#err-${e.target.name}`);
  if (err && !err.hidden) setErr(e.target, err, '');
});
$('#buy').onclick = () => {
  if (state.settings.stripe) window.open(state.settings.stripe, '_blank', 'noopener,noreferrer');
  else { (mode === 'live' ? enterLive : openDemo)(); tab('settings'); toast('Configurez le Payment Link de votre offre dans les réglages.', 'info'); }
};

/* ---------- Exemples (mode démo uniquement) ---------- */
async function removeSeed() {
  const n = state.quotes.filter(q => q.seed).length;
  if (!n) return toast('Aucun exemple à retirer.', 'info');
  if (!await askConfirm('Retirer les exemples ?', `Les ${n} devis fictifs seront supprimés de la démo.`, 'Retirer les exemples')) return;
  state.quotes = state.quotes.filter(q => !q.seed);
  render();
  toast('Exemples retirés.');
}
$('#remove-seed').onclick = removeSeed;

$('#reset').onclick = () => {
  state.quotes.push(...seedQuotes());
  render();
  toast('Exemples ajoutés à la démo.');
};

$('#clear').onclick = async () => {
  if (!await askConfirm('Vider la démo ?', 'Tous les devis fictifs affichés seront retirés.', 'Tout effacer')) return;
  state.quotes = [];
  render();
  toast('Démo vidée.', 'info');
};

/* ---------- Migration localStorage → serveur ---------- */
function maybeMigrate() {
  const items = localQuotes();
  if (!items.length || localStorage.getItem(MIG_DISMISS)) return;
  openMigrate(items.length);
}
function openMigrate(count) {
  const items = localQuotes();
  if (!items.length) return;
  $('#migrate-text').textContent = `${items.length} devis personnels sont enregistrés dans ce navigateur. Ils seront copiés vers l'espace serveur de « ${session?.company?.name ?? 'votre entreprise'} » avec leurs notes et leurs relances déclarées.`;
  $('#migrate-preview').innerHTML = items.slice(0, 6).map(q =>
    `<li><span>${esc(q.client)} — ${esc(q.project)}</span><small>${money(q.amount)} HT</small></li>`).join('')
    + (items.length > 6 ? `<li><span class="subtle">… et ${items.length - 6} autre(s)</span></li>` : '');
  $('#migrate').showModal();
}
$('#migrate-later').onclick = () => $('#migrate').close();
$('#migrate-dismiss').onclick = () => { localStorage.setItem(MIG_DISMISS, '1'); $('#migrate').close(); toast('Import local masqué. Retrouvez-le via « Importer CSV » ou le rechargement des données.', 'info'); };
$('#migrate-go').onclick = async () => {
  const items = localQuotes();
  const unbusy = busy($('#migrate-go'));
  try {
    const payload = items.map(q => ({
      import_key: `local-${q.id}`,
      client: q.client, email: q.email || '', project: q.project, amount: q.amount,
      sent: q.sent, next: q.next, status: q.status, notes: q.notes || '',
      history: Array.isArray(q.history) ? q.history : [],
    }));
    const res = await api('/import', { method: 'POST', body: { quotes: payload } });
    await refresh();
    $('#migrate').close();
    $('#migrate-result-text').textContent =
      `${res.imported} devis importé(s), ${res.skipped} ignoré(s) (déjà présents)` +
      (res.errors?.length ? `, ${res.errors.length} ligne(s) en erreur` : '') +
      '. Votre copie locale est conservée.';
    $('#migrate-delete-local').hidden = !(res.imported + res.skipped === items.length);
    $('#migrate-result').showModal();
    render();
  } catch (err) { toast(err.message, 'error'); }
  finally { unbusy(); }
};
$('#migrate-delete-local').onclick = async () => {
  if (!await askConfirm('Supprimer la copie locale ?', 'Les devis de cet appareil seront effacés du navigateur. La copie serveur est déjà enregistrée.', 'Supprimer la copie locale')) return;
  localStorage.removeItem(LEGACY_KEY);
  $('#migrate-result').close();
  render();
  toast('Copie locale supprimée.', 'info');
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
  if (mode === 'demo') {
    if (!state.quotes.length) return toast('Aucun devis à exporter.', 'info');
    const keys = ['client', 'email', 'project', 'amount', 'sent', 'status', 'next', 'notes'];
    const csv = '\uFEFF' + [keys, ...state.quotes.map(q => keys.map(k => q[k]))].map(r => r.map(csvCell).join(';')).join('\r\n');
    download('devispilot-devis.csv', csv);

    return toast('Export des devis téléchargé. Historique détaillé non inclus.');
  }
  try {
    const r = await fetch(API_BASE + '/api/export.csv', { credentials: 'include' });
    if (r.status === 401) { session = null; mode = 'landing'; showAuth('Votre session a expiré.'); return; }
    if (!r.ok) throw new Error('Export impossible.');
    download('devispilot-devis.csv', await r.text());
    toast('Export des devis téléchargé. Historique détaillé non inclus.');
  } catch (err) { toast(err.message, 'error'); }
};
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
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

    if (mode === 'demo') {
      incoming.forEach(q => state.quotes.unshift({ ...q, id: crypto.randomUUID(), history: [], fups: 0 }));
      render();
      return toast(incoming.length + ' devis importés dans la démo.');
    }
    const res = await api('/import', { method: 'POST', body: { quotes: incoming } });
    await refresh(); render();
    toast(`${res.imported} devis importé(s), ${res.skipped} ignoré(s)` + (res.errors?.length ? `, ${res.errors.length} erreur(s)` : '') + '.');
  } catch (err) { toast(err.message, 'error'); }
};

/* ---------- Démarrage ---------- */
(async function boot() {
  try {
    const c = await api('/config');
    signupEnabled = !!c.signupEnabled;
  } catch { signupEnabled = false; }
  $('#auth-tabs').hidden = !signupEnabled;
  $('#tab-signup').hidden = !signupEnabled;
  $('#auth-note').hidden = signupEnabled;
  try {
    const me = await api('/me');
    if (me?.user) {
      session = me;
      if (me.company) { mode = 'live'; await refresh(); render(); }
      else { show('onboard'); return; }
    }
  } catch { /* pas de session : rester sur la page commerciale */ }
  render();
})();
