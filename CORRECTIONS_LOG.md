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
