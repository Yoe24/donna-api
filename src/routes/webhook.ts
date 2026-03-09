import { Router } from 'express';
import { supabase } from '../config/supabase';
import { processEmailWithAI } from '../services/ai-processor';

const router = Router();

// Webhook endpoint for AgentMail.to
router.post('/webhook', async (req, res) => {
  console.log('📨 Webhook received from AgentMail:', req.body);

  try {
    const { 
      subject,
      sender,
      body_text,
      user_id = '00000000-0000-0000-0000-000000000001'
    } = req.body;

    if (!subject || !sender) {
      return res.status(400).json({ error: 'Missing required fields (subject, sender)' });
    }

    // 1. Insert email into Supabase - ADAPTÉ sans contenu_original
    const { data: email, error: insertError } = await supabase
      .from('emails')
      .insert({
        user_id: user_id,
        expediteur: sender,
        objet: subject,
        resume: null,
        brouillon: null,
        pipeline_step: 'en_attente',
        statut: 'en_attente',
        contexte_choisi: 'standard'
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ Failed to insert email:', insertError);
      return res.status(500).json({ error: 'Database error: ' + insertError.message });
    }

    console.log('✅ Email inserted:', email.id);

    // 2. Start AI processing asynchronously
    processEmailWithAI(email.id, {
      subject,
      sender,
      body: body_text || '',
      userId: user_id
    }).catch(err => {
      console.error('❌ AI processing error:', err);
    });

    // 3. Return immediately (async processing)
    res.json({ 
      success: true, 
      message: 'Email received and processing started',
      email_id: email.id 
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
