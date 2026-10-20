// Validation métier côté serveur (le frontend valide aussi, mais ne fait pas foi).

export const STATUSES = ['sent', 'replied', 'won', 'lost'] as const;
export type Status = typeof STATUSES[number];

export interface QuoteInput {
  client: string; email: string; project: string;
  amountCents: number; sent: string; next: string;
  status: Status; notes: string;
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T12:00:00Z').getTime());
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

// Montant reçu en euros (nombre ou chaîne « 1234,56 »), stocké en centimes.
export function toCents(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return Math.round(n * 100);
}

export function validateQuote(body: any): { value?: QuoteInput; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'Corps de requête invalide.' };
  const client = String(body.client ?? '').trim();
  const project = String(body.project ?? '').trim();
  const email = String(body.email ?? '').trim();
  const notes = String(body.notes ?? '').trim();
  if (!client || client.length > 100) return { error: 'Client invalide (1 à 100 caractères).' };
  if (!project || project.length > 200) return { error: 'Projet invalide (1 à 200 caractères).' };
  if (email && (email.length > 200 || !isEmail(email))) return { error: 'Adresse email invalide.' };
  if (notes.length > 2000) return { error: 'Notes trop longues (2000 caractères).' };
  const amountCents = toCents(body.amount);
  if (amountCents === null) return { error: 'Montant HT invalide (0,01 à 10 000 000 €).' };
  if (!isDate(body.sent)) return { error: 'Date d’envoi invalide (AAAA-MM-JJ).' };
  if (!isDate(body.next)) return { error: 'Date de relance invalide (AAAA-MM-JJ).' };
  if (!STATUSES.includes(body.status)) return { error: 'Statut invalide.' };
  return { value: { client, email, project, amountCents, sent: body.sent, next: body.next, status: body.status, notes } };
}

export function validStripeLink(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'buy.stripe.com' && !u.username && !u.password;
  } catch { return false; }
}

// Neutralisation des formules de tableur à l'export CSV.
export function csvCell(x: unknown): string {
  let s = String(x ?? '');
  if (/^[=+@\-\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
