// src/services/mail/gmail-provider.ts
// Wraps the existing googleapis Gmail calls behind the MailProvider interface.

import { google } from 'googleapis';
import { MailProvider, RawMessage, FullMessage, AttachmentMeta, TokenInvalidError } from './types';

function isInvalidGrant(err: any): boolean {
  const msg = (err && (err.message || err.toString())) || '';
  return (
    msg.includes('invalid_grant') ||
    msg.includes('invalid_rapt') ||
    msg.includes('Token has been expired or revoked') ||
    (err && err.code === 401)
  );
}

function extractEmailAddress(header: string): string {
  if (!header) return '';
  const m = header.match(/<([^>]+)>/);
  return m ? m[1].trim().toLowerCase() : header.trim().toLowerCase();
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    const html = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (html?.body?.data)
      return decodeBase64Url(html.body.data).replace(/<[^>]+>/g, ' ').substring(0, 3000);
    for (const part of payload.parts) {
      const sub = extractBody(part);
      if (sub) return sub;
    }
  }
  return '';
}

function extractAttachments(payload: any): AttachmentMeta[] {
  const atts: AttachmentMeta[] = [];
  function walk(part: any): void {
    if (!part) return;
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      atts.push({
        id: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || '',
        size: part.body.size || 0,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return atts;
}

function getHeader(headers: any[], name: string): string {
  if (!headers) return '';
  const h = headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * Gmail implementation of MailProvider.
 *
 * Two modes:
 *   - accessToken: used during initial import (short-lived token from OAuth callback)
 *   - refreshToken: used by the poller (long-lived, auto-refreshed)
 */
export class GmailProvider implements MailProvider {
  readonly name = 'gmail' as const;

  private readonly auth: any;
  private readonly userId: string;

  constructor(params: { accessToken?: string; refreshToken?: string; userId: string }) {
    this.userId = params.userId;
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    if (params.refreshToken) {
      oauth2Client.setCredentials({ refresh_token: params.refreshToken });
    } else if (params.accessToken) {
      oauth2Client.setCredentials({ access_token: params.accessToken });
    }
    this.auth = oauth2Client;
  }

  /** Ensure we have a valid access token — throws TokenInvalidError on invalid_grant */
  private async ensureToken(): Promise<void> {
    try {
      await this.auth.getAccessToken();
    } catch (err: any) {
      if (isInvalidGrant(err)) {
        throw new TokenInvalidError('gmail', this.userId);
      }
      throw err;
    }
  }

  private gmail() {
    return google.gmail({ version: 'v1', auth: this.auth });
  }

  async *listMessagesSince(after: Date, max: number): AsyncGenerator<RawMessage> {
    await this.ensureToken();
    const g = this.gmail();
    const epochSeconds = Math.floor(after.getTime() / 1000);
    let pageToken: string | null = null;
    let count = 0;

    do {
      const params: any = {
        userId: 'me',
        maxResults: 50,
        q: `after:${epochSeconds}`,
      };
      if (pageToken) params.pageToken = pageToken;

      let listRes: any;
      try {
        listRes = await g.users.messages.list(params);
      } catch (err: any) {
        if (isInvalidGrant(err)) throw new TokenInvalidError('gmail', this.userId);
        throw err;
      }

      const msgs: any[] = listRes.data.messages || [];
      for (const m of msgs) {
        if (count >= max) return;
        yield {
          id: m.id,
          threadId: m.threadId || '',
          internalDate: new Date(), // lightweight — full date in getFullMessage
        };
        count++;
      }
      pageToken = listRes.data.nextPageToken || null;
    } while (pageToken && count < max);
  }

  async *listSentMessages(after: Date, max: number): AsyncGenerator<RawMessage> {
    await this.ensureToken();
    const g = this.gmail();
    const epochSeconds = Math.floor(after.getTime() / 1000);
    let pageToken: string | null = null;
    let count = 0;

    do {
      const params: any = {
        userId: 'me',
        maxResults: 50,
        q: `in:sent after:${epochSeconds}`,
      };
      if (pageToken) params.pageToken = pageToken;

      let listRes: any;
      try {
        listRes = await g.users.messages.list(params);
      } catch (err: any) {
        if (isInvalidGrant(err)) throw new TokenInvalidError('gmail', this.userId);
        throw err;
      }

      const msgs: any[] = listRes.data.messages || [];
      for (const m of msgs) {
        if (count >= max) return;
        yield {
          id: m.id,
          threadId: m.threadId || '',
          internalDate: new Date(),
        };
        count++;
      }
      pageToken = listRes.data.nextPageToken || null;
    } while (pageToken && count < max);
  }

  async getFullMessage(id: string): Promise<FullMessage> {
    const g = this.gmail();
    let msgRes: any;
    try {
      msgRes = await g.users.messages.get({ userId: 'me', id, format: 'full' });
    } catch (err: any) {
      if (isInvalidGrant(err)) throw new TokenInvalidError('gmail', this.userId);
      throw err;
    }

    const msg = msgRes.data;
    const headers: any[] = (msg.payload?.headers) || [];
    const from = getHeader(headers, 'from');
    const to = getHeader(headers, 'to');
    const subject = getHeader(headers, 'subject') || '(sans sujet)';
    const dateStr = getHeader(headers, 'date');
    const date = dateStr ? new Date(dateStr) : new Date(Number(msg.internalDate));
    const body = extractBody(msg.payload);
    const attachments = extractAttachments(msg.payload);
    const fromEmail = extractEmailAddress(from);

    // Mark as sent if it carries the SENT label
    const labelIds: string[] = msg.labelIds || [];
    const isSent = labelIds.includes('SENT');

    return {
      id: msg.id!,
      threadId: msg.threadId || '',
      from,
      fromEmail,
      to,
      subject,
      date,
      body,
      attachments,
      isSent,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const g = this.gmail();
    let attRes: any;
    try {
      attRes = await g.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      });
    } catch (err: any) {
      if (isInvalidGrant(err)) throw new TokenInvalidError('gmail', this.userId);
      throw err;
    }

    if (!attRes.data?.data) {
      throw new Error(`Attachment data vide pour ${attachmentId}`);
    }
    return Buffer.from(attRes.data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
}
