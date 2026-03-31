import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { importGmail } from '../services/agents/agent-importer';
import { generateBrief } from '../services/brief-generator';
import { mergeDossiers } from '../services/dossier-merger';
import { supabase } from '../config/supabase';
import { randomBytes } from 'crypto';

const router = Router();

const REDIRECT_URI = 'https://api.donna-legal.com/api/import/callback';

function createOAuthClient(): any {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

// Etat en memoire
let importState: any = { status: 'idle', processed: 0, total: 0, dossiers_created: 0, last_result: null };

// GET /api/import/gmail/auth
router.get('/gmail/auth', (req: Request, res: Response) => {
  if (importState.status === 'running') {
    return res.status(409).json({ error: 'Import deja en cours' });
  }
  const oauth2Client = createOAuthClient();
  const auth_url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
  res.json({ auth_url });
});

// GET /api/import/callback
router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).json({ error: 'code manquant' });
  }
  if (importState.status === 'running') {
    return res.status(409).json({ error: 'Import deja en cours' });
  }

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // 1. Recuperer le profil Google
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    console.log('Profil Google:', profile.email, profile.name);

    // 2. Chercher ou creer l'utilisateur Supabase
    let userId: string | null = null;
    try {
      // Chercher un utilisateur existant par email
      const { data: listData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const existingUser = (listData && (listData as any).users || []).find((u: any) => {
        return u.email === profile.email;
      });

      if (existingUser) {
        userId = existingUser.id;
        console.log('Utilisateur Supabase existant:', userId);
      } else {
        // Creer le compte automatiquement
        const tempPassword = randomBytes(32).toString('hex');
        const { data: newUserData, error: createErr } = await supabase.auth.admin.createUser({
          email: profile.email!,
          password: tempPassword,
          email_confirm: true,
          user_metadata: {
            full_name: profile.name || '',
            avatar_url: profile.picture || '',
          },
        });
        if (createErr) {
          console.error('Erreur creation utilisateur:', createErr.message);
        } else {
          userId = (newUserData as any).user.id;
          console.log('Utilisateur Supabase cree:', userId, profile.email);
        }
      }
    } catch (authErr: any) {
      console.error('Erreur auth Supabase:', authErr.message);
    }

    if (!userId) {
      console.error('Impossible de determiner le user_id');
      return res.status(500).json({ error: 'Impossible de creer ou trouver l\'utilisateur' });
    }

    // 3. Creer une entree configurations si elle n'existe pas
    const { data: existingConfig } = await supabase
      .from('configurations')
      .select('id, refresh_token')
      .eq('user_id', userId)
      .single();

    if (!existingConfig) {
      const { data: newConfig, error: configErr } = await supabase
        .from('configurations')
        .insert({
          user_id: userId,
          nom_avocat: profile.name || '',
          refresh_token: tokens.refresh_token || null,
        })
        .select()
        .single();
      if (configErr) {
        console.error('Erreur creation config:', configErr.message, (configErr as any).details || '', (configErr as any).hint || '');
      } else {
        console.log('Configuration creee pour', profile.email, '-- id:', newConfig.id);
      }
    }

    // 3b. Sauvegarder le refresh_token des qu'on l'a, peu importe le cas
    if (tokens.refresh_token && userId) {
      await supabase.from('configurations').update({ refresh_token: tokens.refresh_token }).eq('user_id', userId);
      console.log('Refresh token sauvegarde pour', userId);
    }

    // 4. Verifier si utilisateur existant avec refresh_token
    const isReturningUser = existingConfig && (existingConfig as any).refresh_token;

    if (isReturningUser) {
      // Utilisateur existant : mettre a jour le refresh_token si nouveau, pas d'import
      console.log('Utilisateur existant, redirection directe vers dashboard');

      if (tokens.refresh_token) {
        const { error: rtError } = await supabase
          .from('configurations')
          .update({ refresh_token: tokens.refresh_token })
          .eq('user_id', userId);
        if (rtError) {
          console.error('Erreur mise a jour refresh_token:', rtError.message);
        } else {
          console.log('Refresh token mis a jour pour', profile.email);
        }
      }

      // Mettre a jour nom_avocat si vide (pour les utilisateurs existants)
      if (profile.name) {
        const { data: cfg } = await supabase.from('configurations').select('nom_avocat').eq('user_id', userId).single();
        if (cfg && !cfg.nom_avocat) {
          await supabase.from('configurations').update({ nom_avocat: profile.name }).eq('user_id', userId);
          console.log('nom_avocat mis a jour depuis profil Google:', profile.name);
        }
      }

      // Check if user has 0 emails — trigger import if so (fresh start)
      const { data: emailCheck } = await supabase.from('emails').select('id').eq('user_id', userId).limit(1);
      if (!emailCheck || emailCheck.length === 0) {
        console.log('Utilisateur existant mais 0 emails — lancement import complet');
        importState = { status: 'running', processed: 0, total: 0, dossiers_created: 0, attachments_count: 0, last_result: null };

        // Reset gmail_last_check for full import
        await supabase.from('configurations').update({ gmail_last_check: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString() }).eq('user_id', userId);

        const { importGmail } = require('../services/agents/agent-importer');
        importGmail({
          oauthToken: tokens.access_token || '',
          userId,
          onProgress: (progress: any) => {
            importState.processed = progress.processed;
            importState.total = progress.total;
            importState.dossiers_created = progress.dossiers_created;
            importState.attachments_count = progress.attachments_count || 0;
          },
        }).then((result: any) => {
          importState.status = 'done';
          importState.last_result = result;
          importState.progress = 100;
          console.log('Import termine:', JSON.stringify(result));
        }).catch((err: any) => {
          importState.status = 'error';
          console.error('Import error:', err.message);
        });

        const redirectUrl = 'https://www.donna-legal.com/onboarding?import=started&user_id=' + userId;
        res.redirect(redirectUrl);
      } else {
        importState = { status: 'completed', processed: 0, total: 0, dossiers_created: 0, last_result: null };
        const redirectUrl = 'https://www.donna-legal.com/dashboard?user_id=' + userId;
        res.redirect(redirectUrl);
      }
    } else {
      // Premiere connexion : sauvegarder le refresh_token et lancer l'import

      // 4b. Sauvegarder le refresh_token pour le polling continu
      if (tokens.refresh_token) {
        const { error: rtError } = await supabase
          .from('configurations')
          .update({ refresh_token: tokens.refresh_token })
          .eq('user_id', userId);
        if (rtError) {
          console.error('Erreur sauvegarde refresh_token:', rtError.message);
        } else {
          console.log('Refresh token sauvegarde pour', profile.email);
        }
      }

      // 5. Generer un lien magique pour la session frontend
      let sessionToken = '';
      try {
        const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: profile.email!,
        });
        if (linkErr) {
          console.error('Erreur generation magic link:', linkErr.message);
        } else if (linkData && (linkData as any).properties) {
          sessionToken = (linkData as any).properties.hashed_token || '';
          console.log('Magic link genere pour', profile.email);
        }
      } catch (linkGenErr: any) {
        console.error('Erreur magic link (non bloquante):', linkGenErr.message);
      }

      // 6. Lancer l'import Gmail en arriere-plan
      importState = { status: 'running', processed: 0, total: 0, dossiers_created: 0, last_result: null };
      console.log('Import Gmail lance pour', profile.email, '(user:', userId, ')');

      importGmail({
        oauthToken: tokens.access_token,
        userId: userId,
        onProgress: (progress: any) => {
          importState.processed = progress.processed;
          importState.total = progress.total;
          importState.dossiers_created = progress.dossiers_created;
        },
      }).then(async (result: any) => {
        importState.status = 'done';
        importState.last_result = result;
        console.log('Import Gmail termine:', result);
        // Fusionner les dossiers fragmentes
        try {
          console.log('Fusion des dossiers post-import pour', userId);
          await mergeDossiers(userId);
          console.log('Fusion des dossiers terminee');
        } catch (mergeErr: any) {
          console.error('Fusion dossiers erreur:', mergeErr.message);
        }
        // Generer le premier brief sur toute la periode importee (90 jours)
        try {
          console.log('Generation du brief post-import pour', userId);
          await generateBrief(userId!, 90);
          console.log('Brief post-import genere avec succes');
        } catch (briefErr: any) {
          console.error('Brief post-import erreur:', briefErr.message);
        }
      }).catch((err: any) => {
        importState.status = 'error';
        console.error('Import Gmail erreur:', err.message);
      });

      // 7. Rediriger vers le frontend avec token de session
      let redirectUrl = 'https://www.donna-legal.com/onboarding?import=started&user_id=' + userId;
      if (sessionToken) {
        redirectUrl += '&token=' + encodeURIComponent(sessionToken);
      }
      res.redirect(redirectUrl);
    }
  } catch (err: any) {
    console.error('OAuth callback erreur:', err.message);
    res.status(500).json({ error: 'Echec echange token', details: err.message });
  }
});

// GET /api/import/status
router.get('/status', (req: Request, res: Response) => {
  res.json(importState);
});

// POST /api/import/simulate — Simulate import progress for testing cinematic
router.post('/simulate', async (req: Request, res: Response) => {
  const { user_id, total, dossiers_created, attachments_count } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  importState = { status: 'running', processed: 0, total: total || 110, dossiers_created: 0, attachments_count: 0 };

  // Simulate progressive import over 8 seconds
  const steps = 10;
  const interval = 800;
  let step = 0;

  const timer = setInterval(() => {
    step++;
    importState.processed = Math.round((step / steps) * (total || 110));
    importState.dossiers_created = Math.min(Math.round((step / steps) * (dossiers_created || 8)), dossiers_created || 8);
    importState.attachments_count = Math.min(Math.round((step / steps) * (attachments_count || 36)), attachments_count || 36);

    if (step >= steps) {
      clearInterval(timer);
      importState.status = 'done';
      importState.progress = 100;
    } else {
      importState.progress = Math.round((step / steps) * 100);
    }
  }, interval);

  res.json({ message: 'Simulation started', redirect: `/onboarding?import=started&user_id=${user_id}` });
});

// GET /api/import/demo-login -- Temporary demo route, bypasses OAuth
router.get('/demo-login', (req: Request, res: Response) => {
  const demoUserId = '9082c497-0efe-401f-978a-e43cc149ff57';
  console.log('Demo login -- redirecting to dashboard with user_id:', demoUserId);
  const redirectUrl = 'https://www.donna-legal.com/dashboard?user_id=' + demoUserId;
  res.redirect(redirectUrl);
});

export default router;
