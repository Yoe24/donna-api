import { google } from 'googleapis';
import { supabase } from '../config/supabase';
import { processEmailWithAI } from './ai-processor';
import { uploadToStorage, generateAttachmentSummary } from './attachment-processor';

const POLL_INTERVAL = 30000; // 30 secondes

let pdf_parse: any;
let mammoth: any;
try { pdf_parse = require('pdf-parse'); } catch (e) { /* not available */ }
try { mammoth = require('mammoth'); } catch (e) { /* not available */ }

let pollingTimer: ReturnType<typeof setInterval> | null = null;

interface AttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

interface ExtractedText {
  filename: string;
  text: string;
}

function createOAuthClient(): any {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
}

function extractBodyFromPayload(payload: any): string {
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf8');
      }
      if (part.parts) {
        const nested = extractBodyFromPayload(part);
        if (nested) return nested;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const html = Buffer.from(part.body.data, 'base64url').toString('utf8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === 'text/html' && sub.body && sub.body.data) {
            const html = Buffer.from(sub.body.data, 'base64url').toString('utf8');
            return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
        }
      }
    }
  }
  return '';
}

function getHeader(headers: any[] | undefined, name: string): string {
  if (!headers) return '';
  const h = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function collectAttachmentParts(payload: any): AttachmentPart[] {
  let parts: AttachmentPart[] = [];
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.filename && part.filename.length > 0 && part.body && part.body.attachmentId) {
        parts.push({
          filename: part.filename,
          mimeType: part.mimeType || '',
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0
        });
      }
      if (part.parts) {
        const nested = collectAttachmentParts(part);
        parts = parts.concat(nested);
      }
    }
  }
  return parts;
}

async function processGmailAttachments(
  gmail: any,
  gmailMsgId: string,
  attachmentParts: AttachmentPart[],
  dossierId: string | null,
  emailId: string | null,
  userId: string | null
): Promise<ExtractedText[]> {
  const extractedTexts: ExtractedText[] = [];
  for (const att of attachmentParts) {
    try {
      const ct = (att.mimeType || '').toLowerCase();
      const isPdf = ct.includes('pdf') || (att.filename && att.filename.toLowerCase().endsWith('.pdf'));
      const isWord = ct.includes('wordprocessingml') || ct.includes('msword')
        || (att.filename && (att.filename.toLowerCase().endsWith('.docx') || att.filename.toLowerCase().endsWith('.doc')));

      if (!isPdf && !isWord) continue;

      const attResponse = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: gmailMsgId,
        id: att.attachmentId
      });

      if (!attResponse.data || !attResponse.data.data) continue;

      const buffer = Buffer.from(attResponse.data.data, 'base64url');
      let extractedText = '';

      if (isPdf && pdf_parse) {
        const pdfData = await pdf_parse(buffer);
        extractedText = (pdfData.text || '').substring(0, 10000);
      } else if (isWord && mammoth) {
        const result = await mammoth.extractRawText({ buffer: buffer });
        extractedText = (result.value || '').substring(0, 10000);
      }

      // Upload vers Supabase Storage
      let storageUrl: string | null = null;
      if (dossierId && userId) {
        storageUrl = await uploadToStorage(buffer, userId, dossierId, att.filename);
      }

      // Generer resume IA
      let resumeIa: string | null = null;
      if (extractedText) {
        resumeIa = await generateAttachmentSummary(extractedText, att.filename);
      }

      if (dossierId) {
        const docRow: any = {
          dossier_id: dossierId,
          email_id: emailId || null,
          nom_fichier: att.filename,
          type: isPdf ? 'pdf' : 'word',
          contenu_extrait: extractedText || null,
          date_reception: new Date().toISOString(),
          storage_url: storageUrl || null,
          resume_ia: resumeIa || null
        };
        const { error: docInsertErr } = await supabase
          .from('dossier_documents')
          .insert(docRow);
        if (docInsertErr && docInsertErr.message) {
          if (docInsertErr.message.includes('email_id')) delete docRow.email_id;
          if (docInsertErr.message.includes('storage_url')) delete docRow.storage_url;
          if (docInsertErr.message.includes('resume_ia')) delete docRow.resume_ia;
          await supabase.from('dossier_documents').insert(docRow);
        }
      }

      if (extractedText) {
        extractedTexts.push({ filename: att.filename, text: extractedText });
        console.log('📎 PJ Gmail extraite : ' + att.filename + ' — ' + extractedText.length + ' car.' + (storageUrl ? ' (stocké)' : '') + (resumeIa ? ' (résumé)' : ''));
      }
    } catch (err: any) {
      console.error('❌ Erreur PJ Gmail ' + (att.filename || 'inconnue') + ' :', err.message);
    }
  }
  return extractedTexts;
}

async function checkNewEmailsForUser(userId: string, refreshToken: string, gmailLastCheck: string | null): Promise<void> {
  try {
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    try {
      await oauth2Client.getAccessToken();
    } catch (tokenErr: any) {
      if (tokenErr.response && tokenErr.response.status === 401) {
        console.error('⚠️ Token Gmail expiré pour user ' + userId + ', reconnexion nécessaire');
        return;
      }
      throw tokenErr;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let sinceDate: Date;
    if (gmailLastCheck) {
      sinceDate = new Date(gmailLastCheck);
    } else {
      sinceDate = new Date(Date.now() - 3600000);
    }
    const epochSeconds = Math.floor(sinceDate.getTime() / 1000);

    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: 'after:' + epochSeconds + ' is:inbox',
      maxResults: 10
    });

    const messages: any[] = (listResponse.data && listResponse.data.messages) || [];
    let newCount = 0;

    for (const msgItem of messages) {
      try {
        const { data: existing } = await supabase
          .from('emails')
          .select('id')
          .eq('user_id', userId)
          .filter('metadata->>gmail_message_id', 'eq', msgItem.id)
          .limit(1);

        if (existing && existing.length > 0) continue;

        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id: msgItem.id,
          format: 'full'
        });

        const payload = msgResponse.data.payload;
        if (!payload) continue;
        const headers = payload.headers || [];

        const from = getHeader(headers, 'From');
        const subject = getHeader(headers, 'Subject') || '(sans objet)';
        const dateStr = getHeader(headers, 'Date');
        const gmailMessageId = getHeader(headers, 'Message-ID');
        const body = extractBodyFromPayload(payload);

        const { data: email, error: insertError } = await supabase
          .from('emails')
          .insert({
            user_id: userId,
            expediteur: from,
            objet: subject,
            resume: null,
            brouillon: null,
            pipeline_step: 'en_attente',
            statut: 'en_attente',
            contexte_choisi: 'standard',
            metadata: { gmail_message_id: msgItem.id, gmail_rfc_message_id: gmailMessageId }
          })
          .select()
          .single();

        if (insertError) {
          console.error('❌ Gmail poll insert error:', insertError.message);
          continue;
        }

        console.log('📬 Nouvel email Gmail (user ' + userId.substring(0, 8) + '): ' + subject + ' (de ' + from + ')');

        const attachmentParts = collectAttachmentParts(payload);

        processEmailWithAI(email.id, {
          subject: subject,
          sender: from,
          body: body,
          userId: userId,
          attachments: [],
          messageId: null,
          gmailAttachments: attachmentParts,
          gmailMsgId: msgItem.id,
          gmailAuth: oauth2Client
        } as any).catch((err: any) => {
          console.error('❌ AI processing error (Gmail poll):', err.message);
        });

        newCount++;
      } catch (msgErr: any) {
        console.error('❌ Gmail poll message error:', msgErr.message);
      }
    }

    // Update last check time for this user
    await supabase
      .from('configurations')
      .update({ gmail_last_check: new Date().toISOString() })
      .eq('user_id', userId);

    if (newCount > 0) {
      console.log('📬 Gmail poll (user ' + userId.substring(0, 8) + '): ' + newCount + ' nouveaux emails traités');
    }

  } catch (err: any) {
    console.error('❌ Gmail poll error (user ' + userId.substring(0, 8) + '):', err.message);
  }
}

async function checkAllUsers(): Promise<void> {
  try {
    const { data: configs, error } = await supabase
      .from('configurations')
      .select('user_id, refresh_token, gmail_last_check')
      .not('refresh_token', 'is', null);

    if (error || !configs || configs.length === 0) return;

    for (const config of configs) {
      await checkNewEmailsForUser(config.user_id, config.refresh_token, config.gmail_last_check);
    }
  } catch (err: any) {
    console.error('❌ Gmail poll global error:', err.message);
  }
}

export async function startGmailPolling(): Promise<void> {
  console.log('📬 Gmail polling initialisé (toutes les 30s) — mode multi-utilisateurs');

  try {
    const { data: configs } = await supabase
      .from('configurations')
      .select('user_id, refresh_token')
      .not('refresh_token', 'is', null);

    if (!configs || configs.length === 0) {
      console.log('📬 Aucun refresh_token trouvé — polling en attente (vérifiera toutes les 60s)');
      pollingTimer = setInterval(async () => {
        const { data: c } = await supabase
          .from('configurations')
          .select('user_id, refresh_token')
          .not('refresh_token', 'is', null);
        if (c && c.length > 0) {
          console.log('📬 ' + c.length + ' refresh token(s) détecté(s)! Démarrage du polling Gmail');
          clearInterval(pollingTimer!);
          pollingTimer = setInterval(checkAllUsers, POLL_INTERVAL);
          checkAllUsers();
        }
      }, 60000);
      return;
    }

    console.log('📬 ' + configs.length + ' utilisateur(s) avec refresh token — démarrage du polling Gmail');
    pollingTimer = setInterval(checkAllUsers, POLL_INTERVAL);
    checkAllUsers();
  } catch (err: any) {
    console.error('❌ Gmail polling init error:', err.message);
  }
}
