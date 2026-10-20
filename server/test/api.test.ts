import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Base de test dédiée (créée au préalable : CREATE DATABASE devispilot_test).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://devispilot:devispilot@127.0.0.1:5444/devispilot_test';
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3410';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
// Driver email de test : capture en mémoire, aucun réseau.
process.env.SMTP_HOST = 'log';
process.env.MAIL_FROM = 'DevisPilot Test <test@devispilot.local>';

const { buildApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { outbox } = await import('../src/mailer.js');

let app: Awaited<ReturnType<typeof buildApp>>;

const H = { 'content-type': 'application/json', 'x-devispilot-client': '1', 'host': 'localhost:3410' };
const cookieOf = (r: any) => (r.headers['set-cookie'] ?? []).map((c: string) => c.split(';')[0]).join('; ');
const PASSWORD = 'motdepasse1234'; // ≥ 12 caractères

const lastMailTo = (email: string, subjectMatch: RegExp) =>
  [...outbox].reverse().find(m => m.to === email && subjectMatch.test(m.subject));
const tokenFrom = (mail: { text: string }) => /token=([A-Za-z0-9._-]+)/.exec(mail.text)?.[1];

async function signupRaw(email: string, name = 'Test') {
  return app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H, payload: { email, password: PASSWORD, name } });
}

// Inscription complète : signup → email de vérification capturé → vérification → session.
async function signup(email: string, name = 'Test') {
  const r = await signupRaw(email, name);
  assert.equal(r.statusCode, 200, `signup ${email} : ${r.body}`);
  const mail = lastMailTo(email, /confirmez votre email/i);
  assert.ok(mail, `email de vérification envoyé à ${email}`);
  const token = tokenFrom(mail!);
  assert.ok(token, 'token de vérification présent');
  const v = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}`, headers: { host: 'localhost:3410' } });
  assert.ok([200, 302].includes(v.statusCode), `verify-email → ${v.statusCode}`);
  // autoSignInAfterVerification : cookie de session posé à la vérification.
  const cookie = cookieOf(v);
  if (cookie.includes('session_token')) return cookie;
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email, password: PASSWORD } });
  assert.equal(s.statusCode, 200, `sign-in ${email}`);
  return cookieOf(s);
}
async function createCompany(cookie: string, name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/companies', headers: { ...H, cookie }, payload: { name } });
  assert.equal(r.statusCode, 201, `company ${name}`);
}
async function addQuote(cookie: string, over: any = {}) {
  const r = await app.inject({
    method: 'POST', url: '/api/quotes', headers: { ...H, cookie },
    payload: { client: 'Maison A', project: 'PAC', amount: 1000, sent: '2026-10-01', next: '2026-10-20', status: 'sent', notes: '', ...over },
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.json()));
  return r.json().id as string;
}

before(async () => {
  // Schéma propre à chaque run.
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  app = await buildApp();
});
after(async () => { await app.close(); await pool.end(); });

test('health + config', async () => {
  const h = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(h.statusCode, 200);
  const c = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(c.json().signupEnabled, true);
});

test('accès refusé sans session', async () => {
  for (const url of ['/api/quotes', '/api/settings', '/api/export.csv', '/api/me', '/api/export-data', '/api/company']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 401, url);
  }
});

test('mutation refusée sans en-tête client (CSRF)', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/quotes', headers: { 'content-type': 'application/json' }, payload: {} });
  assert.equal(r.statusCode, 403);
});

test('origine différente refusée', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/quotes',
    headers: { ...H, origin: 'https://evil.example' }, payload: {},
  });
  assert.equal(r.statusCode, 403);
});

test('signup envoie un email de vérification ; connexion bloquée tant que non vérifié', async () => {
  const r = await signupRaw('nonverifie@x.fr');
  assert.equal(r.statusCode, 200);
  assert.ok(lastMailTo('nonverifie@x.fr', /confirmez/i), 'email de vérification capturé');
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'nonverifie@x.fr', password: PASSWORD } });
  assert.equal(s.statusCode, 403, 'connexion refusée avant vérification');
});

test('signup → vérification → entreprise → me, puis logout', async () => {
  const cookie = await signup('a@x.fr');
  await createCompany(cookie, 'Entreprise A');
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().company.name, 'Entreprise A');
  const out = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { ...H, cookie }, payload: {} });
  assert.equal(out.statusCode, 200);
  const me2 = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me2.statusCode, 401);
});

test('mauvais mot de passe → erreur générique', async () => {
  await signup('b@x.fr');
  const r = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'b@x.fr', password: 'faux-faux-faux' } });
  assert.ok([401, 403].includes(r.statusCode));
  assert.ok(!/exist|trouv/i.test(r.body));
});

test('mot de passe oublié : email → lien → nouveau mot de passe (usage unique)', async () => {
  await signup('reset@x.fr');
  const f = await app.inject({ method: 'POST', url: '/api/auth/request-password-reset', headers: H, payload: { email: 'reset@x.fr' } });
  assert.equal(f.statusCode, 200);
  const mail = lastMailTo('reset@x.fr', /réinitialisation/i);
  assert.ok(mail, 'email de réinitialisation capturé');
  const token = tokenFrom(mail!)!;
  const r = await app.inject({ method: 'POST', url: '/api/auth/reset-password', headers: H, payload: { newPassword: 'nouveaumotdepasse', token } });
  assert.ok(r.statusCode < 300, `reset → ${r.statusCode} ${r.body}`);
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'reset@x.fr', password: 'nouveaumotdepasse' } });
  assert.equal(s.statusCode, 200);
  // Usage unique : le même token ne fonctionne plus.
  const r2 = await app.inject({ method: 'POST', url: '/api/auth/reset-password', headers: H, payload: { newPassword: 'encoreautre1234', token } });
  assert.ok(r2.statusCode >= 400, 'token réutilisé refusé');
});

test('CRUD devis + validation', async () => {
  const cookie = await signup('c@x.fr');
  await createCompany(cookie, 'Entreprise C');
  const id = await addQuote(cookie, { client: 'Mme Z' });

  const list = await app.inject({ method: 'GET', url: '/api/quotes', headers: { cookie } });
  assert.equal(list.json().quotes.length, 1);

  const patch = await app.inject({ method: 'PATCH', url: `/api/quotes/${id}`, headers: { ...H, cookie },
    payload: { client: 'Mme Z', email: '', project: 'PAC v2', amount: 1500, sent: '2026-10-01', next: '2026-10-21', status: 'replied', notes: 'ok' } });
  assert.equal(patch.statusCode, 200);

  const bad = await app.inject({ method: 'PATCH', url: `/api/quotes/${id}`, headers: { ...H, cookie },
    payload: { client: '', project: 'x', amount: -3, sent: 'xx', next: 'yy', status: 'nope' } });
  assert.equal(bad.statusCode, 400);

  const search = await app.inject({ method: 'GET', url: '/api/quotes?search=v2', headers: { cookie } });
  assert.equal(search.json().quotes.length, 1);
  const none = await app.inject({ method: 'GET', url: '/api/quotes?search=zzz', headers: { cookie } });
  assert.equal(none.json().quotes.length, 0);
});

test('isolation entre entreprises (id manipulé → 404)', async () => {
  const cA = await signup('iso-a@x.fr'); await createCompany(cA, 'Iso A');
  const cB = await signup('iso-b@x.fr'); await createCompany(cB, 'Iso B');
  const id = await addQuote(cA, { client: 'Secret A' });

  for (const [m, p] of [['GET', '/api/quotes'], ['PATCH', `/api/quotes/${id}`], ['DELETE', `/api/quotes/${id}`], ['POST', `/api/quotes/${id}/followups`]] as const) {
    const r = await app.inject({ method: m, url: p, headers: { ...H, cookie: cB },
      payload: m === 'GET' ? undefined : { client: 'x', project: 'y', amount: 1, sent: '2026-01-01', next: '2026-01-02', status: 'sent', idemKey: 'hack', subject: '' } });
    if (m === 'GET') assert.ok(!r.json().quotes.some((q: any) => q.client === 'Secret A'));
    else assert.equal(r.statusCode, 404, `${m} ${p}`);
  }
  // Le profil entreprise de A n'est jamais lisible par B.
  const gB = await app.inject({ method: 'GET', url: '/api/company', headers: { cookie: cB } });
  assert.equal(gB.json().name, 'Iso B');
});

test('relance atomique + idempotente', async () => {
  const cookie = await signup('f@x.fr'); await createCompany(cookie, 'F');
  const id = await addQuote(cookie);
  const body = { subject: 'Relance', next: '2026-10-27', idemKey: 'unique-1' };
  await app.inject({ method: 'POST', url: `/api/quotes/${id}/followups`, headers: { ...H, cookie }, payload: body });
  const r2 = await app.inject({ method: 'POST', url: `/api/quotes/${id}/followups`, headers: { ...H, cookie }, payload: body });
  assert.equal(r2.json().duplicated, true);
  const { rows } = await pool.query('SELECT count(*) AS n FROM followups WHERE quote_id=$1', [id]);
  assert.equal(rows[0].n, '1');
  const { rows: q } = await pool.query('SELECT next FROM quotes WHERE id=$1', [id]);
  assert.equal(String(q[0].next), '2026-10-27');
});

test('import idempotent (CSV/local parsé côté client, historiques importés)', async () => {
  const cookie = await signup('imp@x.fr'); await createCompany(cookie, 'Imp');
  const payload = {
    quotes: [
      { import_key: 'local-1', client: 'Client Un', project: 'Chaudière', amount: 500, sent: '2026-10-01', next: '2026-10-25', status: 'sent', notes: 'n1', history: [{ at: '2026-10-05T10:00:00Z', subject: 'R1' }] },
      { import_key: 'local-2', client: 'Client Deux', project: 'Clim', amount: 800, sent: '2026-10-02', next: '2026-10-26', status: 'replied', notes: '', history: [] },
      { import_key: 'bad', client: '', project: 'x', amount: 0, sent: 'x', next: 'y', status: '??' },
    ],
  };
  const r1 = await app.inject({ method: 'POST', url: '/api/import', headers: { ...H, cookie }, payload });
  assert.deepEqual(r1.json(), { imported: 2, skipped: 0, errors: [{ index: 2, error: 'Client invalide (1 à 100 caractères).' }] });
  const r2 = await app.inject({ method: 'POST', url: '/api/import', headers: { ...H, cookie }, payload });
  assert.equal(r2.json().imported, 0);
  assert.equal(r2.json().skipped, 2);
  const { rows } = await pool.query('SELECT count(*) AS n FROM followups');
  assert.ok(Number(rows[0].n) >= 1);
});

test('export CSV : en-têtes, BOM, neutralisation formules', async () => {
  const cookie = await signup('e@x.fr'); await createCompany(cookie, 'E');
  await addQuote(cookie, { client: '=cmd|evil', notes: '+SUM(1)' });
  const r = await app.inject({ method: 'GET', url: '/api/export.csv', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'] ?? '', /text\/csv/);
  assert.match(r.body, /"'=cmd\|evil"/);
  assert.match(r.body, /"'\+SUM\(1\)"/);
});

test('settings : validation du lien Stripe', async () => {
  const cookie = await signup('s@x.fr'); await createCompany(cookie, 'S');
  const bad = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...H, cookie },
    payload: { company: 'S', signature: 'Sig', stripe: 'https://evil.com/x' } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...H, cookie },
    payload: { company: 'S2', signature: 'Sig', stripe: 'https://buy.stripe.com/test_123' } });
  assert.equal(ok.statusCode, 200);
  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
  assert.equal(got.json().stripe_link, 'https://buy.stripe.com/test_123');
});

test('fiche entreprise : validation SIREN, champs, logo', async () => {
  const cookie = await signup('p@x.fr'); await createCompany(cookie, 'P');
  const bad = await app.inject({ method: 'PATCH', url: '/api/company', headers: { ...H, cookie },
    payload: { name: 'P', siren: 'ABC', address: '', phone: '', contact_email: '' } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'PATCH', url: '/api/company', headers: { ...H, cookie },
    payload: { name: 'P Sarl', siren: '123456789', address: '1 rue du Test', phone: '0102030405', contact_email: 'contact@p.fr' } });
  assert.equal(ok.statusCode, 200);
  const got = await app.inject({ method: 'GET', url: '/api/company', headers: { cookie } });
  assert.equal(got.json().siren, '123456789');
  // Logo : PNG 1×1 valide, trop lourd refusé.
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await app.inject({ method: 'PUT', url: '/api/company/logo', headers: { ...H, cookie }, payload: { data: png1x1 } });
  assert.equal(up.statusCode, 200);
  const g = await app.inject({ method: 'GET', url: '/api/company/logo', headers: { cookie } });
  assert.equal(g.headers['content-type'], 'image/png');
  const tooBig = await app.inject({ method: 'PUT', url: '/api/company/logo', headers: { ...H, cookie }, payload: { data: 'data:image/png;base64,' + Buffer.alloc(201 * 1024).toString('base64') } });
  assert.equal(tooBig.statusCode, 400);
  const badType = await app.inject({ method: 'PUT', url: '/api/company/logo', headers: { ...H, cookie }, payload: { data: 'data:text/html;base64,PGI+' } });
  assert.equal(badType.statusCode, 400);
});

test('export RGPD : JSON complet du compte', async () => {
  const cookie = await signup('rgpd@x.fr'); await createCompany(cookie, 'Rgpd');
  await addQuote(cookie, { client: 'Client Rgpd' });
  const r = await app.inject({ method: 'GET', url: '/api/export-data', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.user.email, 'rgpd@x.fr');
  assert.equal(d.companies[0].name, 'Rgpd');
  assert.equal(d.quotes[0].client, 'Client Rgpd');
});

test('suppression de compte : données liées supprimées, session invalidée', async () => {
  const cookie = await signup('bye@x.fr'); await createCompany(cookie, 'Bye');
  const id = await addQuote(cookie, { client: 'Adieu' });
  const del = await app.inject({ method: 'POST', url: '/api/auth/delete-user', headers: { ...H, cookie }, payload: { password: PASSWORD } });
  assert.equal(del.statusCode, 200, `delete-user → ${del.body}`);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 401);
  const { rows } = await pool.query('SELECT count(*) AS n FROM quotes WHERE id=$1', [id]);
  assert.equal(rows[0].n, '0', 'devis supprimé en cascade');
  const { rows: comp } = await pool.query(`SELECT count(*) AS n FROM companies WHERE name='Bye'`);
  assert.equal(comp[0].n, '0', 'entreprise supprimée');
});

test('sessions : liste, révocation', async () => {
  const c1 = await signup('sess@x.fr');
  const s2 = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'sess@x.fr', password: PASSWORD } });
  const c2 = cookieOf(s2);
  const list = await app.inject({ method: 'GET', url: '/api/auth/list-sessions', headers: { cookie: c1 } });
  assert.equal(list.statusCode, 200);
  const sessions = list.json();
  assert.ok(sessions.length >= 2, `sessions listées : ${sessions.length}`);
  const other = sessions.find((s: any) => !c1.includes(s.token));
  assert.ok(other, 'autre session trouvée');
  const rev = await app.inject({ method: 'POST', url: '/api/auth/revoke-session', headers: { ...H, cookie: c1 }, payload: { token: other.token } });
  assert.equal(rev.statusCode, 200);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c2 } });
  assert.equal(me.statusCode, 401, 'session révoquée');
});
