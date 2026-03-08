# Donna MVP - AI Legal Email Assistant

## Quick Start

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your credentials

# Push database schema
npm run db:push

# Run development server
npm run dev
```

## Testing

```bash
# Run the test script
./test-api.sh
```

## Deployment

### Render (Recommended)

1. Push to GitHub
2. Connect repo to Render
3. Use `render.yaml` for infrastructure-as-code

### Manual

```bash
# Build
npm run build

# Start
npm start
```

## Architecture

- **Facteur**: Classifies emails (GPT-4o-mini)
- **Plume**: Generates drafts with annotations (GPT-4o-mini)
- **Socket.io**: Real-time updates to dashboard
- **PostgreSQL**: Email, draft, and stats storage
- **Bull + Redis**: Queue for async processing

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/kpis` | Daily stats |
| GET | `/api/emails` | List emails |
| POST | `/api/emails/receive` | Receive email |
| GET | `/api/drafts` | List drafts |
| POST | `/api/drafts/:id/validate` | Validate draft |
| DELETE | `/api/drafts/:id` | Reject draft |

## WebSocket Events

- `email:received` - New email arrived
- `draft:created` - Draft generated
- `kpis:update` - Stats updated
