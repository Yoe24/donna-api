# Donna Legal - Journal des corrections de sécurité

Date : 2026-03-26

---

## Correction 1 : Authentification sur toutes les routes API

**Statut : FAIT**

### Ce qui a été fait :
1. Créé `src/middleware/auth.ts` : middleware qui vérifie le token Bearer via `supabase.auth.getUser(token)`, retourne 401 si invalide, attache `req.user` si valide
2. Appliqué le middleware sur toutes les routes `/api/*` dans `src/index.ts` :
   - `GET/POST /api/kpis` - protégé
   - `GET/POST /api/emails/*` - protégé
   - `GET/POST/DELETE /api/drafts/*` - protégé
3. Routes NON protégées (volontaire) :
   - `GET /health` - healthcheck public
   - `POST /webhook/webhook` - webhook AgentMail (auth séparée, voir Correction 4)
4. Supprimé l'acceptation de `user_id` depuis le body du webhook - le user_id est maintenant déterminé côté serveur via `process.env.DEFAULT_USER_ID`

### Fichiers modifiés :
- `src/middleware/auth.ts` (nouveau)
- `src/index.ts`
- `src/routes/webhook.ts`

---

## Correction 2 : Suppression des secrets du code source

**Statut : FAIT**

### Ce qui a été fait :
1. **Frontend** (`src/lib/supabase.ts`) : supprimé les valeurs en fallback (URL Supabase et anon key en dur). Le code lance maintenant une erreur si les variables d'env manquent
2. **Frontend** : créé `.env.example` avec les variables requises
3. **Frontend** : ajouté `.env`, `.env.local`, `.env.production` dans `.gitignore`
4. **Backend** (`src/config/supabase.ts`) : supprimé la service_role key en dur. Le code lance maintenant une erreur si les variables d'env manquent
5. **Backend** (`seed-emails.js`) : remplacé les credentials en dur par `process.env` via dotenv
6. **Backend** : nettoyé `.env.example` pour ne plus contenir de vraies URLs/clés

### Actions manuelles requises :
- **URGENT** : Régénérer la clé anon Supabase dans le dashboard Supabase (elle a été exposée dans le repo GitHub public)
- **URGENT** : Régénérer la clé service_role Supabase (exposée dans le code backend ET dans seed-emails.js)
- Mettre à jour les variables d'environnement sur Vercel (frontend) avec les nouvelles clés
- Mettre à jour le `.env` sur le serveur backend avec les nouvelles clés

### Fichiers modifiés :
- `src/config/supabase.ts` (backend)
- `seed-emails.js` (backend)
- `.env.example` (backend)
- Frontend : `src/lib/supabase.ts`, `.env.example`, `.gitignore`

---

## Correction 3 : Ajout de store:false sur tous les appels OpenAI

**Statut : FAIT**

### Ce qui a été fait :
Ajout de `store: false` sur les 3 appels `openai.chat.completions.create` pour empêcher OpenAI de stocker les données juridiques confidentielles :

1. `src/services/ai-processor.ts` : génération de brouillon (gpt-4o)
2. `src/services/llm/facteur.ts` : classification d'emails (gpt-4o-mini)
3. `src/services/llm/plume.ts` : rédaction de réponses (gpt-4o-mini)

### Fichiers modifiés :
- `src/services/ai-processor.ts`
- `src/services/llm/facteur.ts`
- `src/services/llm/plume.ts`

---
