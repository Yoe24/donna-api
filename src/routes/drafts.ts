import { Router } from 'express';
import { Server } from 'socket.io';
import { DraftModel, StatsModel } from '../models';
import pool from '../config/database';

const router = Router();

export function createDraftRoutes(io: Server) {
  const draftModel = new DraftModel(pool);
  const statsModel = new StatsModel(pool);

  // GET /api/drafts - List recent drafts
  router.get('/', async (req, res) => {
    try {
      const drafts = await draftModel.findRecent(50);
      res.json(drafts);
    } catch (error) {
      console.error('Error fetching drafts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/drafts/:id/validate - Mark draft as validated
  router.post('/:id/validate', async (req, res) => {
    try {
      const { id } = req.params;
      const draft = await draftModel.validate(id);
      
      if (!draft) {
        return res.status(404).json({ error: 'Draft not found' });
      }

      await statsModel.incrementValidated();
      
      // Broadcast update
      const kpis = await statsModel.getCurrentStats();
      io.emit('kpis:update', kpis);

      res.json({ success: true, draft });
    } catch (error) {
      console.error('Error validating draft:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/drafts/:id - Delete/reject draft
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await draftModel.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Draft not found' });
      }

      // Broadcast update
      const kpis = await statsModel.getCurrentStats();
      io.emit('kpis:update', kpis);

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting draft:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default router;
