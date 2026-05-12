import { supabase } from '../../config/supabase';
import {
  extractAttachmentsText,
  uploadToStorage,
} from '../attachment-processor';
import { processEmailWithAI } from '../ai-processor';
import { extractDatesFromEmail } from '../date-extractor';
import { MailProvider, FullMessage, AttachmentMeta } from '../mail/types';
import { GmailProvider } from '../mail/gmail-provider';
import {
  buildDossierTokens,
  matchSubjectAgainstTokens,
  DossierToken,
} from '../case-matcher';

const MAX_EMAILS = 2000;

// ─── Dossier blacklist (false-positive filter) ────────────────────────────────
// Names that look like system/cabinet names, not real clients.
const BLACKLIST_NOMS_CLIENTS = [
  'donna', 'cabinet', 'sent', 'envoyé', 'envoye', 'inbox', 'reçu', 'recu',
  'me', 'moi', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notifications', 'notification', 'support', 'info', 'contact',
  'microsoft', 'équipe', 'equipe', 'greffe', 'tribunal', 'parquet',
  'google', 'gmail', 'outlook', 'apple', 'amazon', 'linkedin', 'facebook',
];

function isBlacklistedClient(nomClient: string): boolean {
  const normalized = nomClient.trim().toLowerCase();
  return BLACKLIST_NOMS_CLIENTS.some((b) => normalized === b || normalized.startsWith(b + ' ') || normalized.includes(' ' + b + ' ') || normalized.includes(b + ' ') && normalized.indexOf(b) < 3);
}

// Case matching is now dynamic — see ../case-matcher.ts.
// Tokens are derived at runtime from the user's actual dossiers (nom_client +
// case_reference) instead of a hard-coded whitelist.
//
// extractCaseReference() is kept as a thin compatibility wrapper for callers
// that don't have user context. It now always returns null (legacy whitelist
// removed). All real matching goes through matchSubjectAgainstTokens().
//
// @deprecated Use matchSubjectAgainstTokens(subject, await loadDossierTokens(userId)) instead.
export function extractCaseReference(_subject: string): string | null {
  return null;
}

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

// Extracts lowercase email address from a "Name <email@host>" header (or plain
// "email@host"). Used for SENT emails where the counterpart is the recipient
// (em.to) rather than the sender (which is the lawyer themselves).
function extractToEmail(toHeader: string): string {
  if (!toHeader) return '';
  const m = toHeader.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return toHeader.trim().toLowerCase();
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

  const after = new Date(Date.now() - 90 * 24 * 3600 * 1000);

  // ── Step 1: Collect message IDs from inbox + sent ────────────────────────
  console.log(`📥 agent-importer [${provider.name}]: listing messages depuis 90 jours (inbox + sent)...`);
  const allMessageIds: string[] = [];
  const seenIds = new Set<string>();

  for await (const raw of provider.listMessagesSince(after, MAX_EMAILS)) {
    if (!seenIds.has(raw.id)) {
      allMessageIds.push(raw.id);
      seenIds.add(raw.id);
    }
  }
  const inboxCount = allMessageIds.length;

  // Chantier B: import des mails envoyés pour contexte bidirectionnel et
  // détection de style. isSent est rempli par getFullMessage (label SENT côté
  // Gmail, absence de receivedDateTime côté Outlook).
  let sentRawCount = 0;
  for await (const raw of provider.listSentMessages(after, MAX_EMAILS)) {
    sentRawCount++;
    if (!seenIds.has(raw.id)) {
      allMessageIds.push(raw.id);
      seenIds.add(raw.id);
    }
  }

  const total = allMessageIds.length;
  console.log(`📥 agent-importer [${provider.name}]: ${inboxCount} inbox + ${sentRawCount} sent → ${total} unique messages à traiter`);
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

  // ── Step 3: Group by dossier-match (subject vs existing dossiers), fallback to sender ──
  // Priority: subject matches an existing dossier (case_reference or nom_client tokens)
  //          > sender domain (legacy fallback)
  //
  // The whitelist of CASEREF keywords has been replaced by dynamic tokens
  // derived from the user's actual dossiers in DB (see ../case-matcher.ts).

  // 3a. Load existing dossiers and build their matching tokens
  const { data: existingDossiers } = await supabase
    .from('dossiers')
    .select('id, nom_client, email_client, case_reference, metadata, statut')
    .eq('user_id', uid);

  const activeDossiers = (existingDossiers || []).filter((d: any) => d.statut === 'actif');
  const dossierTokens: DossierToken[] = buildDossierTokens(activeDossiers);

  // dossierMap maps a lookup key → dossier_id
  // Key can be: dossier_id (when subject matched an existing dossier) or senderEmail (legacy)
  const dossierMap: Record<string, string> = {};

  // 3b. Group emails by matched dossier first, then by sender as legacy fallback
  const byDossier: Record<string, EmailObj[]> = {}; // key = dossier_id
  const bySender: Record<string, EmailObj[]> = {};

  for (const em of emails) {
    const match = matchSubjectAgainstTokens(em.subject, dossierTokens);
    if (match) {
      if (!byDossier[match.dossierId]) byDossier[match.dossierId] = [];
      byDossier[match.dossierId].push(em);
      dossierMap[match.dossierId] = match.dossierId;
    } else {
      // Fallback: group by counterpart email.
      // Pour les sent, em.fromEmail est l'avocat — inutile pour identifier
      // le client. On utilise donc le destinataire (em.to).
      const key = em.isSent ? extractToEmail(em.to) : em.fromEmail;
      if (!key) continue;
      if (!bySender[key]) bySender[key] = [];
      bySender[key].push(em);
    }
  }

  // 3c. Existing dossiers are already in DB — nothing to create here.
  // Just update their dernier_echange info from the latest matched email.
  for (const dossierId in byDossier) {
    const group = byDossier[dossierId];
    group.sort((a, b) => b.date.getTime() - a.date.getTime());
    const latest = group[0];
    try {
      await supabase
        .from('dossiers')
        .update({
          dernier_echange_date: latest.date.toISOString(),
          dernier_echange_par: latest.fromEmail,
        })
        .eq('id', dossierId);
      result.skipped_existing++;
      console.log(`♻️ ${group.length} email(s) rattaché(s) au dossier existant ${dossierId.substring(0, 8)} (matched via subject)`);
    } catch (e: any) {
      console.error(`❌ agent-importer: erreur update dossier ${dossierId}:`, e.message);
    }
  }

  // 3d. Legacy sender-based grouping (only for emails WITHOUT a CASEREF)
  for (const senderEmail in bySender) {
    const group = bySender[senderEmail];
    const hasAttachment = group.some(em => em.attachsMeta && em.attachsMeta.length > 0);
    if (group.length < 3 && !hasAttachment) continue;
    try {
      group.sort((a, b) => b.date.getTime() - a.date.getTime());
      const latest = group[0];
      // Pour les sent, latest.from est l'avocat — on prend le destinataire.
      const counterpartHeader = latest.isSent ? latest.to : latest.from;
      const nomClient = extractName(counterpartHeader) || senderEmail;

      // Skip blacklisted names (false positives: "Donna", "Cabinet", "Sent"…)
      if (isBlacklistedClient(nomClient)) {
        console.log(`[agent-importer] Skipping blacklisted client name: "${nomClient}" (${senderEmail})`);
        continue;
      }

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
      console.log(`📂 Dossier créé (sender): ${nomClient} (${group.length} emails)`);
    } catch (e: any) {
      console.error(`❌ agent-importer: erreur dossier ${senderEmail}:`, e.message);
    }
  }

  // ── Step 4: Insert emails ─────────────────────────────────────────────────
  const metadataKey = provider.name === 'gmail' ? 'gmail_message_id' : 'outlook_message_id';

  for (let j = 0; j < emails.length; j++) {
    const em = emails[j];
    try {
      // Subject-match takes priority over counterpart for dossier assignment.
      // Counterpart = sender for received, recipient for sent.
      const match = matchSubjectAgainstTokens(em.subject, dossierTokens);
      const counterpartEmail = em.isSent ? extractToEmail(em.to) : em.fromEmail;
      const dossierId = (match && dossierMap[match.dossierId]) || dossierMap[counterpartEmail] || null;

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
          direction: em.isSent ? 'sent' : 'received',
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

  // ── Step 6: AI pipeline on recent RECEIVED emails (< 7j) ─────────────────
  // Décision Yoel (Q1): full-pipeline limité à 7j pour limiter le coût LLM
  // sur le backfill 90j (~$8 pour 7j vs ~$108 pour 90j).
  // Décision Yoel (Q2): les sent ne passent JAMAIS par processEmailWithAI
  // (filter et drafter sans valeur sur un mail envoyé).
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  console.log(`🤖 agent-importer [${provider.name}]: pipeline IA sur les received récents (< 7j)...`);
  const { data: recentEmails } = await supabase
    .from('emails')
    .select('id, objet, expediteur, metadata')
    .eq('user_id', uid)
    .eq('pipeline_step', 'imported')
    .eq('direction', 'received')
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: true });

  if (recentEmails && recentEmails.length > 0) {
    console.log(`🤖 ${recentEmails.length} received récents à traiter (sur ${result.emails_imported} importés)`);
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
    console.log(`🤖 Aucun received récent (< 7j) à traiter par l'IA`);
  }

  // ── Step 6b: Date extraction (regex only) on recent SENT emails ──────────
  // Décision Yoel (Q2): match dossier (déjà fait à l'insert) + extract dates
  // + extract attachments (déjà fait à l'insert) — pas de filter, pas de
  // drafter. useLLMFallback=false : limite le coût sur le backfill.
  const { data: recentSentEmails } = await supabase
    .from('emails')
    .select('id, objet, contenu, dossier_id')
    .eq('user_id', uid)
    .eq('pipeline_step', 'imported')
    .eq('direction', 'sent')
    .gte('created_at', sevenDaysAgo)
    .not('dossier_id', 'is', null);

  if (recentSentEmails && recentSentEmails.length > 0) {
    console.log(`📅 ${recentSentEmails.length} sent récents — extraction dates regex only`);
    for (const se of recentSentEmails) {
      try {
        const events = await extractDatesFromEmail({
          emailBody: se.contenu || '',
          emailSubject: se.objet || '',
          useLLMFallback: false,
        });
        if (events.length === 0) continue;
        const rows = events.map((evt) => ({
          dossier_id: se.dossier_id,
          user_id: uid,
          date_start: evt.dateStart,
          date_end: evt.dateEnd ?? null,
          title: evt.title,
          description: evt.description ?? null,
          source_type: evt.sourceType,
          source_id: se.id,
          source_filename: evt.sourceFilename ?? null,
          confidence: evt.confidence,
        }));
        await supabase.from('calendar_events').insert(rows);
      } catch (err: any) {
        console.error(`❌ agent-importer: date extraction sent ${se.id}:`, err?.message ?? err);
      }
    }
  }

  // Older emails (> 7j) + tous les sent : pas de pipeline AI → marqués
  // 'traite' pour qu'ils n'apparaissent pas dans la TODO de l'avocat.
  // Note : on garde direction='sent' éligibles ici car ils ont déjà passé
  // par leur propre traitement (step 6b) ou aucun (sent > 7j).
  await supabase
    .from('emails')
    .update({ pipeline_step: 'imported', statut: 'traite' })
    .eq('user_id', uid)
    .eq('pipeline_step', 'imported')
    .or(`created_at.lt.${sevenDaysAgo},direction.eq.sent`);

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
