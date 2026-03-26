import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import OpenAI from 'openai';
import { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

function parseExpeditor(expediteur: string): { from_name: string; from_email: string } {
  if (!expediteur) return { from_name: '', from_email: '' };
  const match = expediteur.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { from_name: match[1].trim(), from_email: match[2].trim() };
  if (expediteur.includes('@')) return { from_name: '', from_email: expediteur.trim() };
  return { from_name: expediteur.trim(), from_email: '' };
}

const DEFAULT_CLASSIFICATION = {
  email_type: 'autre',
  urgency: 'medium',
  needs_response: false,
  client_name: null,
  opposing_party: null,
  case_reference: null,
  key_dates: [] as string[],
  summary: '',
  suggested_action: '',
  fait_nouveau: '',
};

function safeClassification(raw: any) {
  if (!raw || typeof raw !== 'object') return DEFAULT_CLASSIFICATION;
  return {
    email_type: raw.email_type || 'autre',
    urgency: raw.urgency || 'medium',
    needs_response: typeof raw.needs_response === 'boolean' ? raw.needs_response : false,
    client_name: raw.client_name || null,
    opposing_party: raw.opposing_party || null,
    case_reference: raw.case_reference || null,
    key_dates: Array.isArray(raw.key_dates) ? raw.key_dates : [],
    summary: raw.summary || '',
    suggested_action: raw.suggested_action || '',
    fait_nouveau: raw.fait_nouveau || '',
  };
}

function transformEmail(email: any, dossierMap: Record<string, any>) {
  const parsed = parseExpeditor(email.expediteur);
  const gmailId = email.metadata && email.metadata.gmail_message_id;
  const dossier = dossierMap && email.dossier_id ? dossierMap[email.dossier_id] : null;

  return {
    id: email.id,
    user_id: email.user_id,
    from_name: parsed.from_name,
    from_email: parsed.from_email,
    subject: email.objet || '',
    summary: email.resume || '',
    draft: email.brouillon || '',
    pipeline_step: email.pipeline_step || 'en_attente',
    statut: email.statut || 'en_attente',
    contexte_choisi: email.contexte_choisi || 'standard',
    dossier_id: email.dossier_id || null,
    dossier_name: dossier ? (dossier.nom_client || '') : '',
    dossier_domain: dossier ? (dossier.domaine || '') : '',
    needs_response: email.needs_response || false,
    classification: safeClassification(email.classification),
    date: email.created_at || new Date().toISOString(),
    updated_at: email.updated_at || null,
    gmail_link: gmailId ? 'https://mail.google.com/mail/u/0/#inbox/' + gmailId : '',
    attachments: [] as any[],
  };
}

// GET /api/emails
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(400).json({ error: 'user_id requis' });

    const { data, error } = await supabase
      .from('emails')
      .select('*')
      .eq('user_id', userId)
      .neq('pipeline_step', 'importe')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    const emails = data || [];

    const dossierIds = [...new Set(emails.map((e: any) => e.dossier_id).filter(Boolean))];
    const dossierMap: Record<string, any> = {};
    if (dossierIds.length > 0) {
      const { data: dossiers } = await supabase
        .from('dossiers')
        .select('id, nom_client, domaine')
        .in('id', dossierIds);
      if (dossiers) {
        dossiers.forEach((d: any) => { dossierMap[d.id] = d; });
      }
    }

    const actifs = emails.filter((e: any) => e.pipeline_step !== 'filtre_rejete');
    const filtres = emails.filter((e: any) => e.pipeline_step === 'filtre_rejete');
    const sorted = [...actifs, ...filtres];

    res.json(sorted.map((e: any) => transformEmail(e, dossierMap)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/emails/stats
router.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(400).json({ error: 'user_id requis' });

    const { data: all, error } = await supabase
      .from('emails')
      .select('statut, pipeline_step')
      .eq('user_id', userId)
      .neq('pipeline_step', 'importe');

    if (error) return res.status(500).json({ error: error.message });
    const emails = all || [];
    const actifs = emails.filter((e: any) => e.pipeline_step !== 'filtre_rejete');
    const filtres = emails.filter((e: any) => e.pipeline_step === 'filtre_rejete');

    res.json({
      recus: actifs.length,
      traites: actifs.filter((e: any) => e.statut === 'traite' || e.pipeline_step === 'pret_a_reviser').length,
      valides: actifs.filter((e: any) => e.statut === 'valide').length,
      en_attente: actifs.filter((e: any) => e.statut === 'en_attente').length,
      filtres: filtres.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/emails/:id
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const { data, error } = await supabase
      .from('emails')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .single();

    if (error) return res.status(404).json({ error: error.message });

    const dossierMap: Record<string, any> = {};
    if (data.dossier_id) {
      const { data: dossier } = await supabase
        .from('dossiers')
        .select('id, nom_client, domaine')
        .eq('id', data.dossier_id)
        .single();
      if (dossier) dossierMap[dossier.id] = dossier;
    }

    const transformed = transformEmail(data, dossierMap);

    const { data: docs } = await supabase
      .from('dossier_documents')
      .select('*')
      .eq('email_id', req.params.id);

    transformed.attachments = (docs || []).map((doc: any) => ({
      id: doc.id,
      filename: doc.nom_fichier || '',
      type: doc.type || '',
      date: doc.date_reception || null,
      summary: doc.resume_ia || (doc.contenu_extrait ? doc.contenu_extrait.substring(0, 200) : ''),
      url: doc.storage_url || '',
    }));

    res.json(transformed);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/emails/:id/feedback
router.post('/:id/feedback', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const { action } = req.body;
    const statutMap: Record<string, string> = { parfait: 'valide', modifier: 'traite', erreur: 'erreur' };
    const newStatut = statutMap[action] || 'traite';
    const { data, error } = await supabase
      .from('emails')
      .update({ statut: newStatut, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/emails/:id/draft
router.post('/:id/draft', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const { data: email, error: emailErr } = await supabase
      .from('emails')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .single();
    if (emailErr || !email) return res.status(404).json({ error: 'Email non trouvé' });

    const { data: config } = await supabase
      .from('configurations')
      .select('*')
      .eq('user_id', email.user_id)
      .single();

    const nomAvocat = (config && config.nom_avocat) || "l'avocate";
    const nomCabinet = (config && config.nom_cabinet) || 'le cabinet';
    const specialite = (config && config.specialite) || 'droit général';
    const signature = (config && config.signature) || nomAvocat;

    let dossierContext = '';
    if (email.dossier_id) {
      const { data: dossier } = await supabase
        .from('dossiers')
        .select('*')
        .eq('id', email.dossier_id)
        .single();

      const { data: dossierEmails } = await supabase
        .from('emails')
        .select('expediteur, objet, resume, created_at')
        .eq('dossier_id', email.dossier_id)
        .neq('id', email.id)
        .order('created_at', { ascending: false })
        .limit(10);

      const { data: dossierDocs } = await supabase
        .from('dossier_documents')
        .select('nom_fichier, type, contenu_extrait')
        .eq('dossier_id', email.dossier_id);

      if (dossier) {
        dossierContext += '\n=== DOSSIER CLIENT ===\n';
        dossierContext += 'Client : ' + (dossier.nom_client || 'inconnu') + '\n';
        dossierContext += 'Domaine : ' + (dossier.domaine || 'non précisé') + '\n';
        if (dossier.resume_situation) dossierContext += 'Résumé dossier : ' + dossier.resume_situation + '\n';
      }
      if (dossierEmails && dossierEmails.length > 0) {
        dossierContext += '\n=== EMAILS PRÉCÉDENTS DU DOSSIER ===\n';
        dossierEmails.forEach((e: any, i: number) => {
          const d = e.created_at ? new Date(e.created_at).toLocaleDateString('fr-FR') : '?';
          dossierContext += (i + 1) + '. [' + d + '] De: ' + (e.expediteur || '?') + ' | ' + (e.objet || '') + '\n';
          if (e.resume) dossierContext += '   ' + e.resume.substring(0, 500) + '\n';
        });
      }
      if (dossierDocs && dossierDocs.length > 0) {
        dossierContext += '\n=== DOCUMENTS DU DOSSIER ===\n';
        dossierDocs.forEach((doc: any) => {
          dossierContext += '- ' + (doc.nom_fichier || 'sans nom') + ' (' + (doc.type || '?') + ')\n';
          if (doc.contenu_extrait) dossierContext += '  Extrait: ' + doc.contenu_extrait.substring(0, 500) + '\n';
        });
      }
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = "Tu es Donna, l'assistante juridique IA de " + nomAvocat + ', cabinet ' + nomCabinet + ', spécialisé en ' + specialite + '.\n' +
      'Tu rédiges un brouillon de réponse professionnel pour cet email.\n\n' +
      'RÈGLES :\n' +
      "- Utilise le ton et le style de l'avocate (signature fournie)\n" +
      '- Base-toi UNIQUEMENT sur le contexte du dossier et les documents fournis\n' +
      "- Ne cite JAMAIS de jurisprudence ou article de loi sauf si présent dans les documents\n" +
      "- Si une information manque, indique [À COMPLÉTER] plutôt que d'inventer\n" +
      "- Commence par la formule d'appel appropriée\n" +
      "- Termine par la signature de l'avocate\n\n" +
      'FORMAT :\n' +
      "[Formule d'appel],\n\n" +
      '[Corps du brouillon]\n\n' +
      '[Formule de politesse],\n' +
      '[Signature]';

    const userPrompt = '=== EMAIL REÇU ===\n' +
      'De : ' + (email.expediteur || 'inconnu') + '\n' +
      'Objet : ' + (email.objet || '(sans objet)') + '\n' +
      'Résumé : ' + (email.resume || 'non disponible') + '\n' +
      'Contenu analysé : ' + (email.brouillon || 'non disponible') + '\n' +
      dossierContext + '\n' +
      '=== CONFIG CABINET ===\n' +
      'Avocate : ' + nomAvocat + '\n' +
      'Cabinet : ' + nomCabinet + '\n' +
      'Spécialité : ' + specialite + '\n' +
      'Signature : ' + signature + '\n\n' +
      '=== INSTRUCTION ===\n' +
      'Rédige un brouillon de réponse professionnel à cet email.';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      store: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const draft = completion.choices[0].message.content || '';

    const updatedBrouillon = (email.brouillon || '') + '\n\n---\nBrouillon de réponse :\n\n' + draft;
    await supabase
      .from('emails')
      .update({ brouillon: updatedBrouillon, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ draft });
  } catch (e: any) {
    console.error('Erreur génération brouillon:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
