# OUTLOOK_TEST_RESULTS — Test E2E OAuth Outlook donna-api

**Date début** : 2026-05-05
**Branche** : `test/outlook-oauth-e2e`
**Objectif** : valider de bout en bout l'OAuth Outlook + ingestion mails + extraction events V1 + affichage calendrier
**Périmètre figé** : voir 5 points règles (branche dédiée, backup .env, fix limités à AZURE_*, zéro fix v1/calendar sans go)

---

## Section 1 — État initial du code (avant test)

### 1.1 Routes Express Outlook (lues dans `src/routes/import.ts`)

- `GET /api/import/outlook/auth` (ligne 399) → renvoie `{auth_url}` pour démarrer le flow OAuth
- `GET /api/import/outlook/callback` (ligne 410) → reçoit `code` MSAL, l'échange contre `refresh_token`, stocke en DB, déclenche `importFromProvider`

### 1.2 Provider Outlook (lu dans `src/services/mail/outlook-provider.ts`)

- Stack : `@azure/msal-node` (ConfidentialClientApplication) + `@microsoft/microsoft-graph-client` (lazy import)
- Scopes demandés : `https://graph.microsoft.com/Mail.Read` + `offline_access`
- Auth flow : `getAuthCodeUrl` → user consent → `acquireTokenByCode` → stocke `refreshToken` en DB
- Refresh : `acquireTokenByRefreshToken` avec buffer 60s avant expiration
- Lecture mails : Microsoft Graph endpoint `/me/mailFolders/inbox/messages` avec filtre `receivedDateTime ge {ISO}`
- Lecture pièces jointes : `/me/messages/{id}/attachments` avec `select=id,name,contentType,size`
- Erreurs 401 / `InvalidAuthenticationToken` / `AADSTS70008` etc. → `TokenInvalidError`

### 1.3 App Registration Azure AD actuelle (état pré-test)

| Variable | Valeur |
|---|---|
| `AZURE_CLIENT_ID` | `8ede183f-6a8e-409a-9894-19cbdce2d7c4` |
| `AZURE_TENANT_ID` | `f5a3e724-7f36-4301-8df6-19f5f0fead39` |
| `AZURE_CLIENT_SECRET` | `[REDACTED — voir .env VPS]` |
| `AZURE_REDIRECT_URI` | `https://api.donna-legal.com/api/import/outlook/callback` |

**Note** : les valeurs sont présentes dans `/var/www/donna-api/.env` sur le VPS. Le tenant `f5a3e724-...` correspond probablement à un précédent essai de Yoel — à comparer avec le nouveau tenant dev une fois créé.

### 1.4 Pipeline V1 Outlook

- `src/v1/calendar/services/ingester.outlook.ts` existe et est parallèle à `ingester.gmail.ts`
- Périmètre interdit (règle 8) : zéro modification sans go explicite, même si bug détecté

---

## Section 2 — Création tenant M365 dev

**Statut** : EN ATTENTE — Yoel doit créer le tenant lui-même (règle Anthropic prohibition création comptes).

**À documenter une fois créé** :
- Domaine : `xxxxxxx.onmicrosoft.com`
- Admin login : `xxxxx@xxxxxxx.onmicrosoft.com`
- Tenant ID Azure : `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- Boîte de test : `avocat.test@xxxxxxx.onmicrosoft.com`

**Comparaison tenant ID actuel vs nouveau** :
- Actuel `.env` VPS : `f5a3e724-7f36-4301-8df6-19f5f0fead39`
- Nouveau dev : `[à remplir]`
- Conclusion : `[à remplir]`

---

## Section 3 — Nouvelle App Registration Azure AD

(à rédiger une fois tenant créé)

---

## Section 4 — Génération 20 mails fictifs avocat

(à rédiger après création boîte de test)

**Prévu** :
- Voie 1 (priorité) : SMTP M365 + App Password si tenant le permet
- Voie 2 (fallback) : Microsoft Graph `POST /me/sendMail` (besoin scope `Mail.Send` + admin consent dans le tenant test)

**Contenu prévu** : 20 emails réalistes d'avocat avec dates procédurales cachées dans le corps :
- Délai d'appel (1 mois après signification)
- Conclusions à signifier (date X)
- Prescription (date Y)
- Audience (date + heure + tribunal)
- Dépôt de pièces (J-3 audience)
- Closing commercial (date)
- Échéances diverses

---

## Section 5 — OAuth Outlook end-to-end

(à rédiger lors de l'exécution)

---

## Section 6 — Vérifications DB

(à rédiger lors de l'exécution)

- Présence `outlook_refresh_token` dans `configurations` row du user
- Lignes ajoutées à `messages_v1` (provider = 'outlook')
- Pièces jointes éventuelles dans `attachments_v1`
- Events extraits dans `events_v1`
- Affichage calendrier `/lab/calendar` filtré sur le user test

---

## Section 7 — Bugs trouvés / Fixes proposés

(à remplir au fur et à mesure)

| # | Lieu | Description | Reproduction | Cause racine | Fix proposé | Validé Yoel ? |
|---|---|---|---|---|---|---|

---

## Section 8 — Synthèse finale

(à rédiger en fin de test)
