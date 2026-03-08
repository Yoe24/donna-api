import { Router } from 'express';

const router = Router();

// Health check
router.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'donna-mvp',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

export default router;
