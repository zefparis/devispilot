// Configuration runtime du frontend. Valeur par défaut : même origine que la page
// (mode auto-hébergé / dev local). Sur Vercel, le build réécrit ce fichier avec
// la valeur de VITE_API_URL (ou API_URL) pointant vers https://api.<domaine>,
// plus les variables légales LEGAL_* (mentions, CGV, confidentialité).
window.DP_API_URL = '';
window.DP_LEGAL = { name: '', siren: '', rcs: '', address: '', email: '', vatMention: '', publisher: '' };
window.DP_LEGAL_MISSING = ['LEGAL_NAME', 'LEGAL_SIREN', 'LEGAL_RCS', 'LEGAL_ADDRESS', 'LEGAL_EMAIL', 'LEGAL_VAT_MENTION', 'LEGAL_PUBLISHER'];
