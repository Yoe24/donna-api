# 📋 Checklist Déploiement - Dimanche 9 Mars

## ✅ Backend - C'EST PRÊT

Le code est commité et buildé. Localisé dans `/data/.openclaw/workspace/donna-mvp/`.

---

## 🚀 Plan du Jour (~45 min total)

### Phase 1: Database Neon (10 min)

1. Va sur https://neon.tech
2. Créer un projet gratuit
3. Créer la base `donna_mvp`
4. Copier la "Connection String" (elle commence par `postgresql://...`)
5. La garder pour plus tard

### Phase 2: Deploy Render (15 min)

**Option A - Git (recommandé):**
1. Push ce repo sur GitHub (crée un repo privé)
2. Va sur https://render.com
3. "New Web Service" → Connect GitHub repo
4. Config:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
5. Environment Variables:
   - `DATABASE_URL` → URL Neon (Phase 1)
   - `REDIS_URL` → Crée un Redis gratuit sur Upstash (https://upstash.com) → copier l'URL
   - `OPENAI_API_KEY` → Ta clé OpenAI
   - `FRONTEND_URL` → URL de ton frontend Vercel
   - `NODE_ENV` → `production`

**Option B - Render Blueprint (plus rapide):**
1. Push sur GitHub
2. Va dans Dashboard Render → "Blueprints"
3. Copie le contenu de `render.yaml`
4. Render crée automatiquement DB + Redis + Service

### Phase 3: Database Schema (2 min)

Une fois Render déployé:
```bash
# En local, avec la DATABASE_URL de Neon:
npx tsx src/scripts/push-schema.ts
```

Ou via le SQL Editor de Neon, copie-colle le contenu de `src/config/schema.sql`.

### Phase 4: Intégration Frontend (15 min)

Voir `FRONTEND.md` dans ce repo. **Copier-coller** les snippets dans ton projet Loveable.

Points clés:
- WebSocket URL → `https://ton-api-render.onrender.com`
- Remplacer les `fetch()` par ton vrai domaine
- Les events Socket.io → `email:received`, `draft:created`, `kpis:update`

### Phase 5: Test (3 min)

```bash
curl -X POST https://ton-api-render.onrender.com/api/emails/receive \
  -H "Content-Type: application/json" \
  -d '{
    "from": "test@example.com",
    "to": "donna@donna.ai",
    "subject": "Test",
    "body": "Je veux un rendez-vous pour un divorce."
  }'
```

→ Si tu vois une réponse JSON avec une classification et un draft → **ÇA MARCHE** 🎉

---

## 🎯 Critères de Succès

- [ ] API Render déployée et healthy (`/health` retourne OK)
- [ ] Database Neon avec tables créées
- [ ] Frontend WebSocket connecté (console dit "Connected to Donna")
- [ ] Test curl retourne un draft généré
- [ ] Boutons Copier/Valider/Rejeter fonctionnent

---

## 🔧 Si Ça Casse

| Problème | Solution |
|----------|----------|
| "Cannot connect to database" | Vérifier DATABASE_URL, s'assurer que Neon autorise les connexions externes |
| "Redis connection failed" | Upstash → vérifie l'URL commence par `rediss://` (avec un 's') |
| "OpenAI error" | Vérifier que la clé n'a pas expiré, vérifier les quotas |
| "CORS error" | Vérifier FRONTEND_URL correspond bien à l'URL Vercel |
| Socket.io ne connecte pas | Vérifier que le client utilise `io('https://...')` avec le bon domaine |

---

## 📁 Structure du Code

```
donna-mvp/
├── src/
│   ├── index.ts              # Server Express + Socket.io
│   ├── config/
│   │   ├── database.ts       # PostgreSQL pool
│   │   ├── redis.ts          # Redis client
│   │   └── schema.sql        # Tables DB
│   ├── routes/
│   │   ├── emails.ts         # POST /receive + GET /
│   │   ├── drafts.ts         # validate + delete
│   │   ├── kpis.ts           # Stats
│   │   └── health.ts         # Health check
│   ├── services/
│   │   └── llm/
│   │       ├── facteur.ts    # Classification GPT
│   │       └── plume.ts      # Génération drafts
│   ├── models/
│   │   └── index.ts          # DB queries
│   └── types/
│       └── index.ts          # TypeScript interfaces
├── FRONTEND.md               # Code React à copier
├── DEPLOY.md                 # Guide déploiement détaillé
└── render.yaml               # Config Render one-click
```

---

## 🧠 Décisions Architecturales (Si Besoin de Debug)

| Décision | Pourquoi |
|----------|----------|
| **Appels directs OpenAI** vs CrewAI | CrewAI = overhead pour 2 agents. On passe à CrewAI à 4-5 agents. |
| **No RLS/Multi-tenancy** | MVP = 1 avocate. RLS ajouté semaine 2 avec `tenant_id`. |
| **JSONB annotations** | `[1]`, `[⚠️]`, `[📅]` structurés dès le départ pour affichage NotebookLM-style. |
| **Socket.io vs WebSocket natif** | Socket.io gère auto-reconnect, rooms, fallback. Indispensable pour prod. |
| **PostgreSQL vs SQLite** | Semaine 2 = multi-tenant. PostgreSQL scale, SQLite non. |

---

## 📞 Besoin d'Aide ?

Logs sur Render:
```
Dashboard Render → Ton service → Logs
```

Test local avant deploy:
```bash
cp .env.test .env
# Éditer .env avec ta clé OpenAI
npm run dev
./test-api.sh
```

---

**GO GO GO 🚀**
