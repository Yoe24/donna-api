import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';

const router = Router();

// === ADAPTER: parse expediteur -> from_name, from_email
function parseExpeditor(expediteur: string | null): { from_name: string; from_email: string } {
  if (!expediteur) return { from_name: '', from_email: '' };
  const match = expediteur.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { from_name: match[1].trim(), from_email: match[2].trim() };
  }
  if (expediteur.includes('@')) {
    return { from_name: '', from_email: expediteur.trim() };
  }
  return { from_name: expediteur.trim(), from_email: '' };
}

// === ADAPTER: transformer un dossier Supabase -> format frontend Lovable
function transformDossier(dossier: any, emailCount: number, documentCount: number): any {
  return {
    id: dossier.id,
    user_id: dossier.user_id,
    name: dossier.nom_client || '',
    email_client: dossier.email_client || '',
    domain: dossier.domaine || '',
    summary: dossier.resume_situation || '',
    status: dossier.statut || 'actif',
    last_exchange: dossier.dernier_echange_date || null,
    created_at: dossier.created_at,
    email_count: emailCount || 0,
    document_count: documentCount || 0,
  };
}

// GET /api/dossiers
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) return res.status(400).json({ error: 'user_id requis' });

    const { data, error } = await supabase
      .from('dossiers')
      .select('*')
      .eq('user_id', userId)
      .order('dernier_echange_date', { ascending: false });

    if (error) {
      console.error('GET /api/dossiers:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const dossiers = data || [];
    if (dossiers.length === 0) return res.json([]);

    // Batch: compter emails et documents par dossier
    const dossierIds = dossiers.map((d: any) => d.id);

    // Compter les emails par dossier_id
    const { data: emailRows } = await supabase
      .from('emails')
      .select('dossier_id')
      .in('dossier_id', dossierIds);

    const emailCounts: Record<string, number> = {};
    (emailRows || []).forEach((r: any) => {
      emailCounts[r.dossier_id] = (emailCounts[r.dossier_id] || 0) + 1;
    });

    // Compter les documents par dossier_id
    const { data: docRows } = await supabase
      .from('dossier_documents')
      .select('dossier_id')
      .in('dossier_id', dossierIds);

    const docCounts: Record<string, number> = {};
    (docRows || []).forEach((r: any) => {
      docCounts[r.dossier_id] = (docCounts[r.dossier_id] || 0) + 1;
    });

    const result = dossiers.map((d: any) => {
      return transformDossier(d, emailCounts[d.id] || 0, docCounts[d.id] || 0);
    });

    res.json(result);
  } catch (err: any) {
    console.error('GET /api/dossiers exception:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/dossiers/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('dossiers')
      .select('*, emails(*), dossier_documents(*)')
      .eq('id', req.params.id)
      .eq('user_id', (req.query.user_id as string) || '')
      .single();

    if (error) {
      console.error('GET /api/dossiers/:id:', error.message);
      return res.status(404).json({ error: error.message });
    }

    const rawEmails: any[] = data.emails || [];
    const rawDocs: any[] = data.dossier_documents || [];

    // Transformer le dossier
    const transformed: any = transformDossier(data, rawEmails.length, rawDocs.length);

    // Transformer les emails imbriques
    transformed.emails = rawEmails
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((e: any) => {
        const parsed = parseExpeditor(e.expediteur);
        return {
          id: e.id,
          from_name: parsed.from_name,
          from_email: parsed.from_email,
          subject: e.objet || '',
          summary: e.resume || '',
          date: e.created_at || '',
          pipeline_step: e.pipeline_step || 'en_attente',
          statut: e.statut || 'en_attente',
        };
      });

    // Transformer les documents
    transformed.documents = rawDocs.map((doc: any) => {
      return {
        id: doc.id,
        filename: doc.nom_fichier || '',
        type: doc.type || '',
        date: doc.date_reception || null,
        summary: doc.resume_ia || (doc.contenu_extrait ? doc.contenu_extrait.substring(0, 200) : ''),
        url: doc.storage_url || '',
      };
    });

    res.json(transformed);
  } catch (err: any) {
    console.error('GET /api/dossiers/:id exception:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
