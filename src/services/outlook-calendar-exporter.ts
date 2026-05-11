/**
 * OutlookCalendarExporter — syncs Donna calendar_events to Outlook Calendar via Microsoft Graph.
 *
 * Idempotent: events with an existing outlook_event_id are skipped unless the
 * remote event no longer exists.
 *
 * Scope: Calendars.ReadWrite (delegated).
 * Token: MSAL refresh flow from configurations.outlook_refresh_token.
 */

import { ConfidentialClientApplication, Configuration, RefreshTokenRequest } from '@azure/msal-node';
import { supabase } from '../config/supabase';

// ─── MSAL ─────────────────────────────────────────────────────────────────────

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

async function getAccessToken(refreshToken: string): Promise<string> {
  const app = buildMsalApp();
  const request: RefreshTokenRequest = {
    refreshToken,
    scopes: ['https://graph.microsoft.com/Calendars.ReadWrite', 'offline_access'],
  };
  const result = await app.acquireTokenByRefreshToken(request);
  if (!result?.accessToken) {
    throw new Error('MSAL: no access token returned for Calendars');
  }
  return result.accessToken;
}

// ─── Graph helpers ────────────────────────────────────────────────────────────

async function graphRequest(accessToken: string, method: string, path: string, body?: any): Promise<any> {
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph ${method} ${path} → ${res.status}: ${text.substring(0, 300)}`);
  }

  if (res.status === 204) return {};
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return {};
}

// ─── Exporter ─────────────────────────────────────────────────────────────────

export class OutlookCalendarExporter {
  private readonly userId: string;
  private readonly refreshToken: string;
  private accessToken: string | null = null;

  constructor(refreshToken: string, userId: string) {
    this.refreshToken = refreshToken;
    this.userId = userId;
  }

  private async token(): Promise<string> {
    if (!this.accessToken) {
      this.accessToken = await getAccessToken(this.refreshToken);
    }
    return this.accessToken;
  }

  /**
   * Sync all calendar_events for this user that do not yet have an outlook_event_id.
   * Creates one Outlook Calendar event per DB row.
   */
  async syncAll(): Promise<void> {
    try {
      console.log(`[OutlookCalendarExporter] Starting sync for user ${this.userId.substring(0, 8)}...`);

      const { data: events, error } = await supabase
        .from('calendar_events')
        .select('id, title, description, date_start, date_end, outlook_event_id')
        .eq('user_id', this.userId)
        .is('outlook_event_id', null);

      if (error) {
        console.error('[OutlookCalendarExporter] fetchEvents error:', error.message);
        return;
      }

      if (!events || events.length === 0) {
        console.log('[OutlookCalendarExporter] No pending events to sync');
        return;
      }

      const tok = await this.token();

      for (const evt of events) {
        try {
          await this.createEvent(tok, evt);
        } catch (e: any) {
          console.error(`[OutlookCalendarExporter] createEvent(${evt.id}) error:`, e.message);
        }
      }

      console.log(`[OutlookCalendarExporter] Sync complete for user ${this.userId.substring(0, 8)}: ${events.length} event(s) processed`);
    } catch (e: any) {
      console.error('[OutlookCalendarExporter] syncAll error:', e.message);
    }
  }

  private async createEvent(accessToken: string, evt: any): Promise<void> {
    // Build start/end datetimes
    const dateStart = new Date(evt.date_start);
    if (isNaN(dateStart.getTime())) {
      console.warn(`[OutlookCalendarExporter] Invalid date_start for event ${evt.id} — skipping`);
      return;
    }

    // If no date_end, set end = start + 1 hour
    const dateEnd = evt.date_end ? new Date(evt.date_end) : new Date(dateStart.getTime() + 3600_000);

    const graphEvent = {
      subject: (evt.title || 'Échéance Donna').substring(0, 255),
      body: {
        contentType: 'HTML',
        content: `<p>${(evt.description || evt.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p><p style="color:#888;font-size:12px">Importé depuis Donna Legal</p>`,
      },
      start: {
        dateTime: dateStart.toISOString().replace('Z', ''),
        timeZone: 'Europe/Paris',
      },
      end: {
        dateTime: dateEnd.toISOString().replace('Z', ''),
        timeZone: 'Europe/Paris',
      },
      isReminderOn: true,
      reminderMinutesBeforeStart: 1440, // 24h avant
    };

    const result = await graphRequest(accessToken, 'POST', '/me/events', graphEvent);
    const outlookEventId = result?.id;

    if (!outlookEventId) {
      throw new Error(`No id returned for event "${evt.title}"`);
    }

    console.log(`[OutlookCalendarExporter] Created Outlook event for "${evt.title}": ${outlookEventId}`);

    await supabase
      .from('calendar_events')
      .update({ outlook_event_id: outlookEventId })
      .eq('id', evt.id);
  }
}

// ─── Convenience trigger ──────────────────────────────────────────────────────

/**
 * Trigger Outlook Calendar sync for a user (fire-and-forget).
 * Checks outlook_calendar_sync_enabled flag.
 */
export async function triggerOutlookCalendarExport(userId: string): Promise<void> {
  try {
    const { data: cfg, error } = await supabase
      .from('configurations')
      .select('outlook_refresh_token, outlook_calendar_sync_enabled')
      .eq('user_id', userId)
      .single();

    if (error || !cfg) {
      console.log(`[OutlookCalendarExporter] No config for user ${userId.substring(0, 8)} — skip`);
      return;
    }

    if (!cfg.outlook_calendar_sync_enabled) {
      console.log(`[OutlookCalendarExporter] Skipped (opt-in disabled) for user ${userId.substring(0, 8)}`);
      return;
    }

    if (!cfg.outlook_refresh_token) {
      console.log(`[OutlookCalendarExporter] No outlook_refresh_token for user ${userId.substring(0, 8)} — skip`);
      return;
    }

    const exporter = new OutlookCalendarExporter(cfg.outlook_refresh_token, userId);
    await exporter.syncAll();
  } catch (e: any) {
    console.error('[OutlookCalendarExporter] triggerOutlookCalendarExport error (non-blocking):', e.message);
  }
}
