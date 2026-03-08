# 🚀 Déploiement Donna MVP

## Prérequis

1. **Neon PostgreSQL** - Créer un projet gratuit sur https://neon.tech
2. **Upstash Redis** - Créer un DB gratuit sur https://upstash.com
3. **OpenAI API Key** - Depuis https://platform.openai.com
4. **Render Account** - Pour déployer l'API

## Setup Initial

### 1. Database (Neon)
```bash
# Copier la connection string Neon
cp .env.example .env
# Éditer DATABASE_URL avec l'URL Neon
```

### 2. Push Schema
```bash
npm install
npm run db:push
```

### 3. Test Local
```bash
npm run dev
```

Testez avec curl:
```bash
curl -X POST http://localhost:3000/api/emails/receive \
  -H "Content-Type: application/json" \
  -d '{
    "from": "client@example.com",
    "to": "donna@donna.ai",
    "subject": "Demande de consultation",
    "body": "Bonjour, je souhaite prendre rendez-vous pour un divorce. Cordialement."
  }'
```

## Déploiement Render

1. Créer un nouveau Web Service sur Render
2. Connecter le repo GitHub
3. Config:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
4. Variables d'environnement:
   - `DATABASE_URL` → URL Neon
   - `REDIS_URL` → URL Upstash
   - `OPENAI_API_KEY` → Clé OpenAI
   - `FRONTEND_URL` → URL Vercel frontend
   - `NODE_ENV` → production

## Frontend Intégration

Le frontend React doit:
1. Se connecter au WebSocket: `io('https://votre-api-render.com')`
2. Écouter les événements: `email:received`, `draft:created`, `kpis:update`
3. Implémenter les boutons:
   - Copier: `navigator.clipboard.writeText(draft.body)`
   - Valider: `POST /api/drafts/${id}/validate`
   - Rejeter: `DELETE /api/drafts/${id}`

## WebSocket Events

### Server → Client
- `email:received` - Nouvel email reçu
- `draft:created` - Brouillon généré
- `kpis:update` - Stats mises à jour

### Client → Server
- `client:ping` - Keepalive (optionnel)

## Endpoints API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/kpis` | Stats du jour |
| GET | `/api/emails` | Liste emails |
| POST | `/api/emails/receive` | Recevoir email |
| GET | `/api/drafts` | Liste brouillons |
| POST | `/api/drafts/:id/validate` | Valider brouillon |
| DELETE | `/api/drafts/:id` | Rejeter brouillon |

## Gmail Forward (Manuel)

Demain, pour tester:
1. L'avocate configure un forward dans Gmail vers `donna-legale@ton-domaine.com`
2. Ton serveur reçoit l'email via POST (Mailgun/Formspree ou endpoint simple)
3. Traitement automatique Facteur → Plume → Dashboard

Option rapide pour MVP: utiliser https://formspree.io/forms avec webhook vers ton endpoint `/api/emails/receive`
