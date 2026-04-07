import { supabase } from '../../config/supabase';
import {
  extractAttachmentsText,
  uploadToStorage,
} from '../attachment-processor';
import { processEmailWithAI } from '../ai-processor';
import { MailProvider, FullMessage, AttachmentMeta } from '../mail/types';
import { GmailProvider } from '../mail/gmail-provider';

const MAX_EMAILS = 2000;

// ─── Legacy internal type kept for style-detection logic ───────────────────
interface EmailObj {
  providerId: string;  // renamed from gmailId — provider-agnostic
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  attachsMeta: AttachmentMeta[];
  isSent: boolean;
}

interface ImportProgress {
  processed: number;
  total: number;
  dossiers_created: number;
  attachments_count: number;
}

interface ImportGmailParams {
  oauthToken: string;
  userId: string;
  onProgress?: (progress: ImportProgress) => void;
}

interface ImportResult {
  dossiers_created: number;
  emails_imported: number;
  documents_extracted: number;
  skipped_existing: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractName(header: string): string {
  if (!header) return '';
  const m = header.match(/^([^<]+)</);
  return m ? m[1].trim().replace(/"/g, '') : header.trim();
}

function detectStyle(sentEmails: EmailObj[]): {
  appel: string;
  politesse: string;
  signature: string;
} {
  let appel = 'cher_maitre';
  let politesse = 'cordialement';
  let signature = '';

  for (let i = 0; i < sentEmails.length; i++) {
    const body = sentEmails[i].body || '';
    if (/Madame, Monsieur/i.test(body)) appel = 'madame_monsieur';
    else if (/Bonjour/i.test(body)) appel = 'prenom';
    if (/Bien à vous/i.test(body)) politesse = 'bien_a_vous';
    else if (/salutations distinguées/i.test(body)) politesse = 'veuillez_agreer';
    const sigMatch = body.match(
      /(?:Cordialement|Bien à vous|salutations distinguées)[,.]?\s*\n([\s\S]{0,200})/i
    );
    if (sigMatch && sigMatch[1].trim().length > 2) {
      signature = sigMatch[1].trim().split('\n')[0].trim();
      break;
    }
  }

  return { appel, politesse, signature };
}

// ─── Core import logic (provider-agnostic) ──────────────────────────────────

async function importMail(
  provider: MailProvider,
  userId: string,
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportResult> {
  const uid = userId;
  const result: ImportResult = {
    dossiers_created: 0,
    emails_imported: 0,
    documents_extracted: 0,
    skipped_existing: 0,
  };

  // Check existing dossiers
  const { count: existingCount } = await supabase
    .from('dossiers')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', uid);

  if (existingCount && existingCount > 0) {
    console.log(
      `⚠️ agent-importer [${provider.name}]: ${existingCount} dossiers existants pour user ${uid.substring(0, 8)} — mode anti-doublon activé`
    );
  }

  const after = new Date(Date.now() - 60 * 24 * 3600 * 1000);

  // ── Step 1: Collect all message IDs ──────────────────────────────────────
  console.log(`📥 agent-importer [${provider.name}]: listing messages depuis 60 jours...`);
  const allMessageIds: string[] = [];

  for await (const raw of provider.listMessagesSince(after, MAX_EMAILS)) {
    allMessageIds.push(raw.id);
  }

  const total = allMessageIds.length;
  console.log(`📥 agent-importer [${provider.name}]: ${total} messages à traiter`);
  if (onProgress) onProgress({ processed: 0, total, dossiers_created: 0, attachments_count: 0 });

  // ── Step 2: Fetch full messages ───────────────────────────────────────────
  const emails: EmailObj[] = [];
  const sentEmails: EmailObj[] = [];

  for (let i = 0; i < allMessageIds.length; i++) {
    try {
      const full: FullMessage = await provider.getFullMessage(allMessageIds[i]);

      const emailObj: EmailObj = {
        providerId: full.id,
        from: full.from,
        fromEmail: full.fromEmail,
        to: full.to,
        subject: full.subject,
        date: full.date,
        body: full.body,
        attachsMeta: full.attachments,
        isSent: full.isSent,
      };

      emails.push(emailObj);
      if (full.isSent) sentEmails.push(emailObj);

      if (onProgress && i % 20 === 0)
        onProgress({ processed: i + 1, total, dossiers_created: result.dossiers_created, attachments_count: result.documents_extracted });
    } catch (e: any) {
      console.error(`❌ agent-importer [${provider.name}]: erreur message ${allMessageIds[i]}:`, e.message);
    }
  }

  // ── Step 3: Group by sender, create dossiers (threshold 3+) ──────────────
  const bySender: Record<string, EmailObj[]> = {};
  emails.forEach((e) => {
    const key = e.fromEmail;
    if (!key) return;
    if (!bySender[key]) bySender[key] = [];
    bySender[key].push(e);
  });

  const dossierMap: Record<string, string> = {};
  for (const senderEmail in bySender) {
    const group = bySender[senderEmail];
    if (group.length < 3) continue;
    try {
      group.sort((a, b) => b.date.getTime() - a.date.getTime());
      const latest = group[0];
      const nomClient = extractName(latest.from) || senderEmail;

      const { data: existingDossier } = await supabase
        .from('dossiers')
        .select('id')
        .eq('user_id', uid)
        .ilike('email_client', senderEmail)
        .maybeSingle();

      if (existingDossier) {
        dossierMap[senderEmail] = existingDossier.id;
        console.log(`♻️ Dossier existant réutilisé pour ${senderEmail} (id: ${existingDossier.id})`);
        result.skipped_existing++;
        continue;
      }

      const { data: dossier, error: dErr } = await supabase
        .from('dossiers')
        .insert({
          user_id: uid,
          nom_client: nomClient,
          email_client: senderEmail,
          statut: 'actif',
          dernier_echange_date: latest.date.toISOString(),
          dernier_echange_par: senderEmail,
        })
        .select()
        .single();

      if (dErr) {
        console.error(`❌ agent-importer: dossier insert error pour ${senderEmail}:`, dErr.message);
        continue;
      }
      dossierMap[senderEmail] = dossier.id;
      result.dossiers_created++;
      console.log(`📂 Dossier créé: ${nomClient} (${group.length} emails)`);
    } catch (e: any) {
      console.error(`❌ agent-importer: erreur dossier ${senderEmail}:`, e.message);
    }
  }

  // ── Step 4: Insert emails ─────────────────────────────────────────────────
  const metadataKey = provider.name === 'gmail' ? 'gmail_message_id' : 'outlook_message_id';

  for (let j = 0; j < emails.length; j++) {
    const em = emails[j];
    try {
      const dossierId = dossierMap[em.fromEmail] || null;

      if (em.providerId) {
        const { data: existingEmail } = await supabase
          .from('emails')
          .select('id')
          .eq('user_id', uid)
          .contains('metadata', { [metadataKey]: em.providerId })
          .maybeSingle();

        if (existingEmail) continue;
      }

      const { data: insertedEmail, error: eErr } = await supabase
        .from('emails')
        .insert({
          user_id: uid,
          expediteur: em.from,
          objet: em.subject,
          contenu: em.body || null,
          resume: em.body ? em.body.substring(0, 200) : null,
          brouillon: null,
          pipeline_step: 'imported',
          statut: 'en_attente',
          dossier_id: dossierId,
          contexte_choisi: 'standard',
          created_at: em.date.toISOString(),
          metadata: { [metadataKey]: em.providerId },
        })
        .select()
        .single();

      if (eErr) {
        console.error('❌ agent-importer: email insert error:', eErr.message);
        continue;
      }
      result.emails_imported++;

      // ── Step 4b: Process attachments (PDF/Word) ──────────────────────────
      if (em.attachsMeta && em.attachsMeta.length > 0 && dossierId && insertedEmail) {
        for (const att of em.attachsMeta) {
          const isPdf =
            att.mimeType.includes('pdf') || att.filename.toLowerCase().endsWith('.pdf');
          const isWord =
            att.mimeType.includes('wordprocessingml') ||
            att.mimeType.includes('msword') ||
            att.filename.toLowerCase().endsWith('.docx') ||
            att.filename.toLowerCase().endsWith('.doc');
          if (!isPdf && !isWord) continue;
          try {
            const buffer = await provider.getAttachment(em.providerId, att.id);

            const extracted = await extractAttachmentsText(null as any, [
              {
                attachment_id: att.id,
                filename: att.filename,
                content_type: att.mimeType,
              },
            ], buffer);
            const texte = extracted.length > 0 ? extracted[0].text : '';

            const storageUrl = await uploadToStorage(buffer, uid, dossierId, att.filename);

            const docRow: Record<string, any> = {
              dossier_id: dossierId,
              email_id: insertedEmail.id,
              nom_fichier: att.filename,
              type: att.mimeType,
              contenu_extrait: texte || null,
              date_reception: em.date.toISOString(),
              storage_url: storageUrl || null,
              resume_ia: null,
            };
            const { error: docErr } = await supabase
              .from('dossier_documents')
              .insert(docRow);

            if (docErr && (docErr.message.includes('storage_url') || docErr.message.includes('resume_ia'))) {
              delete docRow.storage_url;
              delete docRow.resume_ia;
              await supabase.from('dossier_documents').insert(docRow);
            }
            result.documents_extracted++;
            console.log(`📎 Document importé: ${att.filename}${storageUrl ? ' (stocké)' : ''}`);
          } catch (e: any) {
            console.error(`❌ agent-importer: erreur PJ ${att.filename}:`, e.message);
          }
        }
      }
    } catch (e: any) {
      console.error('❌ agent-importer: erreur insertion email:', e.message);
    }
  }

  // ── Step 5: Style detection from sent emails ──────────────────────────────
  if (sentEmails.length > 0) {
    try {
      const style = detectStyle(sentEmails);
      console.log('🎨 Style détecté:', style);
      await supabase
        .from('configurations')
        .update({
          formule_appel: style.appel,
          formule_politesse: style.politesse,
          signature: style.signature || undefined,
        })
        .eq('user_id', uid);
      console.log('✅ Config style mise à jour');
    } catch (e: any) {
      console.error('❌ agent-importer: erreur style update:', e.message);
    }
  }

  // ── Step 6: AI pipeline on recent emails (< 24h) ─────────────────────────
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  console.log(`🤖 agent-importer [${provider.name}]: pipeline IA sur les emails récents (< 24h)...`);
  const { data: recentEmails } = await supabase
    .from('emails')
    .select('id, objet, expediteur, metadata')
    .eq('user_id', uid)
    .eq('pipeline_step', 'imported')
    .gte('created_at', twentyFourHoursAgo)
    .order('created_at', { ascending: true });

  if (recentEmails && recentEmails.length > 0) {
    console.log(`🤖 ${recentEmails.length} emails récents à traiter (sur ${result.emails_imported} importés)`);
    for (let p = 0; p < recentEmails.length; p++) {
      const pe = recentEmails[p];
      try {
        const originalEmail = emails.find(
          (e) => e.providerId === (pe.metadata?.[metadataKey])
        );
        const body = originalEmail ? originalEmail.body || '' : '';
        const sender = pe.expediteur || '';
        console.log(`🤖 [${p + 1}/${recentEmails.length}] Traitement IA: ${pe.objet}`);
        await processEmailWithAI(pe.id, {
          subject: pe.objet || '',
          sender,
          body,
          userId: uid,
          attachments: [],
          messageId: null,
        });
      } catch (aiErr: any) {
        console.error(`❌ Pipeline IA erreur pour ${pe.id}:`, aiErr.message);
      }
    }
    console.log('✅ Pipeline IA post-import terminé');
  } else {
    console.log(`🤖 Aucun email récent (< 24h) à traiter par l'IA`);
  }

  // Mark older emails as processed (no AI for old ones)
  await supabase
    .from('emails')
    .update({ pipeline_step: 'imported', statut: 'traite' })
    .eq('user_id', uid)
    .eq('pipeline_step', 'imported')
    .lt('created_at', twentyFourHoursAgo);

  if (onProgress)
    onProgress({ processed: total, total, dossiers_created: result.dossiers_created, attachments_count: result.documents_extracted });
  console.log(`✅ agent-importer [${provider.name}] terminé:`, result);
  return result;
}

// ─── Public API — backward compatible ────────────────────────────────────────

export async function importGmail({
  oauthToken,
  userId,
  onProgress,
}: ImportGmailParams): Promise<ImportResult> {
  if (!userId) throw new Error('userId requis pour importGmail');

  const provider = new GmailProvider({ accessToken: oauthToken, userId });
  return importMail(provider, userId, onProgress);
}

/**
 * Import from any MailProvider — used by Outlook callback and future providers.
 */
export async function importFromProvider(
  provider: MailProvider,
  userId: string,
  onProgress?: (progress: ImportProgress) => void
): Promise<ImportResult> {
  if (!userId) throw new Error('userId requis pour importFromProvider');
  return importMail(provider, userId, onProgress);
}
