import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from './config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

// Driver « log » : pour dev/tests, capture les emails en mémoire sans réseau.
// Activé via SMTP_HOST=log.
export const outbox: OutgoingMail[] = [];

export type MailDriver = 'smtp' | 'log' | 'none';

export function mailDriver(): MailDriver {
  if (config.smtp.host === 'log') return 'log';
  if (config.smtp.host) return 'smtp';
  return 'none';
}

export const smtpConfigured = () => mailDriver() !== 'none';

let transporter: Transporter | undefined;
function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const driver = mailDriver();
  if (driver === 'none') {
    throw new Error('SMTP non configuré : impossible d\'envoyer des emails.');
  }
  if (driver === 'log') {
    outbox.push(mail);
    console.log(`[mail:log] → ${mail.to} | ${mail.subject}`);
    return;
  }
  await getTransporter().sendMail({ from: config.smtp.from, ...mail });
}

export const EMAIL_TEMPLATES = {
  verify: (url: string): string =>
    `Bonjour,\n\nBienvenue sur DevisPilot. Confirmez votre adresse email en cliquant sur ce lien (valable 24 h) :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette inscription, ignorez ce message.\n\n— L'équipe DevisPilot`,
  resetPassword: (url: string): string =>
    `Bonjour,\n\nVous avez demandé la réinitialisation de votre mot de passe DevisPilot. Cliquez sur ce lien (valable 1 h, usage unique) :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.\n\n— L'équipe DevisPilot`,
  changeEmail: (url: string): string =>
    `Bonjour,\n\nConfirmez votre nouvelle adresse email DevisPilot en cliquant sur ce lien :\n\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\n— L'équipe DevisPilot`,
};
