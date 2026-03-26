import { google } from 'googleapis';
import { supabase } from '../../config/supabase';
import {
  extractAttachmentsText,
  uploadToStorage,
  generateAttachmentSummary,
} from '../attachment-processor';
import { processEmailWithAI } from '../ai-processor';

const MAX_EMAILS = 500;

interface AttachmentMeta {
  filename: string;
  attachmentId: string;
  mimeType: string;
}

interface EmailObj {
  gmailId: string;
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  date: Date;
  body: string;
  attachsMeta: AttachmentMeta[];
}

interface ImportProgress {
  processed: number;
  total: number;
  dossiers_created: number;
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

function extractEmailAddress(header: string): string {
  if (!header) return '';
  const m = header.match(/<([^>]+)>/);
  return m ? m[1].trim().toLowerCase() : header.trim().toLowerCase();
}

function extractName(header: string): string {
  if (!header) return '';
  const m = header.match(/^([^<]+)</);
  return m ? m[1].trim().replace(/"/g, '') : header.trim();
}

function decodeBase64(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch (e) {
    return '';
  }
}

function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plain && plain.body && plain.body.data) return decodeBase64(plain.body.data);
    const html = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (html && html.body && html.body.data)
      return decodeBase64(html.body.data).replace(/<[^>]+>/g, ' ').substring(0, 3000);
    for (let i = 0; i < payload.parts.length; i++) {
      const sub = extractBody(payload.parts[i]);
      if (sub) return sub;
    }
  }
  return '';
}

function extractAttachmentsMeta(payload: any): AttachmentMeta[] {
  const atts: AttachmentMeta[] = [];
  if (!payload) return atts;

  function walk(part: any): void {
    if (!part) return;
    if (part.filename && part.filename.length > 0 && part.body && part.body.attachmentId) {
      atts.push({
        filename: part.filename,
        attachmentId: part.body.attachmentId,
        mimeType: part.mimeType || '',
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return atts;
}

function getHeader(headers: any[], name: string): string {
  if (!headers) return '';
  const h = headers.find((h: any) => h.name && h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
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

export async function importGmail({
  oauthToken,
  userId,
  onProgress,
}: ImportGmailParams): Promise<ImportResult> {
  const uid = userId;
  if (!uid) throw new Error('userId requis pour importGmail');
  const result: ImportResult = {
    dossiers_created: 0,
    emails_imported: 0,
    documents_extracted: 0,
    skipped_existing: 0,
  };

  try {
    const { count: existingCount } = await supabase
      .from('dossiers')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid);

    if (existingCount && existingCount > 0) {
      console.log(
        `⚠️ agent-importer: ${existingCount} dossiers existants détectés pour user ${uid} - mode anti-doublon activé`
      );
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: oauthToken });
    const gmail = google.gmail({ version: 'v1', auth });

    const after = Math.floor((Date.now() - 90 * 24 * 3600 * 1000) / 1000);
    const query = 'after:' + after;

    let allMessageIds: string[] = [];
    let pageToken: string | null = null;
    console.log('📥 agent-importer: listing messages...');

    do {
      const listParams: any = { userId: 'me', maxResults: 50, q: query };
      if (pageToken) listParams.pageToken = pageToken;
      const listRes = await gmail.users.messages.list(listParams);
      const msgs = listRes.data.messages || [];
      allMessageIds = allMessageIds.concat(msgs.map((m: any) => m.id));
      pageToken = listRes.data.nextPageToken || null;
      if (allMessageIds.length >= MAX_EMAILS) break;
    } while (pageToken);

    allMessageIds = allMessageIds.slice(0, MAX_EMAILS);
    const total = allMessageIds.length;
    console.log(`📥 agent-importer: ${total} messages à traiter`);
    if (onProgress) onProgress({ processed: 0, total, dossiers_created: 0 });

    const emails: EmailObj[] = [];
    const sentEmails: EmailObj[] = [];

    for (let i = 0; i < allMessageIds.length; i++) {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: allMessageIds[i],
          format: 'full',
        });
        const msg = msgRes.data;
        const headers = msg.payload ? msg.payload.headers : [];
        const from = getHeader(headers as any[], 'from');
        const to = getHeader(headers as any[], 'to');
        const subject = getHeader(headers as any[], 'subject') || '(sans sujet)';
        const dateStr = getHeader(headers as any[], 'date');
        const date = dateStr ? new Date(dateStr) : new Date();
        const body = extractBody(msg.payload);
        const attachsMeta = extractAttachmentsMeta(msg.payload);
        const fromEmail = extractEmailAddress(from);

        const emailObj: EmailObj = {
          gmailId: msg.id!,
          from,
          fromEmail,
          to,
          subject,
          date,
          body,
          attachsMeta,
        };
        emails.push(emailObj);

        if (from && (from.toLowerCase().includes(uid.substring(0, 8)) || to === 'me')) {
          sentEmails.push(emailObj);
        }

        if (onProgress && i % 20 === 0)
          onProgress({ processed: i + 1, total, dossiers_created: result.dossiers_created });
      } catch (e: any) {
        console.error(`❌ agent-importer: erreur message ${allMessageIds[i]}:`, e.message);
      }
    }

    // Regroupe par expéditeur
    const bySender: Record<string, EmailObj[]> = {};
    emails.forEach((e) => {
      const key = e.fromEmail;
      if (!key) return;
      if (!bySender[key]) bySender[key] = [];
      bySender[key].push(e);
    });

    // Crée les dossiers pour les expéditeurs avec 3+ échanges
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
          console.log(
            `♻️ Dossier existant réutilisé pour ${senderEmail} (id: ${existingDossier.id})`
          );
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
          console.error(
            `❌ agent-importer: dossier insert error pour ${senderEmail}:`,
            dErr.message
          );
          continue;
        }
        dossierMap[senderEmail] = dossier.id;
        result.dossiers_created++;
        console.log(`📂 Dossier créé: ${nomClient} (${group.length} emails)`);
      } catch (e: any) {
        console.error(`❌ agent-importer: erreur dossier ${senderEmail}:`, e.message);
      }
    }

    // Insère chaque mail dans emails
    for (let j = 0; j < emails.length; j++) {
      const em = emails[j];
      try {
        const dossierId = dossierMap[em.fromEmail] || null;

        if (em.gmailId) {
          const { data: existingEmail } = await supabase
            .from('emails')
            .select('id')
            .eq('user_id', uid)
            .contains('metadata', { gmail_message_id: em.gmailId })
            .maybeSingle();

          if (existingEmail) {
            continue;
          }
        }

        const emailDate = new Date(em.date);
        const today = new Date();
        const isToday = emailDate.toDateString() === today.toDateString();

        const { data: insertedEmail, error: eErr } = await supabase
          .from('emails')
          .insert({
            user_id: uid,
            expediteur: em.from,
            objet: em.subject,
            resume: em.body ? em.body.substring(0, 200) : null,
            brouillon: null,
            pipeline_step: isToday ? 'en_attente' : 'importe',
            statut: isToday ? 'en_attente' : 'archive',
            dossier_id: dossierId,
            contexte_choisi: 'standard',
            metadata: { gmail_message_id: em.gmailId },
          })
          .select()
          .single();

        if (eErr) {
          console.error('❌ agent-importer: email insert error:', eErr.message);
          continue;
        }
        result.emails_imported++;

        if (isToday && insertedEmail) {
          console.log(`🤖 Email du jour détecté, lancement traitement IA: ${em.subject}`);
          processEmailWithAI(insertedEmail.id, {
            subject: em.subject,
            sender: em.from,
            body: em.body || '',
            userId: uid,
            attachments: [],
            messageId: null,
          }).catch((err: any) => {
            console.error('❌ Erreur traitement email du jour:', err.message);
          });
        }

        // Traitement des PJ PDF/Word — avec upload Storage + résumé IA
        if (em.attachsMeta && em.attachsMeta.length > 0 && dossierId && insertedEmail) {
          for (let k = 0; k < em.attachsMeta.length; k++) {
            const att = em.attachsMeta[k];
            const isPdf =
              att.mimeType.includes('pdf') || att.filename.toLowerCase().endsWith('.pdf');
            const isWord =
              att.mimeType.includes('wordprocessingml') ||
              att.mimeType.includes('msword') ||
              att.filename.toLowerCase().endsWith('.docx') ||
              att.filename.toLowerCase().endsWith('.doc');
            if (!isPdf && !isWord) continue;
            try {
              // Télécharge la PJ depuis Gmail
              const attRes = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId: em.gmailId,
                id: att.attachmentId,
              });
              const buffer = Buffer.from(
                (attRes.data.data || '').replace(/-/g, '+').replace(/_/g, '/'),
                'base64'
              );

              // Extraire le texte
              const extracted = await extractAttachmentsText(null as any, [
                {
                  attachment_id: att.attachmentId,
                  filename: att.filename,
                  content_type: att.mimeType,
                },
              ], buffer);
              const texte = extracted.length > 0 ? extracted[0].text : '';

              // Upload vers Supabase Storage
              const storageUrl = await uploadToStorage(buffer, uid, dossierId, att.filename);

              // Générer résumé IA
              const resumeIa = await generateAttachmentSummary(texte, att.filename);

              const docRow: Record<string, any> = {
                dossier_id: dossierId,
                email_id: insertedEmail.id,
                nom_fichier: att.filename,
                type: att.mimeType,
                contenu_extrait: texte || null,
                date_reception: em.date.toISOString(),
                storage_url: storageUrl || null,
                resume_ia: resumeIa || null,
              };
              const { error: docErr } = await supabase
                .from('dossier_documents')
                .insert(docRow);

              // Fallback: if columns don't exist yet, retry without them
              if (
                docErr &&
                (docErr.message.includes('storage_url') || docErr.message.includes('resume_ia'))
              ) {
                delete docRow.storage_url;
                delete docRow.resume_ia;
                await supabase.from('dossier_documents').insert(docRow);
              }
              result.documents_extracted++;
              console.log(
                `📎 Document importé: ${att.filename}${storageUrl ? ' (stocké)' : ''}${resumeIa ? ' (résumé)' : ''}`
              );
            } catch (e: any) {
              console.error(`❌ agent-importer: erreur PJ ${att.filename}:`, e.message);
            }
          }
        }
      } catch (e: any) {
        console.error('❌ agent-importer: erreur insertion email:', e.message);
      }
    }

    // Analyse du style d'Alexandra sur ses emails envoyés
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

    if (onProgress) onProgress({ processed: total, total, dossiers_created: result.dossiers_created });
    console.log('✅ agent-importer terminé:', result);
    return result;
  } catch (e: any) {
    console.error('❌ agent-importer: erreur globale:', e.message);
    return result;
  }
}
