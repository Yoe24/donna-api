import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { AuthenticatedRequest } from '../middleware/auth';

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
    ton_reponse: typeof data.ton_reponse === 'number'
      ? (data.ton_reponse <= 30 ? 'formel' : data.ton_reponse >= 70 ? 'conversationnel' : 'equilibre')
      : (data.ton_reponse || 'equilibre'),
    niveau_concision: data.niveau_concision || 50,
    email_exemples: Array.isArray(data.email_exemples) ? data.email_exemples : [],
    sources_favorites: Array.isArray(data.sources_favorites) ? data.sources_favorites : [],
    // SECURITE : refresh_token JAMAIS expose au frontend
    gmail_connected: !!data.refresh_token,
    gmail_needs_reconnect: !!data.gmail_needs_reconnect,
    gmail_last_check: data.gmail_last_check || null,
    updated_at: data.updated_at || null,
  };
}

// GET /api/config
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const { data, error } = await supabase
      .from('configurations')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      console.error('GET /api/config:', error.message);
      return res.status(500).json({ error: error.message });
    }
    // Add user email from auth
    let userEmail = '';
    try {
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      userEmail = (userData as any)?.user?.email || '';
    } catch {}
    const transformed = transformConfig(data);
    transformed.user_email = userEmail;
    res.json(transformed);
  } catch (err: any) {
    console.error('GET /api/config exception:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/config
router.put('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    // SECURITE : ne jamais laisser le frontend ecrire refresh_token
    const body: any = { ...req.body, user_id: userId };
    delete body.refresh_token;

    // ton_reponse: frontend sends string, DB expects integer
    if (typeof body.ton_reponse === 'string') {
      const tonMap: Record<string, number> = { formel: 20, equilibre: 50, conversationnel: 80 };
      body.ton_reponse = tonMap[body.ton_reponse] ?? 50;
    }

    // Use update (row exists after onboarding) with insert fallback
    const { data: existing } = await supabase
      .from('configurations')
      .select('user_id')
      .eq('user_id', userId)
      .single();

    let data, error;
    if (existing) {
      const result = await supabase
        .from('configurations')
        .update(body)
        .eq('user_id', userId)
        .select()
        .single();
      data = result.data;
      error = result.error;
    } else {
      const result = await supabase
        .from('configurations')
        .insert(body)
        .select()
        .single();
      data = result.data;
      error = result.error;
    }

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
