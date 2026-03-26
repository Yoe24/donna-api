import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { generateBrief } from '../services/brief-generator';
import { AuthenticatedRequest } from '../middleware/auth';

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

// === HELPER: compute stats for a given cutoff date
async function computeStatsForPeriod(userId: string, cutoffDate: string): Promise<any> {
  let dossierEmailCount = 0;
  let generalEmailCount = 0;
  let attachmentsCount = 0;

  // Emails avec dossier_id non null
  const { data: dossierEmails } = await supabase
    .from('emails')
    .select('id')
    .eq('user_id', userId)
    .not('dossier_id', 'is', null)
    .gte('created_at', cutoffDate);
  dossierEmailCount = (dossierEmails || []).length;

  // Emails avec dossier_id null (hors pipeline_step='importe')
  const { data: generalEmails } = await supabase
    .from('emails')
    .select('id')
    .eq('user_id', userId)
    .is('dossier_id', null)
    .neq('pipeline_step', 'importe')
    .gte('created_at', cutoffDate);
  generalEmailCount = (generalEmails || []).length;

  // Documents count
  const { data: dossiers } = await supabase
    .from('dossiers')
    .select('id')
    .eq('user_id', userId);

  if (dossiers && dossiers.length > 0) {
    const dossierIds = dossiers.map((d: any) => d.id);
    const { data: docs } = await supabase
      .from('dossier_documents')
      .select('id')
      .in('dossier_id', dossierIds);
    attachmentsCount = (docs || []).length;
  }

  return {
    total: dossierEmailCount + generalEmailCount,
    dossier_emails: dossierEmailCount,
    general_emails: generalEmailCount,
    attachments_count: attachmentsCount,
  };
}

// === HELPER: get dossier IDs that have emails within a cutoff
async function getDossierIdsForPeriod(userId: string, cutoffDate: string): Promise<string[]> {
  const { data: emails } = await supabase
    .from('emails')
    .select('dossier_id')
    .eq('user_id', userId)
    .not('dossier_id', 'is', null)
    .gte('created_at', cutoffDate);

  if (!emails || emails.length === 0) return [];

  // Unique dossier IDs
  const ids: Record<string, boolean> = {};
  emails.forEach((e: any) => { ids[e.dossier_id] = true; });
  return Object.keys(ids);
}

// === ADAPTER: enrichir le brief avec les stats et le format attendu par le frontend
async function transformBrief(brief: any): Promise<any> {
  if (!brief || !brief.content) return brief;

  const content = brief.content;
  const userId = brief.user_id;

  // Cutoffs pour les 3 periodes
  const now = Date.now();
  const cutoff24h = new Date(now - 1 * 24 * 3600 * 1000).toISOString();
  const cutoff7d  = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const cutoff30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();

  // Calculer les stats pour les 3 periodes en parallele
  let stats24h  = { total: 0, dossier_emails: 0, general_emails: 0, attachments_count: 0 };
  let stats7d   = { total: 0, dossier_emails: 0, general_emails: 0, attachments_count: 0 };
  let stats30d  = { total: 0, dossier_emails: 0, general_emails: 0, attachments_count: 0 };

  if (userId) {
    const results = await Promise.all([
      computeStatsForPeriod(userId, cutoff24h),
      computeStatsForPeriod(userId, cutoff7d),
      computeStatsForPeriod(userId, cutoff30d),
    ]);
    stats24h = results[0];
    stats7d  = results[1];
    stats30d = results[2];
  }

  // Transformer stats -- garantir que stats existe toujours avec des valeurs sures
  if (!content.stats) content.stats = {};
  content.stats.emails_analyzed = content.stats.emails_analyzed || 0;
  content.stats.total_emails = content.stats.emails_analyzed;
  content.stats.dossiers_count = content.stats.dossiers_count || 0;
  content.stats.needs_response_count = content.stats.needs_response_count || 0;
  content.stats.deadline_soon_count = content.stats.deadline_soon_count || 0;
  // Retro-compatibilite: valeurs 30j
  content.stats.dossier_emails = stats30d.dossier_emails;
  content.stats.general_emails = stats30d.general_emails;
  content.stats.attachments_count = stats30d.attachments_count;
  content.stats.relances_count = 0;

  // Stats par periode
  content.stats.last_24h = stats24h;
  content.stats.last_7d  = stats7d;
  content.stats.last_30d = stats30d;

  // Garantir executive_summary
  content.executive_summary = content.executive_summary || '';
  content.is_first_brief = content.is_first_brief || false;

  // Recuperer les dossier_ids actifs par periode (en parallele)
  let activeDossierIds24h: string[] = [];
  let activeDossierIds7d: string[]  = [];
  let activeDossierIds30d: string[] = [];

  if (userId) {
    const dossierIdResults = await Promise.all([
      getDossierIdsForPeriod(userId, cutoff24h),
      getDossierIdsForPeriod(userId, cutoff7d),
      getDossierIdsForPeriod(userId, cutoff30d),
    ]);
    activeDossierIds24h = dossierIdResults[0];
    activeDossierIds7d  = dossierIdResults[1];
    activeDossierIds30d = dossierIdResults[2];
  }

  // Transformer chaque dossier dans le brief -- garantir des valeurs par defaut sures
  if (!Array.isArray(content.dossiers)) content.dossiers = [];
  for (let i = 0; i < content.dossiers.length; i++) {
    const d = content.dossiers[i];
    d.name = d.nom || d.name || '';
    d.nom = d.nom || d.name || '';
    d.summary = d.summary || '';
    d.dates_cles = Array.isArray(d.dates_cles) ? d.dates_cles : [];
    d.emails_recus = Array.isArray(d.emails_recus) ? d.emails_recus : [];
    d.new_emails_count = d.new_emails_count || 0;
    d.needs_immediate_attention = d.needs_immediate_attention || false;
    d.dossier_id = d.dossier_id || null;

    // Charger les emails du dossier pour inclure from_name, from_email, subject, date, summary
    if (d.dossier_id) {
      const { data: dossierEmailsList } = await supabase
        .from('emails')
        .select('expediteur, objet, created_at, resume')
        .eq('dossier_id', d.dossier_id)
        .order('created_at', { ascending: false })
        .limit(10);

      d.emails = (dossierEmailsList || []).map((e: any) => {
        const parsed = parseExpeditor(e.expediteur);
        return {
          from_name: parsed.from_name,
          from_email: parsed.from_email,
          subject: e.objet || '',
          date: e.created_at || '',
          summary: e.resume || '',
        };
      });
    } else {
      d.emails = Array.isArray(d.emails) ? d.emails : [];
    }

    content.dossiers[i] = d;
  }

  // emails_by_period: dossier IDs actifs par periode pour filtrage frontend
  content.emails_by_period = {
    last_24h: activeDossierIds24h,
    last_7d:  activeDossierIds7d,
    last_30d: activeDossierIds30d,
  };

  brief.content = content;
  return brief;
}

// GET /api/briefs/today
router.get('/today', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('briefs')
      .select('*')
      .eq('user_id', userId)
      .eq('brief_date', today)
      .single();

    if (data && !error) {
      const transformed = await transformBrief(data);
      return res.json(transformed);
    }

    // Pas de brief aujourd'hui -- en generer un automatiquement (24h)
    console.log('Aucun brief aujourd\'hui pour', userId, '-- generation automatique (24h)');
    const brief = await generateBrief(userId, 1);
    const transformedBrief = await transformBrief(brief);
    res.json(transformedBrief);
  } catch (err: any) {
    console.error('GET /api/briefs/today:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/briefs/generate
router.post('/generate', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const periodDays = parseInt(req.query.period_days as string || req.body.period_days) || 1;

    console.log('Brief generation requested for:', userId, '| period:', periodDays, 'days');
    const brief = await generateBrief(userId, periodDays);
    const transformed = await transformBrief(brief);
    res.json(transformed);
  } catch (err: any) {
    console.error('POST /api/briefs/generate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
