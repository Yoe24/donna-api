import { Router } from 'express';
import { Server } from 'socket.io';
import { EmailModel, DraftModel, StatsModel } from '../models';
import { classifyEmail, generateDraft } from '../services/llm';
import pool from '../config/database';

const router = Router();

// POST /api/emails/receive - Main endpoint for incoming emails
export function createEmailRoutes(io: Server) {
  const emailModel = new EmailModel(pool);
  const draftModel = new DraftModel(pool);
  const statsModel = new StatsModel(pool);

  router.post('/receive', async (req, res) => {
    try {
      const { from, to, subject, body, bodyHtml, rawEmail } = req.body;

      if (!from || !subject || !body) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      console.log(`📧 Received email from ${from}: ${subject}`);

      // 1. Classify email with Facteur
      const classification = await classifyEmail(subject, body);
      console.log(`🏷️ Classified as ${classification.category} (${classification.confidence})`);

      // 2. Save email to DB
      const email = await emailModel.create({
        from_email: from,
        to_email: to || 'donna-legale@donna.ai',
        subject,
        body,
        body_html: bodyHtml,
        category: classification.category,
        confidence: classification.confidence,
        raw_email: rawEmail,
      });

      // 3. Update stats
      await statsModel.incrementEmails();

      // 4. Broadcast to connected clients
      io.emit('email:received', email);

      // 5. If professional email, generate draft with Plume
      let draft = null;
      if (classification.category === 'pro_action') {
        console.log('✍️ Generating draft...');
        
        const draftResult = await generateDraft(subject, body, from, 'formal');
        
        draft = await draftModel.create({
          email_id: email.id,
          to_email: draftResult.to,
          subject: draftResult.subject,
          body: draftResult.body,
          annotations: draftResult.annotations,
          status: 'draft',
        });

        await statsModel.incrementDrafts();
        
        // Broadcast draft created
        io.emit('draft:created', draft);
        console.log('✅ Draft created and broadcasted');
      }

      // 6. Broadcast updated KPIs
      const kpis = await statsModel.getCurrentStats();
      io.emit('kpis:update', kpis);

      res.json({
        success: true,
        email,
        draft,
        classification,
      });
    } catch (error) {
      console.error('Error processing email:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const emails = await emailModel.findRecent(50);
      res.json(emails);
    } catch (error) {
      console.error('Error fetching emails:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default router;
