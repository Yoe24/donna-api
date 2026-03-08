# Frontend Integration Guide

## WebSocket Connection

```typescript
import { io } from 'socket.io-client';

const socket = io('https://your-api-render.com');

// Connection events
socket.on('connect', () => {
  console.log('Connected to Donna');
});

socket.on('disconnect', () => {
  console.log('Disconnected from Donna');
});
```

## Real-time Events

### Email Received
```typescript
socket.on('email:received', (email) => {
  // Add to email list
  setEmails(prev => [email, ...prev]);
  
  // Update KPI
  setKpis(prev => ({
    ...prev,
    emails_received: prev.emails_received + 1
  }));
});
```

### Draft Created
```typescript
socket.on('draft:created', (draft) => {
  // Add to drafts list
  setDrafts(prev => [draft, ...prev]);
  
  // Update KPI
  setKpis(prev => ({
    ...prev,
    drafts_created: prev.drafts_created + 1
  }));
});
```

### KPIs Update
```typescript
socket.on('kpis:update', (stats) => {
  setKpis({
    emails_received: stats.emails_received,
    drafts_created: stats.drafts_created,
    drafts_validated: stats.drafts_validated,
    time_saved_minutes: stats.time_saved_minutes
  });
});
```

## Button Actions

### Copy Draft
```typescript
const handleCopy = async (draftBody: string) => {
  await navigator.clipboard.writeText(draftBody);
  // Show success toast
};
```

### Validate Draft
```typescript
const handleValidate = async (draftId: string) => {
  const response = await fetch(
    `https://your-api-render.com/api/drafts/${draftId}/validate`,
    { method: 'POST' }
  );
  
  if (response.ok) {
    // Update local state
    setDrafts(prev => 
      prev.map(d => d.id === draftId ? { ...d, status: 'validated' } : d)
    );
  }
};
```

### Reject Draft
```typescript
const handleReject = async (draftId: string) => {
  const response = await fetch(
    `https://your-api-render.com/api/drafts/${draftId}`,
    { method: 'DELETE' }
  );
  
  if (response.ok) {
    // Remove from local state
    setDrafts(prev => prev.filter(d => d.id !== draftId));
  }
};
```

## Initial Data Load

```typescript
useEffect(() => {
  // Load initial data
  const loadData = async () => {
    const [emailsRes, draftsRes, kpisRes] = await Promise.all([
      fetch('https://your-api-render.com/api/emails'),
      fetch('https://your-api-render.com/api/drafts'),
      fetch('https://your-api-render.com/api/kpis')
    ]);
    
    setEmails(await emailsRes.json());
    setDrafts(await draftsRes.json());
    setKpis(await kpisRes.json());
  };
  
  loadData();
}, []);
```

## Annotation Display

```typescript
interface Annotation {
  type: 'source' | 'warning' | 'info' | 'deadline';
  text: string;
  confidence?: number;
  severity?: 'low' | 'medium' | 'high';
  ref: string;
}

const AnnotationBadge = ({ annotation }: { annotation: Annotation }) => {
  const colors = {
    source: 'bg-blue-100 text-blue-800',
    warning: 'bg-red-100 text-red-800',
    info: 'bg-gray-100 text-gray-800',
    deadline: 'bg-yellow-100 text-yellow-800'
  };
  
  return (
    <span className={`px-2 py-1 rounded text-sm ${colors[annotation.type]}`}>
      {annotation.ref} {annotation.text}
    </span>
  );
};
```
