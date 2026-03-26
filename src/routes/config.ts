import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';

const router = Router();

// === ADAPTER: garantir des valeurs par defaut sures pour le frontend
function transformConfig(data: any): any {
  if (!data) return data;
  return {
    id: data.id,
    user_id: data.user_id,
    nom_avocat: data.nom_avocat || '',
    nom_cabinet: data.nom_cabinet || '',
    specialite: data.specialite || '',
    signature: data.signature || '',
    profil_style: data.profil_style || '',
    formule_appel: data.formule_appel || 'cher_maitre',
    formule_politesse: data.formule_politesse || 'cordialement',
    ton_reponse: data.ton_reponse || 50,
    niveau_concision: data.niveau_concision || 50,
    email_exemples: Array.isArray(data.email_exemples) ? data.email_exemples : [],
    sources_favorites: Array.isArray(data.sources_favorites) ? data.sources_favorites : [],
    // SECURITE : refresh_token JAMAIS expose au frontend
    gmail_connected: !!data.refresh_token,
    gmail_last_check: data.gmail_last_check || null,
    updated_at: data.updated_at || null,
  };
}

// GET /api/config
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.query.user_id as string;
    if (!userId) return res.status(400).json({ error: 'user_id requis' });

    const { data, error } = await supabase
      .from('configurations')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      console.error('GET /api/config:', error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json(transformConfig(data));
  } catch (err: any) {
    console.error('GET /api/config exception:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/config
router.put('/', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.user_id as string) || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id requis' });

    // SECURITE : ne jamais laisser le frontend ecrire refresh_token
    const body: any = { ...req.body, user_id: userId };
    delete body.refresh_token;

    const { data, error } = await supabase
      .from('configurations')
      .upsert(body, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      console.error('PUT /api/config:', error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json(transformConfig(data));
  } catch (err: any) {
    console.error('PUT /api/config exception:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
