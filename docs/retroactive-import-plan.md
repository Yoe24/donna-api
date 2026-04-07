# Plan technique — Time-to-value : import 60 jours + dossiers pré-organisés

> **Objectif produit (mots de Yoel)** : maximiser le moment "wow" du premier login.
> Quand l'avocate connecte sa boîte mail, Donna doit avoir déjà :
> - extrait les 60 derniers jours d'emails
> - regroupé tous les emails de chaque contact dans un dossier
> - téléchargé et résumé toutes les pièces jointes
> - extrait les dates importantes (échéances) par dossier
> - généré un résumé global du dossier
> - préparé une to-do list (1 tâche par dossier actif)
>
> Et tout ça doit se mettre à jour en temps réel quand un nouveau mail arrive.
> Multi-providers : **Gmail** (existant) + **Outlook** (à ajouter) puis IMAP générique plus tard.

---

## 1. État actuel — ce qui existe DÉJÀ (et qu'on garde)

### Backend `donna-api`

| Module | Fichier | État | Note |
|---|---|---|---|
| Route OAuth Gmail + callback | `src/routes/import.ts` | ✅ existe | Déjà 60 jours par défaut. Crée user Supabase auto. Lance import en background. |
| Agent importer | `src/services/agents/agent-importer.ts` (488 l) | ✅ existe | List 2000 max, group by sender (≥3 emails = dossier), insert emails + télécharger PJ + upload Storage + extraire texte. **Lean import** : pipeline IA seulement sur les emails < 24h. |
| AI processor (8 étapes) | `src/services/ai-processor.ts` (289 l) | ✅ existe | filter → archive → context → drafter → résumé → save → enrich classification (urgency, key_dates, opposing_party, case_reference) |
| Dossier merger intelligent | `src/services/dossier-merger.ts` (297 l) | ✅ existe | GPT-4o regroupe les dossiers fragmentés (même affaire, même partie adverse, gestion cabinet, etc) |
| Attachment processor | `src/services/attachment-processor.ts` (210 l) | ✅ existe | PDF + Word → Supabase Storage + résumé GPT-4o-mini per file |
| Brief generator | `src/services/brief-generator.ts` (407 l) | ✅ existe | Compte-rendu factuel par dossier avec dates_cles + needs_immediate_attention |
| Gmail polling continu | `src/services/gmail-poller.ts` (358 l) | ⚠️ broken | Polling 30s OK mais ne gère PAS l'erreur `invalid_grant` correctement → produit OFFLINE pour les users actuels |
| Briefing cron + post-onboarding email | `src/services/briefing-cron.ts` + `email-sender.ts` | ✅ existe | |

### Schéma DB actuel (vérifié via Supabase REST)

```
configurations
  id, user_id, formule_appel, formule_politesse, niveau_concision, ton_reponse,
  nom_avocat, nom_cabinet, specialite, signature, email_exemples, sources_favorites,
  refresh_token, gmail_last_check, profil_style, updated_at

dossiers
  id, user_id, nom_client, email_client, statut, resume_situation, domaine,
  dernier_echange_date, dernier_echange_par, opposing_party, case_reference,
  email_count, metadata (jsonb), created_at

emails
  id, user_id, expediteur, objet, resume, brouillon, pipeline_step, contexte_choisi,
  statut, dossier_id, metadata (jsonb), urgency, needs_response, classification (jsonb),
  is_processed, created_at, updated_at

dossier_documents
  id, dossier_id, email_id, nom_fichier, type, contenu_extrait, date_reception,
  storage_url, resume_ia, created_at

briefs
  id, user_id, brief_date, content (jsonb), is_read, created_at
```

### Frontend `donna-s-insight-hub`

| Module | Fichier | État |
|---|---|---|
| DossierDetail page | `src/pages/DossierDetail.tsx` (631 l) | ⚠️ partiel — affiche les emails et documents mais probablement pas Échéances ni Résumé regenerated |
| Onboarding screen | `src/pages/Onboarding.tsx` | ✅ existe — gère le `?import=started` |
| Dashboard authed | `src/pages/DashboardV6.tsx` | ✅ existe |

---

## 2. Gaps identifiés — ce qui empêche la vision de Yoel

### 🔴 GAP 1 — `invalid_grant` non géré, produit offline pour les users existants

**Symptôme** : Les logs Docker montrent 60 erreurs `invalid_grant` toutes les 30 min. **0 nouveau email traité depuis sans doute des jours.**

**Cause** : `gmail-poller.ts` lignes 175-200 attrape `getAccessToken()` mais ne gère que les 401. Google renvoie 400 + `invalid_grant` pour un refresh token expiré. L'erreur tombe dans le catch externe qui ne fait que logger. **Le `refresh_token` reste valide en DB**, donc le polling retry indéfiniment.

**Fix** :
1. Détecter `err.message.includes('invalid_grant')` dans le catch externe
2. `UPDATE configurations SET refresh_token = NULL, gmail_needs_reconnect = TRUE WHERE user_id = ...`
3. Frontend lit `gmail_needs_reconnect` → bannière rouge en haut du dashboard avec bouton "Reconnecter Gmail"
4. **Étape Cowork prompt 1 (Google publish en Production) lèvera l'expiration 7 jours pour les nouveaux users**, mais les 2 users actuels devront quand même se reconnecter une fois.

### 🔴 GAP 2 — Échéances pas agrégées au niveau dossier

**Yoel veut** : "Pour M. Dupont, voir les 2 dates importantes extraites de ses 30 mails dans le bloc Échéances."

**Actuel** : `email.classification.key_dates` (jsonb array) est rempli par l'enrich step de l'AI processor pour CHAQUE email individuellement. Mais il n'y a **aucune agrégation au niveau dossier**. Le frontend devrait scanner tous les emails du dossier et faire l'union — c'est lent et pas cacheable.

**Fix** :
1. Ajouter colonne `dossiers.echeances` (jsonb array)
2. Créer service `services/dossier-enricher.ts` avec :
   - `aggregateEcheances(dossierId)` → SELECT classification->'key_dates' FROM emails WHERE dossier_id = ... → union, dedup, tri par date, save dans dossiers.echeances
3. Appeler après chaque traitement IA d'email + après mergeDossiers à la fin de l'import

### 🔴 GAP 3 — Résumé du dossier pas régénéré sur nouveau mail

**Yoel veut** : "Que ça se mette à jour à chaque fois qu'un mail arrive."

**Actuel** : `dossier.resume_situation` est set 1 seule fois pendant `mergeDossiers()` à la fin de l'import. Quand un nouveau mail arrive via le poller → processEmailWithAI → archiveEmail (juste update `dernier_echange_date`), le résumé du dossier reste figé.

**Fix** :
1. Ajouter colonne `dossiers.last_summary_update` (timestamptz)
2. `dossier-enricher.ts` → `regenerateDossierSummary(dossierId)` :
   - Récupère tous les emails du dossier (limité aux 50 plus récents pour borner les coûts)
   - Récupère les `resume_ia` des PJ
   - Appel GPT-4o avec un prompt qui synthétise la situation actuelle de l'affaire
   - UPDATE dossiers SET resume_situation = ..., last_summary_update = NOW()
3. Appeler après chaque processEmailWithAI **si** plus de 5 minutes depuis le dernier update (debounce pour pas spammer GPT en cas de rafale d'emails)

### 🟠 GAP 4 — Résumé des PJ pas agrégé

**Yoel veut** : "Si on doit faire un résumé, on prend en compte toutes ces informations, on crée un résumé pour le dossier."

**Actuel** : Chaque PJ a son propre `resume_ia` (1-2 phrases factuelles). Pas de synthèse "voici ce que disent l'ensemble des PJ de M. Dupont".

**Fix** : Inclus dans GAP 3 — quand on régénère `dossier.resume_situation`, on injecte aussi les `resume_ia` des PJ dans le prompt GPT pour qu'il les considère.

### 🔴 GAP 5 — Pas de provider abstraction → Outlook impossible

**Actuel** : Tout est hardcodé `google.gmail`. Aucune interface MailProvider. Impossible d'ajouter Outlook proprement sans dupliquer 1000 lignes.

**Fix** :
1. Créer `src/services/mail/types.ts` avec interface `MailProvider`
2. Créer `src/services/mail/gmail-provider.ts` qui wrap le code existant
3. Créer `src/services/mail/outlook-provider.ts` via `@microsoft/microsoft-graph-client`
4. Refactor `agent-importer.ts` pour prendre un `provider: MailProvider` en argument
5. Refactor `gmail-poller.ts` pour itérer sur les users avec leur provider correspondant
6. Routes `/api/import/outlook/auth` et `/api/import/outlook/callback`
7. **Bloqué sur les credentials Azure** (Cowork prompt 2 en cours)

### 🟡 GAP 6 — Style detection cassée

**Actuel** : `agent-importer.ts:225` détecte les emails envoyés via `from.toLowerCase().includes(uid.substring(0, 8)) || to === 'me'`. Le test `uid.substring(0,8)` est totalement invalide (compare un UUID Supabase au from de l'email). `to === 'me'` n'est jamais vrai (c'est la convention Gmail API mais le header `to` contient l'email réel).

**Fix** :
1. Lister les messages avec `q: 'in:sent after:...'` séparément
2. Ou utiliser `labelIds: ['SENT']` pour filtrer

### 🟠 GAP 7 — Lean import = pipeline IA seulement sur < 24h

**Actuel** : `agent-importer.ts:437-470` ne lance le pipeline IA (filter → archive → résumé → brouillon → enrich) que sur les emails créés dans les dernières 24h. Les autres sont marqués `pipeline_step: 'imported'` et restent inanalysés.

**Conséquence** : Quand l'avocate connecte sa boîte avec 60 jours d'historique (1000+ emails), seuls les < 24h auront un résumé, un brouillon, des dates extraites, etc. **Le moment dopamine est cassé pour les emails de J-2 à J-60.**

**Fix** :
1. Étendre le pipeline IA à TOUS les emails importés
2. Optimiser les coûts :
   - Batcher les appels GPT (5-10 emails par requête quand possible)
   - Skipper la génération de brouillon pour les emails > 24h (pas besoin de répondre à un email d'il y a 30 jours)
   - Garder seulement : filter, archive, résumé court, enrich classification (key_dates surtout)
3. Estimer le coût : ~$0.001 par email × 1000 = ~$1 par avocate connectée. Acceptable.

### 🟠 GAP 8 — Frontend DossierDetail probablement incomplet

**À vérifier** (j'ai vu la structure mais pas la partie rendering JSX) :
- Affiche-t-il une section Échéances ? Probablement non puisque le champ `dossiers.echeances` n'existait pas.
- Affiche-t-il le `resume_situation` ?
- Comment sont affichés les `dossier_documents` ?

**Fix** : Refactor minimal de `DossierDetail.tsx` pour ajouter les 4 blocs explicites :
- **Résumé** (top of page) : `dossier.resume_situation`
- **Échéances** : timeline visuelle de `dossier.echeances`
- **Échanges** : liste chronologique inversée des emails (déjà là)
- **Pièces jointes** : grid des documents avec preview du `resume_ia` (déjà là partiellement)

### 🔴 GAP 9 — Multi-tenant isolation pas testée

**Risque** : Aucun test E2E vérifiant que `user A` ne peut pas accéder aux dossiers de `user B`. Sur les 9 routes API, l'audit Donna mentionnait 6 failles déjà corrigées (`req.query.user_id → req.user.id`). Mais aucun test pour empêcher la régression.

**Fix** :
1. Ajouter une suite de tests Jest qui :
   - Crée 2 users + 2 dossiers
   - Tente d'accéder au dossier de l'autre user → doit retourner 403
   - Idem pour emails, documents, briefs

---

## 3. Architecture cible

### 3.1 Migrations DB

```sql
-- Stabilisation
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS gmail_needs_reconnect boolean DEFAULT false;

-- Multi-provider
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS provider text DEFAULT 'gmail' CHECK (provider IN ('gmail', 'outlook'));
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS outlook_refresh_token text;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS outlook_last_check timestamptz;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS outlook_needs_reconnect boolean DEFAULT false;

-- Enrichissement dossier
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS echeances jsonb DEFAULT '[]';
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS resume_pj text;
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS last_summary_update timestamptz;

-- Index pour performance
CREATE INDEX IF NOT EXISTS idx_emails_dossier_created ON emails(dossier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dossiers_user_statut ON dossiers(user_id, statut);
```

### 3.2 Provider abstraction

```ts
// src/services/mail/types.ts
export interface RawMessage {
  id: string;
  threadId: string;
  internalDate: Date;
}

export interface FullMessage {
  id: string;
  threadId: string;
  from: string;       // "Name <email@host>"
  fromEmail: string;  // "email@host" (lowercase)
  to: string;
  subject: string;
  date: Date;
  body: string;
  attachments: AttachmentMeta[];
  isSent: boolean;
}

export interface AttachmentMeta {
  id: string;       // provider-specific attachment ID
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailProvider {
  readonly name: 'gmail' | 'outlook';
  listMessagesSince(after: Date, max: number): AsyncIterable<RawMessage>;
  listSentMessages(after: Date, max: number): AsyncIterable<RawMessage>;
  getFullMessage(id: string): Promise<FullMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

export class TokenInvalidError extends Error {
  constructor(public provider: 'gmail' | 'outlook', public userId: string) {
    super(`Token ${provider} invalide pour user ${userId}`);
  }
}
```

### 3.3 Pipeline d'import enrichi

```
[OAuth callback Gmail OR Outlook]
    │
    ▼
[provider.listMessagesSince(60d, max 2000)]
    │
    ▼
[for each message: getFullMessage + extractAttachments]
    │
    ▼
[Group by sender, threshold 3+ emails → create dossiers]
    │
    ▼
[Insert all emails in DB (pipeline_step = 'imported')]
    │
    ▼
[For each PJ (PDF/DOCX) of every dossier:
   ├── download via provider
   ├── extract text
   ├── upload to Supabase Storage
   ├── generate resume_ia via GPT-4o-mini
   └── insert dossier_documents row]
    │
    ▼
[AI pipeline on ALL imported emails (not just < 24h):
   ├── filter (skip newsletters)
   ├── archive (assign dossier_id)
   ├── enrich classification (key_dates, urgency, opposing_party, summary)
   └── For < 24h: also generate brouillon]
    │
    ▼
[mergeDossiers via GPT-4o (existing logic, fuses fragmented dossiers)]
    │
    ▼
[For each merged dossier:
   ├── aggregateEcheances(dossierId)   → fill dossiers.echeances
   ├── aggregateResumePj(dossierId)    → fill dossiers.resume_pj
   └── regenerateDossierSummary(dossierId) → fill dossiers.resume_situation]
    │
    ▼
[generateBrief(userId, 1)  → store in briefs]
    │
    ▼
[sendPostOnboardingBriefing(userId) → email]
    │
    ▼
[onProgress: 100%]
    │
    ▼
[Frontend: redirect to /dashboard, dossiers visible immediately]
```

### 3.4 Real-time update on new email

```
[poller (gmail OR outlook, every 30s)]
    │
    ├── Token invalide ? → throw TokenInvalidError
    │      └── catch outer: UPDATE configurations
    │          SET refresh_token=NULL, gmail_needs_reconnect=true
    │          WHERE user_id=...
    │
    ▼
[for each new message]
    │
    ▼
[insert in emails table + processEmailWithAI]
    │
    ▼
[archiveEmail → dossier_id]
    │
    ▼
[draft generation (existing)]
    │
    ▼
[NEW: dossier-enricher.refresh(dossierId)]
    │   {
    │     debounce: 5 minutes since last update
    │     ├── aggregateEcheances
    │     ├── aggregateResumePj
    │     └── regenerateDossierSummary
    │   }
    │
    ▼
[Frontend dashboard auto-refresh via React Query polling 30s]
```

### 3.5 Frontend DossierDetail enrichi

```
┌──────────────────────────────────────────────────────────┐
│ ← Retour     M. Dupont              [Actif] [Renommer]   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  🟦 RÉSUMÉ                                              │
│  Litige bail commercial entre M. Dupont (locataire)      │
│  et SCI Les Tilleuls (bailleur). Audience JAF prévue     │
│  le 15 avril. 12 échanges, 5 pièces. (mis à jour 2min)   │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  🟧 ÉCHÉANCES (3)                                        │
│  ▪ 15 avril 2026 — Audience JAF, salle 12               │
│  ▪ 31 mars 2026 — Réponse aux conclusions adverses      │
│  ▪ 1 mai 2026 — Loyer dû                                │
├──────────────────────────────────────────────────────────┤
│  📧 ÉCHANGES (12)              📎 PIÈCES JOINTES (5)    │
│  ┌─────────────────┐           ┌─────────────────┐      │
│  │ Tribunal Paris  │           │ Convocation_JAF │      │
│  │ Convocation JAF │           │ "Audience le... │      │
│  │ il y a 2 heures │           │ 15 avril 2026"  │      │
│  ├─────────────────┤           ├─────────────────┤      │
│  │ Cabinet Moreau  │           │ Conclusions_v2  │      │
│  │ ...             │           │ ...             │      │
│  └─────────────────┘           └─────────────────┘      │
└──────────────────────────────────────────────────────────┘
```

---

## 4. Plan d'implémentation par étapes

### Étape A — Stabilisation (1h, débloque les users actuels)
**Goal** : la production tourne pour les vrais users.

1. Migration DB : `ALTER TABLE configurations ADD COLUMN gmail_needs_reconnect boolean DEFAULT false;`
2. Modifier `gmail-poller.ts` : détecter `invalid_grant` → set flag + clear refresh_token
3. Frontend : ajouter bannière `BannerReconnectGmail` qui s'affiche si `config.gmail_needs_reconnect === true` ; bouton "Reconnecter ma boîte mail" qui relance le OAuth flow
4. Test : forcer un user en flag, vérifier que la bannière apparaît, cliquer, vérifier que le flow OAuth se relance et reset le flag

**Deploy** : commit + docker rebuild + restart = product live pour les vrais users.

### Étape B — Enrichissement modèle dossier (3h, le cœur de la vision Yoel)
**Goal** : chaque dossier devient une mini knowledge-base auto-mise-à-jour.

1. Migration DB : `echeances`, `resume_pj`, `last_summary_update` sur `dossiers`
2. Créer `src/services/dossier-enricher.ts` :
   - `aggregateEcheances(dossierId)` — union de tous les `key_dates` des emails du dossier
   - `aggregateResumePj(dossierId)` — concat des `resume_ia` des `dossier_documents`
   - `regenerateDossierSummary(dossierId)` — GPT-4o sur les emails + résumé PJ + classification
   - `enrichDossier(dossierId)` — orchestre les 3 ci-dessus avec debounce 5 min
3. Modifier `ai-processor.ts` : appeler `enrichDossier` après `archiveEmail` (étape 2 du pipeline)
4. Modifier `agent-importer.ts` : appeler `enrichDossier` pour chaque dossier après `mergeDossiers`
5. Refactor `DossierDetail.tsx` : ajouter bloc Résumé + bloc Échéances visibles
6. Test E2E : importer une boîte test, vérifier que chaque dossier a un résumé pertinent et des échéances extraites

### Étape C — Pipeline IA complet à l'import (1h)
**Goal** : tous les emails de 60 jours sont analysés au moment de l'onboarding, pas seulement les < 24h.

1. Modifier `agent-importer.ts:437` : retirer le filtre `gte('created_at', twentyFourHoursAgo)`
2. Optimisation : skipper la génération de brouillon pour emails > 24h (juste filter + archive + enrich)
3. Mettre à jour `onProgress` avec un % réel basé sur (imported + processed) / (2 × total)
4. Test : importer 60 jours, vérifier que TOUS les emails ont un `resume`, une `classification`, et un `dossier_id`

### Étape D — Provider abstraction Outlook (2h, après réception des creds Azure)
**Goal** : avocates Outlook peuvent se connecter.

1. Créer `src/services/mail/types.ts` (interface MailProvider)
2. Créer `src/services/mail/gmail-provider.ts` : wrap les appels googleapis existants
3. Créer `src/services/mail/outlook-provider.ts` :
   - Use `@microsoft/microsoft-graph-client`
   - OAuth via `@azure/msal-node`
   - Mêmes méthodes que GmailProvider
4. Refactor `agent-importer.ts` : prend un `provider: MailProvider` en arg
5. Refactor `gmail-poller.ts` → `mail-poller.ts` qui itère sur les users avec leur provider
6. Routes `/api/import/outlook/auth` + `/api/import/outlook/callback`
7. Migration DB : ajout colonnes `outlook_*` à `configurations`
8. Test E2E avec un compte Outlook test (Yoel fournit)

### Étape E — Multi-tenant isolation tests (1h)
**Goal** : prouver que user A ne voit jamais user B.

1. Créer `__tests__/multi-tenant.test.ts` :
   - 2 fixtures users avec dossiers/emails/documents
   - Pour chaque route protégée : tenter d'accéder cross-user → expect 403
2. Run + fix éventuels leaks
3. CI : ajouter ce test à la pipeline (s'il y en a une)

### Étape F — Deploy + validation (30 min)
1. `docker-compose build && docker-compose up -d`
2. Test E2E manuel avec un compte Gmail vierge (Yoel fournit)
3. Vérifier le moment dopamine : connect → loading background → dashboard rempli avec dossiers + résumés + échéances + to-do
4. Capture screen, ping Yoel pour validation

---

## 5. Estimation des temps

| Étape | Temps focus | Bloqué par |
|---|---|---|
| A — Stabilisation invalid_grant | 1h | rien |
| B — Enrichissement dossier | 3h | rien |
| C — Pipeline IA complet | 1h | B |
| D — Provider Outlook | 2h | creds Azure (Cowork prompt 2) |
| E — Tests multi-tenant | 1h | rien |
| F — Deploy + validation | 30 min | A-E + compte Gmail test |
| **TOTAL** | **~8h focus** | |

---

## 6. Risques & coûts

| Risque | Impact | Mitigation |
|---|---|---|
| Coût GPT explose si 1000+ emails par avocate | Quelques $ par onboarding | Skip brouillon pour > 24h, batcher quand possible, monitorer Mission Control |
| Refresh token Outlook expire au bout de 90j d'inactivité | User offline | Même mécanisme `outlook_needs_reconnect` qu'on fait pour Gmail |
| Microsoft Graph rate limit (15k req/h) | Dégradation pour gros import | Ajouter retry exponentiel, batch requests |
| Merger GPT-4o sur > 50 dossiers fait exploser le prompt | Erreur GPT, dossiers non fusionnés | Chunker par groupes de 30 dossiers |
| Multi-tenant leak (un user voit l'autre) | Game-over légal | Tests E2E systématiques (Étape E) |
| Pipeline IA complet sur 60 jours = lent (~5 min) | UX dégradée si pas de loading | Background async + onProgress streaming + écran "Donna prépare votre cabinet..." sur Onboarding |

---

## 7. Décisions encore ouvertes

1. **Coût plafond par onboarding** : on plafonne à $5 par avocate ? À monitorer dans Mission Control.
2. **Provider Outlook** : on attend les credentials Azure de Yoel (Cowork prompt 2 en cours).
3. **Frontend DossierDetail** : refonte minimale (ajout 2 sections) ou refonte complète façon "Drive organisé" ? À voir avec Yoel selon le résultat de l'étape B.
4. **Citations NotebookLM (Q5)** : explicitement déprioritisé par Yoel — V2 après que tout soit fonctionnel.

---

## 8. Prochaines étapes

1. ✅ **Recon backend** — terminée
2. ✅ **Recon DB schema** — terminée (via Supabase REST)
3. ✅ **Plan technique écrit** — ce document
4. ⏳ **Reviewer ce plan via `/plan-eng-review`** avec Yoel — c'est l'étape suivante
5. ⏳ **Recevoir les credentials Azure** (Cowork prompt 2)
6. ⏳ **Implémenter Étape A** dès que le plan est validé
7. ⏳ **Suite des étapes B → F**

---

_Document généré par Alpha 👑 le 2026-04-07. Sera mis à jour après /plan-eng-review._
