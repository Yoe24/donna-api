import { Router } from 'express';
import { StatsModel } from '../models';
import pool from '../config/database';

const router = Router();

const statsModel = new StatsModel(pool);

// GET /api/kpis - Get current KPIs
router.get('/', async (req, res) => {
  try {
    const stats = await statsModel.getCurrentStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching KPIs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
