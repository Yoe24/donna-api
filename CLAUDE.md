# Donna Legal - Backend API

## Architecture globale

Donna Legal est un assistant juridique IA pour avocats. Le projet a 3 composants :

- **Frontend** : React + TypeScript + Tailwind + shadcn/ui, deployé sur Vercel (`/var/www/donna-frontend/`, repo `Yoe24/donna-s-insight-hub`)
- **Backend (ce repo)** : Node.js + Express + TypeScript, Docker sur VPS (`/var/www/donna-api/`)
- **Base de données** : Supabase Cloud (PostgreSQL) - tables : `emails`, `dossiers`, `dossier_documents`, `configurations`, `daily_stats`, `briefs`

## Structure du backend

```
src/
  index.ts                  # Point d'entree Express + Socket.io
  middleware/
    auth.ts                 # Auth middleware Supabase (Bearer token -> req.user)
  routes/
    health.ts               # GET /health (public)
    emails.ts               # GET/POST /api/emails/* (protege)
    drafts.ts               # GET/POST/DELETE /api/drafts/* (protege)
    kpis.ts                 # GET /api/kpis (protege)
    dossiers.ts             # GET /api/dossiers/* (protege)
    config.ts               # GET/PUT /api/config (protege)
    briefs.ts               # GET/POST /api/briefs/* (protege)
    chat.ts                 # POST /api/chat (protege)
    import.ts               # GET /api/import/* (OAuth Gmail, public pour callback)
  services/
    ai-processor.ts         # Pipeline principal : filter -> archive -> context -> draft -> classify
    agents/
      agent-filter.ts       # Filtre pertinence email (GPT-4o-mini)
      agent-drafter.ts      # Resume + recommandation (GPT-4o)
      agent-context.ts      # Recherche contexte dossier dans Supabase
      agent-importer.ts     # Import Gmail en masse
    attachment-processor.ts  # Extraction texte PDF/Word
    brief-generator.ts      # Generation brief quotidien (GPT-4o)
    dossier-merger.ts       # Fusion dossiers dupliques (GPT-4o)
    gmail-poller.ts         # Polling continu Gmail
    llm/
      facteur.ts            # Classification emails (GPT-4o-mini)
      plume.ts              # Generation brouillons (GPT-4o-mini)
  config/
    supabase.ts             # Client Supabase (service_role)
    database.ts             # Pool PostgreSQL
    redis.ts                # Config Redis (optionnel)
  models/index.ts           # Models SQL (EmailModel, DraftModel, StatsModel)
  types/index.ts            # Types TypeScript partages
```

## Regles de securite

1. **Auth sur toutes les routes /api/*** : Le middleware `auth.ts` verifie le token Bearer via `supabase.auth.getUser()`. Seul `/health` et `/api/import/callback` sont publics.

2. **user_id toujours depuis le token JWT** : Ne JAMAIS accepter `user_id` depuis le body, les query params ou l'URL. Utiliser `req.user.id` depuis le middleware auth.

3. **store: false sur TOUS les appels OpenAI** : Chaque appel `openai.chat.completions.create()` doit inclure `store: false` pour ne pas stocker les donnees juridiques confidentielles chez OpenAI. Il y a 11 appels au total.

4. **Pas de secrets en dur** : Toutes les cles (Supabase, OpenAI, Google) doivent venir de `process.env`. Le code doit planter au demarrage si une variable requise manque.

5. **Pas de webhook AgentMail** : Le webhook a ete supprime. L'ingestion d'emails se fait uniquement via Gmail OAuth (route `/api/import`).

## Deploiement backend

```bash
# Build et deploy
cd /var/www/donna-api
docker compose build && docker compose up -d

# Verifier
docker logs donna-api-donna-api-1 --tail 20
curl http://localhost:3000/health
```

Le Dockerfile compile TypeScript avec `tsc` puis lance `node dist/index.js`. Pas de patches post-build.

## Tests

```bash
cd /var/www/donna-api && npx jest --verbose
```

2 suites, 12 tests :
- `__tests__/auth.test.ts` (4 tests) : middleware auth (sans token -> 401, token invalide -> 401, token valide -> next)
- `__tests__/routes.test.ts` (8 tests) : healthcheck 200, toutes routes /api/* -> 401 sans auth

## Pipeline de traitement email

Quand un email arrive (via Gmail import) :
1. **agent-filter** : determine si l'email est pertinent (GPT-4o-mini) ou bypass par pattern
2. **archiviste** : rattache l'email a un dossier existant ou cree un nouveau dossier
3. **agent-context** : charge le contexte du dossier (emails precedents, documents)
4. **agent-drafter** : genere resume + recommandation (GPT-4o)
5. **enrichissement** : classification structuree (urgence, type, dates cles) via GPT-4o-mini

## Variables d'environnement requises

```
SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, FRONTEND_URL, PORT
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (pour import Gmail)
```
