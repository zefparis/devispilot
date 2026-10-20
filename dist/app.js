'use strict';

/* ---------- Utilitaires ---------- */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY = 'devispilot-v1';

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

/* ---------- Données ---------- */
function seedQuotes() {
  const demo = (q) => ({ ...q, id: crypto.randomUUID(), email: '', history: [], seed: true });
  return [
    demo({ client: 'Maison Laurent', project: 'Installation pompe à chaleur', amount: 6480, sent: day(-7), next: day(-1), status: 'sent', notes: 'Exemple fictif. Valider les disponibilités pour une visite.' }),
    demo({ client: 'Résidence des Oliviers', project: 'Climatisation réversible · 3 unités', amount: 4250, sent: day(-10), next: day(0), status: 'replied', notes: 'Exemple fictif. Une question sur le niveau sonore.' }),
    demo({ client: 'Atelier Martin', project: 'Entretien annuel chaudière', amount: 390, sent: day(-3), next: day(4), status: 'sent', notes: 'Exemple fictif.' }),
    demo({ client: 'Maison Vidal', project: 'Remplacement chaudière', amount: 5120, sent: day(-15), next: day(0), status: 'won', notes: 'Exemple fictif. Signature déclarée ; paiement non vérifié.' }),
    demo({ client: 'Cabinet des Cèdres', project: 'Climatisation du cabinet', amount: 2890, sent: day(-8), next: day(2), status: 'sent', notes: 'Exemple fictif.' }),
    demo({ client: 'Studio des Vignes', project: 'Installation monosplit', amount: 1850, sent: day(-20), next: day(0), status: 'lost', notes: 'Exemple fictif. Projet reporté.' }),
  ];
}
const seed = () => ({ settings: { company: 'Atelier Confort', signature: 'Votre artisan', stripe: '' }, quotes: seedQuotes() });

function validLink(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'buy.stripe.com' && !u.username && !u.password;
  } catch { return false; }
}

/* Normalise + migre l'ancien format : les données v1 gagnent le marquage
   `seed` (exemples détectés via la note « Exemple fictif ») et `history`. */
function normalize(x) {
  if (!x || !Array.isArray(x.quotes) || !x.settings) throw Error();
  const legacyDemo = x.demo === true;
  const quotes = x.quotes
    .filter(q => q && typeof q.id === 'string' && typeof q.client === 'string'
      && typeof q.project === 'string' && Number.isFinite(q.amount) && q.amount > 0
      && Object.hasOwn(labels, q.status) && isDate(q.next) && isDate(q.sent))
    .map(q => ({
      id: q.id, client: q.client, email: String(q.email || ''),
      project: q.project, amount: q.amount, sent: q.sent, next: q.next,
      status: q.status, notes: String(q.notes || ''),
      history: Array.isArray(q.history) ? q.history.filter(h => h && typeof h.at === 'string') : [],
      seed: q.seed === true || (legacyDemo && /exemple fictif/i.test(q.notes || '')),
    }));
  return {
    settings: {
      company: String(x.settings.company || 'Mon entreprise').slice(0, 100),
      signature: String(x.settings.signature || 'Votre artisan').slice(0, 100),
      stripe: validLink(x.settings.stripe) ? x.settings.stripe : '',
    },
    quotes,
  };
}

let state;
try {
  const raw = localStorage.getItem(KEY);
  state = raw ? normalize(JSON.parse(raw)) : seed();
} catch { state = seed(); }

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch { toast('Sauvegarde locale indisponible. Exportez vos données avant de fermer.', 'error'); return false; }
}

const hasSeed = () => state.quotes.some(q => q.seed);
const active = q => ['sent', 'replied'].includes(q.status);
const due = () => state.quotes.filter(q => active(q) && q.next <= day(0)).sort((a, b) => a.next.localeCompare(b.next));

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

/* ---------- Navigation ---------- */
function openApp() {
  $('.site-header').hidden = true;
  $('#landing').hidden = true;
  $('#app').hidden = false;
  window.scrollTo(0, 0);
  render();
}
function closeApp() {
  $('.site-header').hidden = false;
  $('#landing').hidden = false;
  $('#app').hidden = true;
  window.scrollTo(0, 0);
}
$$('[data-open]').forEach(b => b.onclick = openApp);
$('#back').onclick = closeApp;
$('#back-m').onclick = closeApp;
$('#brand-home').onclick = e => { e.preventDefault(); closeApp(); };

const tabNames = { pipeline: "Vue d'ensemble", followups: 'Relances à préparer', settings: 'Offre & réglages' };
function tab(id) {
  $$('.tab').forEach(el => { el.hidden = el.id !== id; });
  $$('.nav-item[data-tab], .mobile-item[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  $('#breadcrumb').textContent = tabNames[id];
  render();
  window.scrollTo(0, 0);
}
/* Les data-tab sont gérés par délégation dans le listener global (éléments dynamiques inclus). */

/* ---------- Rendu ---------- */
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'DP';
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

function render() {
  const open = state.quotes.filter(active);
  const won = state.quotes.filter(q => q.status === 'won');
  const queue = due();
  const sends = state.quotes.reduce((n, q) => n + q.history.length, 0);

  $('#today').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();

  /* Indicateurs : rien n'est présenté comme encaissé */
  $('#stats').innerHTML = [
    { icon: 'i-bell', cls: 'highlight', label: 'Relances à préparer', value: queue.length, sub: `${money(queue.reduce((n, q) => n + q.amount, 0))} de devis concernés` },
    { icon: 'i-clock', cls: '', label: 'Devis ouverts', value: money(open.reduce((n, q) => n + q.amount, 0)), sub: `${open.length} devis en attente de réponse` },
    { icon: 'i-check', cls: '', label: 'Devis signés (déclarés)', value: money(won.reduce((n, q) => n + q.amount, 0)), sub: `${won.length} signature(s) · paiement non vérifié` },
    { icon: 'i-info', cls: 'neutral', label: 'Paiements vérifiés', value: '0 €', sub: 'Non suivi dans ce pilote' },
  ].map(s => `<article class="stat ${s.cls}">
      <div class="stat-head">${icon(s.icon)}<p>${s.label}</p></div>
      <strong>${s.value}</strong><small>${s.sub}</small>
    </article>`).join('');

  /* Bandeau données : exemples vs données personnelles */
  const seedN = state.quotes.filter(q => q.seed).length;
  const ownN = state.quotes.length - seedN;
  const notice = $('#notice'), label = $('#data-label'), text = $('#notice-text'), act = $('#notice-action');
  notice.classList.toggle('local', seedN === 0);
  if (seedN && ownN) {
    label.textContent = 'Exemples + vos devis';
    text.textContent = `${seedN} devis fictifs et ${ownN} devis à vous sont mélangés. Vous pouvez retirer les exemples sans perdre vos données.`;
    act.textContent = 'Retirer les exemples';
  } else if (seedN) {
    label.textContent = 'Données de démonstration';
    text.textContent = 'Tout est fictif et stocké uniquement sur cet appareil. Ajoutez votre premier devis quand vous êtes prêt.';
    act.textContent = 'Retirer les exemples';
  } else {
    label.textContent = 'Données locales';
    text.textContent = state.quotes.length
      ? 'Vos devis sont stockés dans ce navigateur uniquement, sans synchronisation.'
      : 'Aucun devis. Ajoutez votre première opportunité ou chargez les exemples.';
    act.textContent = 'Charger les exemples';
  }

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

  /* File de relances */
  $('#queue').innerHTML = queue.length ? queue.map(q => `
    <article class="queue-card">
      <div>
        <p class="eyebrow">${q.next < day(0) ? 'Suivi en retard' : 'À suivre aujourd’hui'}</p>
        <h3>${esc(q.client)}</h3>
        <p class="q-meta">${esc(q.project)} · ${money(q.amount)} HT · devis envoyé le ${fmtDate(q.sent)}</p>
        <p class="q-notes">${icon('i-msg')}${esc(q.notes || 'Aucune note')} · ${q.history.length} relance(s) déclarée(s)</p>
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
  f.elements.company.value = state.settings.company;
  f.elements.signature.value = state.settings.signature;
  f.elements.stripe.value = state.settings.stripe;
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
      <td><span class="${ni.kind === 'late' ? 'due-text' : ni.kind === 'today' ? 'soon-text' : ''}">${ni.text}</span><span class="cell-sub">${ni.sub} · ${q.history.length} relance(s)</span></td>
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
  const o = Object.fromEntries(new FormData(f));
  o.amount = Number(o.amount);
  o.client = o.client.trim(); o.project = o.project.trim(); o.email = o.email.trim(); o.notes = o.notes.trim();
  const old = state.quotes.find(q => q.id === o.id);
  o.id = old?.id || crypto.randomUUID();
  o.history = old?.history || [];
  o.seed = old?.seed || false;
  const firstOwn = !old && hasSeed() && !state.quotes.some(q => !q.seed);
  if (old) state.quotes = state.quotes.map(q => q.id === o.id ? o : q);
  else state.quotes.unshift(o);
  save();
  $('#editor').close();
  render();
  toast(old ? 'Devis mis à jour.' : 'Devis enregistré sur cet appareil.');
  /* Premier devis personnel : proposer de retirer les exemples */
  if (firstOwn) {
    const n = state.quotes.filter(q => q.seed).length;
    if (await askConfirm('Retirer les exemples ?', `Votre devis est enregistré. Voulez-vous retirer les ${n} devis fictifs de démonstration ? Vos données et vos réglages seront conservés.`, 'Retirer les exemples')) {
      state.quotes = state.quotes.filter(q => !q.seed);
      save(); render();
      toast('Exemples retirés. Vos devis sont conservés.');
    }
  }
};

$('#delete').onclick = async () => {
  const id = $('#quote-form').elements.id.value;
  const q = state.quotes.find(x => x.id === id);
  if (!q) return;
  if (!await askConfirm('Supprimer ce devis ?', `« ${q.client} — ${q.project} » et son historique local seront définitivement supprimés de cet appareil.`, 'Supprimer')) return;
  state.quotes = state.quotes.filter(x => x.id !== id);
  save(); $('#editor').close(); render();
  toast('Devis supprimé.', 'info');
};

/* ---------- Composition de relance ---------- */
let current = null;
function composeQuote(id) {
  current = id;
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
$('#done').onclick = () => {
  const q = state.quotes.find(q => q.id === current);
  if (!q) return;
  const next = $('#next-date').value;
  if (!isDate(next)) return toast('Choisissez la date du prochain suivi.', 'error');
  q.history.push({ at: new Date().toISOString(), subject: $('#subject').value });
  q.next = next;
  save(); $('#composer').close(); render();
  toast(`Relance déclarée envoyée. Prochain suivi le ${fmtDate(next)}.`);
};

/* ---------- Réglages ---------- */
$('#settings-form').onsubmit = e => {
  e.preventDefault();
  const f = e.target, s = Object.fromEntries(new FormData(f));
  let ok = true;
  setErr(f.elements.company, $('#err-company'), s.company.trim() ? '' : 'Indiquez le nom de votre entreprise.');
  setErr(f.elements.signature, $('#err-signature'), s.signature.trim() ? '' : 'Indiquez une signature pour vos messages.');
  const stripe = (s.stripe || '').trim();
  setErr(f.elements.stripe, $('#err-stripe'), !stripe || validLink(stripe) ? '' : 'Lien invalide : utilisez une URL https://buy.stripe.com/…');
  if (!f.elements.company.value.trim() || !f.elements.signature.value.trim() || (stripe && !validLink(stripe))) ok = false;
  if (!ok) return;
  state.settings = { company: s.company.trim(), signature: s.signature.trim(), stripe };
  save(); render();
  toast('Paramètres enregistrés. Aucun abonnement activé par cette action.');
};
$('#settings-form').addEventListener('input', e => {
  const err = $(`#err-${e.target.name}`);
  if (err && !err.hidden) setErr(e.target, err, '');
});
$('#buy').onclick = () => {
  if (state.settings.stripe && validLink(state.settings.stripe)) window.open(state.settings.stripe, '_blank', 'noopener,noreferrer');
  else { openApp(); tab('settings'); toast('Configurez le Payment Link de votre offre dans les réglages.', 'info'); }
};

/* ---------- Données : exemples / reset / effacement ---------- */
async function removeSeed() {
  const n = state.quotes.filter(q => q.seed).length;
  if (!n) return toast('Aucun exemple à retirer.', 'info');
  if (!await askConfirm('Retirer les exemples ?', `Les ${n} devis fictifs seront supprimés. Vos propres devis, votre historique et vos réglages sont conservés.`, 'Retirer les exemples')) return;
  state.quotes = state.quotes.filter(q => !q.seed);
  save(); render();
  toast('Exemples retirés.');
}
$('#notice-action').onclick = () => { hasSeed() ? removeSeed() : loadSeed(); };
$('#remove-seed').onclick = removeSeed;

async function loadSeed() {
  if (hasSeed()) return toast('Les exemples sont déjà présents.', 'info');
  if (!await askConfirm('Charger les exemples ?', 'Six devis fictifs seront ajoutés à votre portefeuille, clairement marqués « exemple ». Vos données existantes ne sont pas modifiées.', 'Charger les exemples')) return;
  state.quotes.push(...seedQuotes());
  save(); render();
  toast('Exemples ajoutés.');
}
$('#reset').onclick = loadSeed;

$('#clear').onclick = async () => {
  if (!await askConfirm('Effacer toutes les données ?', 'Tous les devis et réglages de cet appareil seront définitivement supprimés. Exportez un CSV au préalable si besoin.', 'Tout effacer')) return;
  state = { settings: { company: 'Mon entreprise', signature: 'Votre artisan', stripe: '' }, quotes: [] };
  save(); render();
  toast('Espace local vidé. Vous pouvez ajouter vos propres devis.', 'info');
};

/* ---------- CSV ---------- */
function csvCell(x) {
  let s = String(x ?? '');
  if (/^[=+@\-\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
$('#export').onclick = () => {
  if (!state.quotes.length) return toast('Aucun devis à exporter.', 'info');
  const keys = ['client', 'email', 'project', 'amount', 'sent', 'status', 'next', 'notes'];
  const csv = '\uFEFF' + [keys, ...state.quotes.map(q => keys.map(k => q[k]))].map(r => r.map(csvCell).join(';')).join('\r\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'devispilot-devis.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Export des devis téléchargé. Historique détaillé non inclus.');
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
      if (!keys.includes(k)) throw Error('Colonnes requises : client, project, amount, sent, status, next. Exportez la démo pour obtenir le modèle.');
    if (rows.length > 2000) throw Error('Maximum 2 000 lignes par import.');
    const incoming = rows.map((r, i) => {
      const q = Object.fromEntries(keys.map((k, j) => [k, (r[j] || '').trim()]));
      q.amount = Number(q.amount.replace(',', '.'));
      if (!q.client || !q.project || q.client.length > 100 || q.project.length > 200
        || !Number.isFinite(q.amount) || q.amount <= 0 || q.amount > 10000000
        || !Object.hasOwn(labels, q.status)
        || ![q.sent, q.next].every(isDate))
        throw Error('Données invalides à la ligne ' + (i + 2) + '. Aucun devis importé.');
      return { ...q, email: (q.email || '').slice(0, 200), notes: (q.notes || '').slice(0, 2000), id: crypto.randomUUID(), history: [], seed: false };
    });
    if (!await askConfirm('Importer ces devis ?', `${incoming.length} devis seront ajoutés à votre portefeuille${hasSeed() ? ' et remplaceront les exemples' : ''}. Un second import du même fichier créera des doublons.`, 'Importer')) return;
    state.quotes = [...state.quotes.filter(q => !q.seed), ...incoming];
    save(); render();
    toast(incoming.length + ' devis importés.');
  } catch (err) { toast(err.message, 'error'); }
};

render();
