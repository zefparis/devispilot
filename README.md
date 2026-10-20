# DevisPilot
Private validation prototype. Buildless HTML/CSS/JavaScript; no dependencies. All records and configuration persist in browser localStorage only. No server database, tenant accounts, AI API, mail sending, scheduling, or Stripe webhook. This is not a production subscription platform.

## What works
Quote create/edit/delete; status updates; due follow-up queue; editable deterministic French message templates; copy and mailto; explicit manual follow-up confirmation; CSV import/export; local settings; Stripe-hosted Payment Link navigation after configuring a valid buy.stripe.com URL. CSV export neutralizes spreadsheet formula prefixes. Imported text is HTML escaped.

## Commercial hypothesis
Initial vertical: small heating/air-conditioning installers. Done-with-you onboarding €290 HT plus €79 HT/month proposed. Start with a manually operated service and interviews; no unsupported revenue/ROI claims. Competition includes Relance+, so willingness to pay for implementation and support must be validated.

## Before launch
Validate 3 paid pilots out of 20 targeted conversations; measure actual support cost and conversion. Add server-side per-company isolation, identity and authorization, durable backups/export/delete, Stripe Checkout subscription verification and signed idempotent webhooks, billing portal, legal terms, privacy, tax configuration. Never trust a return URL or local setting as proof of payment. Email automation requires separately configured delivery and opt-out handling. Do not put Stripe secret keys in this static app.

## CSV
Export a sample to obtain headers: client;email;project;amount;sent;status;next;notes. Dates YYYY-MM-DD, statuses sent/replied/won/lost. Export does not preserve detailed follow-up history. Browser/device changes do not synchronize data.
