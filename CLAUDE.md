# DONNA LEGAL — Architecture & Pipeline MVP
# Document de référence unique (à coller dans CLAUDE.md frontend + backend)
# Dernière mise à jour : 26 mars 2026

---

## 1. VISION PRODUIT

Donna est une assistante IA pour avocats. Elle analyse automatiquement les emails entrants, les classe par dossier client, résume chaque email et ses pièces jointes, et présente le tout dans une interface claire.

### MVP — Ce que Donna fait
- Récupère les emails via Gmail API (polling 30s, déjà fonctionnel)
- Filtre le bruit (spam, newsletters, notifications) via IA + pattern matching
- Rattache chaque email au bon dossier client (match par email expéditeur)
- Résume l'email + génère une recommandation
- Extrait les pièces jointes, les stocke dans Supabase Storage, résume les PDF/Word
- Génère un brouillon de réponse sur demande manuelle (bouton "Générer une réponse")
- Présente un briefing avec vue 24h / 7 jours / 30 jours
- Onboarding : import 90 jours d'emails, clustering auto des dossiers, détection du style

### MVP — Ce que Donna ne fait PAS
- Pas de brouillon automatique (uniquement sur clic, `needs_response` stocké mais non utilisé pour auto-générer)
- Pas de détection d'urgence/relance affichée dans l'UI (le champ `urgency` est calculé mais non exploité côté frontend)
- Pas de chat IA sur les dossiers (route `/api/chat` existe mais hors MVP)
- Pas de matching dossier multi-niveaux (référence RG, partie adverse, embeddings) — prévu post-MVP

### Mode démo
- 100% frontend, zéro appel API
- Données mockées locales dans `mock-briefing.ts` et `mock-data.ts`
- Aucune incidence sur la route Gmail ni sur le pipeline réel
- Le backend ne sert aucune donnée pour le demo user_id

---

## 2. STACK TECHNIQUE

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  Gmail API  │────>│  Backend (API)       │────>│  Supabase Cloud  │
│  polling 30s│     │  Node + Express + TS │     │  PostgreSQL      │
└─────────────┘     │  Docker / VPS        │     │  Storage (PJ)    │
                    │                      │     └──────────────────┘
                    │  OpenAI              │
                    │  GPT-4o (résumés)    │     ┌──────────────────┐
                    │  GPT-4o-mini (filtre)│────>│  Frontend        │
                    │                      │     │  React + Vite    │
                    └──────────────────────┘     │  Vercel          │
                                                └──────────────────┘
```

### Frontend
- React + TypeScript + Tailwind + shadcn/ui
- Déployé sur Vercel (auto-deploy depuis GitHub `Yoe24/donna-s-insight-hub`)
- VPS : `/var/www/donna-frontend/`
- URL : donna-legal.com

### Backend
- Node.js + Express + TypeScript
- Container Docker sur VPS Hostinger (Ubuntu)
- VPS : `/var/www/donna-api/`
- Nginx reverse proxy + SSL Let's Encrypt
- URL : api.donna-legal.com
- Port : 3000

### Base de données & stockage
- Supabase Cloud (PostgreSQL) — toutes les données
- Supabase Storage — bucket `attachments` pour les PJ (PDF, Word, images)

### IA
- GPT-4o : résumés, recommandations, brouillons, briefs, fusion dossiers
- GPT-4o-mini : filtrage pertinence, classification enrichie, résumé PJ
- **Tous les appels : `store: false`** (11 appels au total, conformité vérifiée)

---

## 3. PIPELINE EMAIL — Le cœur de Donna

### Vue d'ensemble
```
Gmail API (polling 30s)
  → Nouveau mail détecté (via historyId)
  → INSERT dans Supabase (pipeline_step: 'en_attente')
  → processEmailWithAI() lancé en async :
      │
      ├─ STEP 1 : agent-filter     → pertinent ou non ?
      │   Si non pertinent → pipeline_step: 'ignore', FIN
      │
      ├─ STEP 2 : archiveEmail     → rattachement dossier (par email expéditeur)
      │   Si aucun dossier → création automatique
      │
      ├─ STEP 3 : agent-context    → charge contexte dossier (5 emails + 5 docs)
      │
      ├─ STEP 4 : config cabinet   → charge signature, ton, style depuis configurations
      │
      ├─ STEP 5 : agent-drafter    → GPT-4o génère résumé + recommandation
      │
      ├─ STEP 6 : extraction résumé court
      │
      ├─ STEP 7 : sauvegarde       → pipeline_step: 'pret_a_reviser'
      │
      └─ STEP 8 : enrichClassification → GPT-4o-mini classification structurée
                                          (urgence, type, dates clés, fait nouveau)
```

### Fichiers backend impliqués
| Étape | Fichier | Modèle IA |
|-------|---------|-----------|
| Polling Gmail | `services/gmail-poller.ts` | — |
| Orchestrateur | `services/ai-processor.ts` | — |
| Step 1 : Filtre | `services/agents/agent-filter.ts` | GPT-4o-mini |
| Step 2 : Dossier | `services/ai-processor.ts` (archiveEmail) | — |
| Step 3 : Contexte | `services/agents/agent-context.ts` | — |
| Step 5 : Résumé + reco | `services/agents/agent-drafter.ts` | GPT-4o |
| Step 8 : Classification | `services/ai-processor.ts` (enrichEmailClassification) | GPT-4o-mini |
| PJ : extraction + résumé | `services/attachment-processor.ts` | GPT-4o-mini |
| Import initial | `services/agents/agent-importer.ts` | GPT-4o + GPT-4o-mini |
| Brief quotidien | `services/brief-generator.ts` | GPT-4o |
| Fusion dossiers | `services/dossier-merger.ts` | GPT-4o |
| Brouillon (manuel) | `routes/emails.ts` (POST /:id/draft) | GPT-4o |

### Pipeline des pièces jointes
```
Email avec PJ détecté
  → Pour chaque attachment :
      1. Téléchargement via Gmail API
      2. Upload vers Supabase Storage (bucket 'attachments')
      3. Si PDF/Word : extraction texte (pdf-parse / mammoth)
      4. Résumé IA du contenu (GPT-4o-mini)
      5. INSERT dans dossier_documents (nom, type, storage_url, resume_ia)
```

### Valeurs de pipeline_step
| Valeur | Signification |
|--------|--------------|
| `en_attente` | Email récupéré, pas encore traité |
| `ignore` | Filtré (spam, newsletter, notification) |
| `pret_a_reviser` | Traitement complet terminé |

---

## 4. TABLES SUPABASE (État réel)

### `emails`
| Champ | Type | Description |
|-------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK | |
| dossier_id | uuid FK (nullable) | Rattachement au dossier |
| expediteur | text | Nom + email de l'expéditeur |
| objet | text | Sujet de l'email |
| resume | text | Résumé IA de l'email |
| brouillon | text | Brouillon de réponse (généré manuellement) |
| pipeline_step | text | en_attente / ignore / pret_a_reviser |
| statut | text | État du traitement |
| contexte_choisi | text | Contexte dossier utilisé pour le résumé |
| metadata | jsonb | Données brutes Gmail (headers, snippet, etc.) |
| urgency | text | high / medium / low (calculé par IA, non exploité UI) |
| needs_response | boolean | Si l'email nécessite une réponse (non exploité UI) |
| classification | jsonb | Classification structurée complète |
| is_processed | boolean | Pipeline terminé ? |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `dossiers`
| Champ | Type | Description |
|-------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK | |
| nom_client | text | Nom du client |
| email_client | text | Email du client |
| domaine | text | Domaine juridique |
| statut | text | actif / archivé |
| resume_situation | text | Résumé global du dossier |
| opposing_party | text | Partie adverse (extrait par IA) |
| case_reference | text | Référence RG (extrait par IA) |
| dernier_echange_date | timestamptz | |
| dernier_echange_par | text | |
| created_at | timestamptz | |

### `dossier_documents`
| Champ | Type | Description |
|-------|------|-------------|
| id | uuid PK | |
| dossier_id | uuid FK | |
| email_id | uuid FK | Email source de la PJ |
| nom_fichier | text | |
| type | text | Type de document |
| contenu_extrait | text | Texte extrait (PDF/Word) |
| date_reception | timestamptz | |
| storage_url | text | URL Supabase Storage |
| resume_ia | text | Résumé IA du contenu |

### `configurations`
| Champ | Type | Description |
|-------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK | |
| nom_avocat | text | |
| nom_cabinet | text | |
| specialite | text | |
| signature | text | Signature email |
| profil_style | jsonb | Style d'écriture détecté (Pipeline D) |
| formule_appel | text | Ex: "Maître," |
| formule_politesse | text | Ex: "Cordialement," |
| ton_reponse | text | |
| niveau_concision | text | |
| email_exemples | text | |
| sources_favorites | text | |
| refresh_token | text | Token Gmail OAuth (protégé) |
| gmail_last_check | timestamptz | |
| updated_at | timestamptz | |

### `briefs`
| Champ | Type | Description |
|-------|------|-------------|
| id | uuid PK | |
| user_id | uuid FK | |
| brief_date | date | |
| content | jsonb | Briefing complet (executive_summary + dossiers[]) |
| is_read | boolean | |

### Supabase Storage
- Bucket : `attachments`
- Structure : PJ uploadées par `attachment-processor.ts`
- Accès : via `storage_url` dans `dossier_documents`

---

## 5. ROUTES API (État réel + corrections nécessaires)

Toutes les routes protégées nécessitent `Authorization: Bearer <jwt_supabase>`.
Le middleware auth (`middleware/auth.ts`) valide le JWT et met `req.user.id`.

### Routes fonctionnelles

| Méthode | Route | Auth | Description | Bug connu |
|---------|-------|------|-------------|-----------|
| GET | /health | Non | Health check | — |
| GET | /api/emails | Oui | Liste emails (+ dossiers) | — |
| GET | /api/emails/stats | Oui | Stats par pipeline_step | — |
| GET | /api/emails/:id | Oui | Détail email + PJ | ⚠️ Pas de filtre user_id |
| POST | /api/emails/:id/feedback | Oui | Feedback sur le résumé | ⚠️ Pas de filtre user_id |
| POST | /api/emails/:id/draft | Oui | Générer brouillon (GPT-4o) | ⚠️ Pas de filtre user_id |
| GET | /api/dossiers | Oui | Liste dossiers | ⚠️ Utilise req.query.user_id |
| GET | /api/dossiers/:id | Oui | Détail dossier | ⚠️ Utilise req.query.user_id |
| GET | /api/config | Oui | Config utilisateur | ⚠️ Utilise req.query.user_id |
| PUT | /api/config | Oui | Sauvegarder config | ⚠️ Utilise req.query.user_id |
| GET | /api/briefs/today | Oui | Brief du jour (auto-génère si absent) | ⚠️ Utilise req.query.user_id |
| POST | /api/briefs/generate | Oui | Forcer génération brief | ⚠️ Utilise req.query.user_id |
| POST | /api/chat | Oui | Chat avec Donna | ⚠️ Utilise req.body.user_id |
| GET | /api/import/gmail/auth | Non | URL OAuth Gmail | — |
| GET | /api/import/callback | Non | Callback OAuth | — |
| GET | /api/import/status | Non | État import | — |
| GET | /api/import/demo-login | Non | Login démo | — |

### Routes cassées (à supprimer)
| Route | Raison |
|-------|--------|
| GET /api/drafts | Legacy PostgreSQL direct (DraftModel) |
| POST /api/drafts/:id/validate | Legacy PostgreSQL direct |
| DELETE /api/drafts/:id | Legacy PostgreSQL direct |
| GET /api/kpis | Legacy PostgreSQL direct (StatsModel) |

---

## 6. MAPPING FRONTEND ↔ BACKEND

### Page : Briefing (`/dashboard`)
| Élément UI | Route API (mode réel) | Source mock (mode démo) |
|------------|----------------------|------------------------|
| "Bon après-midi Alexandra" | `GET /api/config` → nom_avocat | mockConfig |
| Boutons 24h / 7j / 30j | `GET /api/briefs/today` → content | mockBriefing |
| Stats (emails reçus, liés, filtrés) | briefing → content.stats | mockBriefing.content |
| DOSSIERS ACTIFS + résumés emails | briefing → content.dossiers[] | mockBriefing.content.dossiers |
| EN ATTENTE | briefing → content.en_attente[] | mockBriefing.content |
| Clic résumé → Drawer (email détail) | `GET /api/emails/:id` | mockDossierEmails |
| "Voir l'email complet" dans drawer | Affiche contenu stocké dans metadata | mock (contenu affiché) |
| "Générer un brouillon de réponse" | `POST /api/emails/:id/draft` | désactivé en démo |
| "Voir le dossier complet" | Navigation → `/dossiers/:id` | — |
| Sidebar → dossiers | `GET /api/dossiers` | useDossiers → mockBriefing |

### Page : Fil d'actualité (`/fil`)
| Élément UI | Route API | Source mock |
|------------|-----------|-------------|
| Filtres : Tous / Emails / PJ / Relances | `GET /api/emails` (filtré) | activityFeed mock |
| Liste emails (expéditeur, objet, dossier, résumé) | emails[] | activityFeed |
| Clic email → Drawer | `GET /api/emails/:id` | mockDossierEmails |
| Badge type (Informatif, Demande, etc.) | email.classification.email_type | mock |
| "Voir l'email original" | email.metadata (contenu stocké) | mock |
| "Générer une réponse" | `POST /api/emails/:id/draft` | désactivé en démo |

### Page : Dossier (`/dossiers/:id`)
| Élément UI | Route API | Source mock |
|------------|-----------|-------------|
| Nom client + badge + domaine | `GET /api/dossiers/:id` | mockBriefing.dossiers |
| Résumé du dossier | dossier.resume_situation | mockBriefing.dossiers[].summary |
| Emails (liste) | dossier → emails[] | mockDossierEmails[id] |
| Documents (liste PJ) | dossier → dossier_documents[] | extrait des mockDossierEmails[].pieces_jointes |
| Clic email → Drawer | `GET /api/emails/:id` | mock |
| Clic document → télécharger | Supabase Storage (storage_url) | désactivé en démo |
| Menu : Renommer | `PUT /api/dossiers/:id` | mock local |
| Menu : Changer domaine | `PUT /api/dossiers/:id` | mock local |
| Menu : Fusionner | POST merge (pas encore de route) | mock local |
| Menu : Supprimer | DELETE (pas encore de route) | mock local |

### Page : Configurez-moi (`/configuration`)
| Élément UI | Route API | Source mock |
|------------|-----------|-------------|
| Connexion Gmail | `GET /api/import/gmail/auth` | affiché mais inactif en démo |
| Signature email | `GET /api/config` → signature | mockConfig |
| Instructions pour Donna | `GET /api/config` → ton_reponse / instructions | mockConfig |
| Sauvegarder | `PUT /api/config` | mock local |

---

## 7. MODE DÉMO vs MODE RÉEL

### Règle absolue
```typescript
// Chaque hook/composant qui charge des données DOIT avoir ce pattern :
if (isDemo()) {
  // Utiliser les mocks locaux (mock-briefing.ts, mock-data.ts)
  // Zéro appel API, zéro appel backend
  return;
}
// Appel API normal avec Bearer token
```

### Mode démo — ce qui fonctionne
- ✅ Briefing avec données mockées
- ✅ Sidebar avec dossiers mockés
- ✅ Page dossier avec emails et documents mockés
- ✅ Fil d'actualité avec emails mockés
- ✅ Drawer email avec résumé

### Mode démo — ce qui est désactivé
- ❌ "Générer une réponse" → bouton visible mais affiche message "Disponible avec Gmail connecté"
- ❌ Télécharger PJ → idem
- ❌ "Voir l'email original" → affiche le résumé (pas de contenu brut en mock)
- ❌ Connexion Gmail → redirige vers inscription
- ❌ Sauvegarder config → mock local seulement

### Mode réel — prérequis
1. Utilisateur authentifié via Supabase Auth
2. Gmail connecté via OAuth (`refresh_token` stocké dans `configurations`)
3. Import initial terminé (90 jours d'emails analysés)
4. Polling Gmail activé (30s) pour les nouveaux emails

---

## 8. FICHIERS BACKEND — Structure nettoyée (après suppression legacy)

```
src/
├── index.ts                          # Express + démarrage polling
├── config/
│   └── supabase.ts                   # Client Supabase (service_role)
├── middleware/
│   └── auth.ts                       # Bearer token → req.user.id
├── routes/
│   ├── health.ts                     # GET /health
│   ├── emails.ts                     # /api/emails/*
│   ├── dossiers.ts                   # /api/dossiers/*
│   ├── config.ts                     # /api/config
│   ├── briefs.ts                     # /api/briefs/*
│   └── import.ts                     # /api/import/* (OAuth + import)
├── services/
│   ├── ai-processor.ts              # Pipeline principal (orchestrateur)
│   ├── attachment-processor.ts      # PJ : extraction + upload + résumé
│   ├── brief-generator.ts          # Briefing quotidien
│   ├── dossier-merger.ts           # Fusion dossiers dupliqués
│   ├── gmail-poller.ts             # Polling Gmail 30s
│   └── agents/
│       ├── agent-filter.ts          # Filtre pertinence
│       ├── agent-drafter.ts         # Résumé + recommandation
│       ├── agent-context.ts         # Contexte dossier
│       └── agent-importer.ts        # Import initial Gmail
└── types/
    └── index.ts                     # Types TypeScript
```

### Fichiers à supprimer (legacy inutilisé)
- `config/database.ts` — pool PostgreSQL direct (remplacé par Supabase)
- `config/redis.ts` — client Redis (jamais utilisé)
- `models/index.ts` — EmailModel, DraftModel, StatsModel (legacy pg)
- `services/llm/facteur.ts` — classification legacy (remplacé par agent-filter)
- `services/llm/plume.ts` — brouillon legacy (remplacé par agent-drafter)
- `services/llm/index.ts` — re-exports legacy
- `routes/drafts.ts` — routes cassées (utilisent DraftModel)
- `routes/kpis.ts` — routes cassées (utilisent StatsModel)
- `routes/chat.ts` — hors MVP
- `scripts/push-schema.ts` — script one-shot
- `config/schema.sql` — schema legacy

---

## 9. CORRECTIONS PRIORITAIRES MVP

### Sécurité (CRITIQUE — à faire en premier)
| # | Fichier | Problème | Correction |
|---|---------|----------|------------|
| 1 | routes/dossiers.ts | req.query.user_id | Remplacer par req.user.id |
| 2 | routes/config.ts | req.query.user_id | Remplacer par req.user.id |
| 3 | routes/briefs.ts | req.query.user_id | Remplacer par req.user.id |
| 4 | routes/emails.ts (/:id) | Pas de filtre user_id | Ajouter .eq('user_id', req.user.id) |
| 5 | routes/emails.ts (/:id/feedback) | Pas de filtre user_id | Ajouter .eq('user_id', req.user.id) |
| 6 | routes/emails.ts (/:id/draft) | Pas de filtre user_id | Ajouter .eq('user_id', req.user.id) |

### Activation polling (CRITIQUE — sans ça, pas de nouveaux emails)
| # | Fichier | Action |
|---|---------|--------|
| 7 | index.ts | Ajouter `startGmailPolling()` au démarrage du serveur |

### Nettoyage legacy
| # | Action |
|---|--------|
| 8 | Supprimer les 11 fichiers legacy listés en section 8 |
| 9 | Retirer les imports/routes correspondants dans index.ts |

### Routes manquantes (pour compléter le frontend)
| # | Route | Usage frontend |
|---|-------|---------------|
| 10 | PUT /api/dossiers/:id | Renommer un dossier / changer domaine |
| 11 | DELETE /api/dossiers/:id | Supprimer/archiver un dossier |
| 12 | POST /api/dossiers/:id/merge/:targetId | Fusionner deux dossiers |

---

## 10. ROADMAP

### Phase 1 — MVP stable (maintenant)
- [ ] Corrections sécurité (6 routes)
- [ ] Activer le polling Gmail dans index.ts
- [ ] Supprimer le code legacy
- [ ] Ajouter les routes manquantes (PUT/DELETE dossiers, merge)
- [ ] Aligner le frontend sur les routes réelles
- [ ] Enrichir les mocks démo pour une expérience complète
- [ ] Tester le pipeline complet avec de vrais emails

### Phase 2 — Post-MVP
- [ ] Matching dossier multi-niveaux (référence RG, partie adverse, embeddings)
- [ ] Table `drafts` séparée avec historique et apprentissage
- [ ] Détection urgence/relance affichée dans l'UI
- [ ] Brouillon automatique (exploiter `needs_response`)
- [ ] Archivage automatique des dossiers inactifs (30 jours)
- [ ] Chat IA sur les dossiers

### Phase 3 — Scale
- [ ] Multi-utilisateurs (plusieurs avocats)
- [ ] Onboarding guidé avec barre de progression
- [ ] Analytics / KPIs
- [ ] Facturation (Stripe)
- [ ] Google Pub/Sub pour remplacer le polling

---

## 11. RÈGLES DE DÉVELOPPEMENT

### Pour chaque session Claude Code
1. **Lire le CLAUDE.md** en premier
2. **Identifier si c'est frontend ou backend** avant de modifier quoi que ce soit
3. **Tester** : `npm run build` (front) ou `npx tsc --noEmit` (back) avant de commit
4. **Déployer** : `git push` (front → Vercel) ou `docker compose build && up -d` (back)
5. **Mettre à jour le CLAUDE.md** avec ce qui a été fait

### Pattern mode démo (frontend)
```typescript
if (isDemo()) {
  // Mocks locaux, JAMAIS d'appel API
  return;
}
// API normale
```

### Pattern sécurité (backend)
```typescript
// TOUJOURS utiliser req.user.id, JAMAIS req.query.user_id
const userId = req.user.id;
const { data } = await supabase.from('table').select('*').eq('user_id', userId);
```

### Règles OpenAI
- Toujours `store: false`
- GPT-4o pour les tâches complexes (résumés, brouillons, briefs)
- GPT-4o-mini pour les tâches simples (filtrage, classification, résumé PJ)
