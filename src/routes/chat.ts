import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import OpenAI from 'openai';

const router = Router();

// POST /api/chat
router.post('/', async (req: Request, res: Response) => {
  try {
    const { message, history, user_id } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });
    const userId = user_id || (req.query.user_id as string);
    if (!userId) return res.status(400).json({ error: 'user_id requis' });

    // 1. Recuperer la config cabinet
    const { data: config } = await supabase
      .from('configurations')
      .select('*')
      .eq('user_id', userId)
      .single();

    const nomAvocat = (config && config.nom_avocat) || "l'avocate";
    const nomCabinet = (config && config.nom_cabinet) || 'le cabinet';
    const specialite = (config && config.specialite) || 'droit general';

    // 2. Recuperer les dossiers en cours (max 20)
    const { data: dossiers } = await supabase
      .from('dossiers')
      .select('nom_client, email_client, domaine, resume_situation')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    let dossiersContext = 'Aucun dossier en cours.';
    if (dossiers && dossiers.length > 0) {
      dossiersContext = dossiers.map((d: any, i: number) => {
        return (i + 1) + '. ' + (d.nom_client || 'Client inconnu') +
          (d.email_client ? ' (' + d.email_client + ')' : '') +
          ' — ' + (d.domaine || 'domaine non precise') +
          (d.resume_situation ? '\n   ' + d.resume_situation.substring(0, 200) : '');
      }).join('\n');
    }

    // 3. Recuperer les 10 derniers emails traites
    const { data: emails } = await supabase
      .from('emails')
      .select('expediteur, objet, resume, pipeline_step')
      .eq('user_id', userId)
      .neq('pipeline_step', 'importe')
      .order('created_at', { ascending: false })
      .limit(10);

    let emailsContext = 'Aucun email recent.';
    if (emails && emails.length > 0) {
      emailsContext = emails.map((e: any, i: number) => {
        return (i + 1) + '. De: ' + (e.expediteur || '?') +
          ' | ' + (e.objet || '(sans objet)') +
          ' [' + (e.pipeline_step || '?') + ']' +
          (e.resume ? '\n   ' + e.resume.substring(0, 150) : '');
      }).join('\n');
    }

    // 4. Construire le system prompt
    let systemPrompt = 'Tu es Donna, l\'employee numerique de ' + nomAvocat + ' au ' + nomCabinet + ', specialise en ' + specialite + '.\n' +
      'Tu es chaleureuse, professionnelle et tu tutoies l\'avocate car tu es son assistante de confiance.\n\n' +
      'TON ROLE :\n' +
      '- Repondre aux questions sur les dossiers clients\n' +
      '- Aider a comprendre les emails recus\n' +
      '- Guider l\'avocate dans l\'utilisation de la plateforme\n' +
      '- Donner des informations sur les dossiers en cours\n\n' +
      'CONTEXTE ACTUEL :\n' +
      'Dossiers en cours :\n' + dossiersContext + '\n\n' +
      'Derniers emails traites :\n' + emailsContext + '\n\n' +
      'REGLES :\n' +
      '- Ne cite JAMAIS de jurisprudence ou article de loi sauf si present dans les dossiers\n' +
      '- Si tu ne sais pas, dis-le clairement\n' +
      '- Si on te demande une info qui n\'est pas dans tes donnees, propose de verifier\n' +
      '- Sois concise et actionnable\n' +
      '- Si c\'est la premiere interaction (history vide), presente-toi brievement et explique ce que tu sais faire';

    if (config && config.profil_style) {
      systemPrompt += '\n\nPROFIL DE STYLE :\n' + config.profil_style;
    }

    // 5. Construire les messages pour GPT
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    if (history && Array.isArray(history)) {
      history.forEach((h: any) => {
        if (h.role && h.content) {
          messages.push({ role: h.role, content: h.content });
        }
      });
    }

    messages.push({ role: 'user', content: message });

    // 6. Appeler GPT-4o
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      store: false,
      messages: messages as any,
      temperature: 0.5,
      max_tokens: 1000,
    });

    const response = completion.choices[0].message.content || 'Desolee, je n\'ai pas pu formuler de reponse.';
    console.log('Chat Donna: reponse generee, longueur:', response.length);

    res.json({ response });
  } catch (e: any) {
    console.error('Erreur chat Donna:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
