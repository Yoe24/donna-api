// src/services/mail/outlook-provider.ts
// Microsoft Outlook implementation of MailProvider via @microsoft/microsoft-graph-client + @azure/msal-node

import { ConfidentialClientApplication, Configuration, AuthorizationCodeRequest, RefreshTokenRequest } from '@azure/msal-node';
import { MailProvider, RawMessage, FullMessage, AttachmentMeta, TokenInvalidError } from './types';

// Lazy import — only required at runtime when an Outlook user is present
let Client: typeof import('@microsoft/microsoft-graph-client').Client;
try {
  Client = require('@microsoft/microsoft-graph-client').Client;
} catch {
  // Will throw at runtime if actually used — acceptable since Outlook is optional
}

function extractEmailAddress(addr: string): string {
  if (!addr) return '';
  const m = addr.match(/<([^>]+)>/);
  return m ? m[1].trim().toLowerCase() : addr.trim().toLowerCase();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
}

function isTokenExpired(err: any): boolean {
  const msg = (err && (err.message || err.toString())) || '';
  const code = err?.statusCode || err?.code || 0;
  return (
    code === 401 ||
    msg.includes('InvalidAuthenticationToken') ||
    msg.includes('TokenExpired') ||
    msg.includes('invalid_grant') ||
    msg.includes('AADSTS70008') || // expired refresh token
    msg.includes('AADSTS50078') || // revoked
    msg.includes('AADSTS50173')    // password changed
  );
}

function buildMsalApp(): ConfidentialClientApplication {
  const msalConfig: Configuration = {
    auth: {
      clientId: process.env.AZURE_CLIENT_ID!,
      clientSecret: process.env.AZURE_CLIENT_SECRET!,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    },
  };
  return new ConfidentialClientApplication(msalConfig);
}

export function getOutlookAuthUrl(): Promise<string> {
  const app = buildMsalApp();
  return app.getAuthCodeUrl({
    scopes: ['https://graph.microsoft.com/Mail.Read', 'offline_access'],
    redirectUri: process.env.AZURE_REDIRECT_URI!,
  });
}

export async function exchangeOutlookCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  email: string;
  name: string;
}> {
  const app = buildMsalApp();
  const request: AuthorizationCodeRequest = {
    code,
    scopes: ['https://graph.microsoft.com/Mail.Read', 'offline_access'],
    redirectUri: process.env.AZURE_REDIRECT_URI!,
  };
  const result = await app.acquireTokenByCode(request);
  if (!result) throw new Error('acquireTokenByCode: résultat vide');

  const accessToken = result.accessToken;
  // MSAL returns the refresh token only in the cache — extract from account
  // For token refresh later we use acquireTokenByRefreshToken
  const refreshToken = (result as any).refreshToken || '';

  const email = result.account?.username || '';
  const name = result.account?.name || '';

  return { accessToken, refreshToken, email, name };
}

export class OutlookProvider implements MailProvider {
  readonly name = 'outlook' as const;

  private readonly userId: string;
  private readonly refreshToken: string;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(params: { refreshToken: string; userId: string }) {
    this.userId = params.userId;
    this.refreshToken = params.refreshToken;
  }

  private async getAccessToken(): Promise<string> {
    // Reuse cached token if not expired (with 60s buffer)
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry.getTime() > Date.now() + 60000) {
      return this.accessToken;
    }

    const app = buildMsalApp();
    const request: RefreshTokenRequest = {
      refreshToken: this.refreshToken,
      scopes: ['https://graph.microsoft.com/Mail.Read', 'offline_access'],
    };

    let result: any;
    try {
      result = await app.acquireTokenByRefreshToken(request);
    } catch (err: any) {
      if (isTokenExpired(err)) {
        throw new TokenInvalidError('outlook', this.userId);
      }
      throw err;
    }

    if (!result) throw new TokenInvalidError('outlook', this.userId);

    this.accessToken = result.accessToken;
    // result.expiresOn is a Date or number
    this.tokenExpiry = result.expiresOn instanceof Date
      ? result.expiresOn
      : new Date(Date.now() + (result.expiresIn || 3600) * 1000);

    return this.accessToken!;
  }

  private async getClient(): Promise<any> {
    if (!Client) {
      throw new Error('@microsoft/microsoft-graph-client not available');
    }
    const token = await this.getAccessToken();
    return Client.init({
      authProvider: (done: any) => done(null, token),
    });
  }

  async *listMessagesSince(after: Date, max: number): AsyncGenerator<RawMessage> {
    const client = await this.getClient();
    const afterIso = after.toISOString();
    let url = `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${afterIso}&$select=id,conversationId,receivedDateTime&$top=50&$orderby=receivedDateTime desc`;
    let count = 0;

    while (url && count < max) {
      let page: any;
      try {
        page = await client.api(url).get();
      } catch (err: any) {
        if (isTokenExpired(err)) throw new TokenInvalidError('outlook', this.userId);
        throw err;
      }

      const msgs: any[] = page.value || [];
      for (const m of msgs) {
        if (count >= max) return;
        yield {
          id: m.id,
          threadId: m.conversationId || m.id,
          internalDate: new Date(m.receivedDateTime),
        };
        count++;
      }
      url = page['@odata.nextLink'] || null;
    }
  }

  async *listSentMessages(after: Date, max: number): AsyncGenerator<RawMessage> {
    const client = await this.getClient();
    const afterIso = after.toISOString();
    let url = `/me/mailFolders/sentitems/messages?$filter=sentDateTime ge ${afterIso}&$select=id,conversationId,sentDateTime&$top=50&$orderby=sentDateTime desc`;
    let count = 0;

    while (url && count < max) {
      let page: any;
      try {
        page = await client.api(url).get();
      } catch (err: any) {
        if (isTokenExpired(err)) throw new TokenInvalidError('outlook', this.userId);
        throw err;
      }

      const msgs: any[] = page.value || [];
      for (const m of msgs) {
        if (count >= max) return;
        yield {
          id: m.id,
          threadId: m.conversationId || m.id,
          internalDate: new Date(m.sentDateTime),
        };
        count++;
      }
      url = page['@odata.nextLink'] || null;
    }
  }

  async getFullMessage(id: string): Promise<FullMessage> {
    const client = await this.getClient();
    let msg: any;
    try {
      msg = await client
        .api(`/me/messages/${id}`)
        .select('id,conversationId,from,toRecipients,subject,receivedDateTime,body,hasAttachments,isDraft,sentDateTime,parentFolderId')
        .get();
    } catch (err: any) {
      if (isTokenExpired(err)) throw new TokenInvalidError('outlook', this.userId);
      throw err;
    }

    const fromAddr = msg.from?.emailAddress?.address || '';
    const fromName = msg.from?.emailAddress?.name || '';
    const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
    const fromEmail = fromAddr.toLowerCase();
    const to = (msg.toRecipients || [])
      .map((r: any) => r.emailAddress?.address || '')
      .join(', ');

    const body =
      msg.body?.contentType === 'html'
        ? stripHtml(msg.body.content || '')
        : (msg.body?.content || '').substring(0, 3000);

    // Fetch attachment metadata list if there are attachments
    let attachments: AttachmentMeta[] = [];
    if (msg.hasAttachments) {
      try {
        const attList = await client
          .api(`/me/messages/${id}/attachments`)
          .select('id,name,contentType,size')
          .get();
        attachments = (attList.value || []).map((a: any) => ({
          id: a.id,
          filename: a.name || 'attachment',
          mimeType: a.contentType || 'application/octet-stream',
          size: a.size || 0,
        }));
      } catch {
        // Non-fatal — proceed without attachments
      }
    }

    const date = new Date(msg.receivedDateTime || msg.sentDateTime || Date.now());

    // Determine if this is a sent message by checking the parent folder
    // (sentitems folder id varies per account — heuristic: no "from" matches a sent item)
    const isSent = !!msg.sentDateTime && !msg.receivedDateTime;

    return {
      id: msg.id,
      threadId: msg.conversationId || msg.id,
      from,
      fromEmail,
      to,
      subject: msg.subject || '(sans sujet)',
      date,
      body,
      attachments,
      isSent,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const client = await this.getClient();
    let att: any;
    try {
      att = await client.api(`/me/messages/${messageId}/attachments/${attachmentId}`).get();
    } catch (err: any) {
      if (isTokenExpired(err)) throw new TokenInvalidError('outlook', this.userId);
      throw err;
    }

    if (att.contentBytes) {
      return Buffer.from(att.contentBytes, 'base64');
    }
    throw new Error(`Attachment contentBytes vide pour ${attachmentId}`);
  }
}
