# GMAIL_E2E_RESULTS — Test E2E onboarding Gmail alexandra@

**Date début** : 2026-05-05 23h00 Paris
**Branche** : `test/gmail-e2e-validation`
**User** : `alexandra@demo.donna-legal.com` (user_id `378cf355-8faa-4b90-add0-6dd3a6db1518`)
**Objectif** : valider de bout en bout l'onboarding Gmail from scratch après reset DB complet

**Périmètre figé** :
- Branche dédiée OK (règle 1)
- DELETE rows uniquement, pas de DROP TABLE, backup créé avant DELETE (règle 5)
- Pas de modif `.env` prod (règle 8)
- Pas de touch code `v1/calendar/` (règle 8)

---

## Section 1 — Backup pré-reset

| Table | Rows backup | Localisation |
|---|---:|---|
| configurations | 1 | `/var/www/alpha/backups/alexandra-backup-2026-05-05-21h.json` (VPS) + local |
| emails | 103 | idem |
| dossiers | 5 | idem |
| dossier_documents | 15 | idem |
| briefs | 5 | idem |
| messages_v1 | 119 | idem |
| attachments_v1 | 45 | idem |
| events_v1 | 55 | idem |

**Taille backup** : 475 KB (JSON unique, doublé sur VPS host + local Mac).
**Script backup** : `donna-api/scripts/alexandra-backup-and-reset.js` (mode `--dry-run` puis `--apply`).

**Restauration possible** : oui, via re-import JSON dans Supabase (script de restore non écrit, à faire si besoin).

---

## Section 2 — Reset DB

(à remplir)

---

## Section 3 — Onboarding Gmail E2E

### 3.1 Setup pré-onboarding
- Cookies Chrome alexandra@ : à conserver ou pas ?
- État OAuth Google côté alexandra : grant existant à révoquer ou pas ?

### 3.2 Mesures timing

| Étape | T (ms) | Note |
|---|---:|---|
| T0 — Click "Connecter Gmail" | | |
| T1 — Consent screen affiché | | |
| T2 — Click "Continuer" / Allow | | |
| T3 — Redirect callback /api/import/callback | | |
| T4 — Backend reçoit auth code | | |
| T5 — Refresh token stocké | | |
| T6 — Premier mail ingéré messages_v1 | | |
| T7 — Premier event_v1 extrait | | |
| T8 — Calendar `/lab/calendar` affiche les 5 dates | | |

**Total T0 → T8** : (objectif < 60s)

### 3.3 Logs container clés

(captures à inclure)

---

## Section 4 — Vérifications post-onboarding

### 4.1 Pipeline V1 propre
- [ ] `messages_v1` rempli avec tous mails 60j alexandra@
- [ ] `attachments_v1` cohérent (PJ avec `text_extracted` ou `corrupt`)
- [ ] `events_v1` extrait (objectif : 5 events critiques identifiés)
- [ ] `configurations.refresh_token` non null + scope readonly

### 4.2 Calendrier `/lab/calendar`
- [ ] 5 dates affichées correctement
- [ ] Click event ouvre modal "Donna t'explique" avec source mail
- [ ] Lien "Voir l'email d'origine" pointe sur bon thread Gmail
- [ ] Bandeau "À venir cette semaine" en haut
- [ ] Wizard onboarding joué une seule fois (flag localStorage)

### 4.3 Sidebar
- [ ] Email user affiché en header
- [ ] 5 dossiers avec couleurs pastel
- [ ] Pas de badge "new emails"

---

## Section 5 — Bugs rencontrés

| # | Lieu | Description | Reproduction | Cause racine | Fix proposé | Validé Yoel ? |
|---|---|---|---|---|---|---|

(remplir au fur et à mesure ; pour tout bug code v1/calendar : zéro fix sans go)

---

## Section 6 — Synthèse finale

(à remplir en fin de test)
