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
      recipients,
      body_text,
      body_html,
      message_id,
      user_id = 'default-user' // Will be determined by routing rules
    } = req.body;

    if (!subject || !sender || !body_text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1. Insert email into Supabase with status 'en_attente'
    const { data: email, error: insertError } = await supabase
      .from('emails')
      .insert({
        user_id: user_id,
        expediteur: sender,
        objet: subject,
        contenu_original: body_text,
        pipeline_step: 'en_attente',
        statut: 'en_attente',
        contexte_choisi: 'standard' // Default context
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ Failed to insert email:', insertError);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log('✅ Email inserted:', email.id);

    // 2. Start AI processing asynchronously
    // This will update pipeline_step in real-time
    processEmailWithAI(email.id, {
      subject,
      sender,
      body: body_text,
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
