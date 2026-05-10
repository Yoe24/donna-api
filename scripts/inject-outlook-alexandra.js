#!/usr/bin/env node
/**
 * inject-outlook-alexandra.js
 *
 * Injecte les 60 emails du dataset-alexandra-v2.json dans la boite Outlook
 * de alexandra.fernandez.demo@outlook.com via Microsoft Graph API.
 *
 * Pré-requis :
 *   - AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID dans .env
 *   - L'utilisateur alexandra.fernandez.demo@outlook.com a déjà fait son OAuth
 *     (outlook_refresh_token présent dans la table `configurations` de Supabase)
 *   - OU passer le refresh_token en env var OUTLOOK_ALEXANDRA_REFRESH_TOKEN
 *
 * Usage :
 *   node scripts/inject-outlook-alexandra.js [--dry-run] [--skip-existing]
 *
 * Idempotence :
 *   Le script tag chaque message avec un header X-Donna-MessageId unique.
 *   Si --skip-existing est passé, il vérifie d'abord si des messages existent
 *   déjà dans la boite (via $count) et skippe si > 0.
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');

// ─── Config ─────────────────────────────────────────────────────────────────

const DATASET_PATH = path.resolve(
  __dirname,
  '../../alpha/poles/persona-creator/dataset-alexandra-v2.json'
);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;

const OUTLOOK_EMAIL = 'alexandra.fernandez.demo@outlook.com';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_EXISTING = process.argv.includes('--skip-existing');

// Rate limit: wait between Graph API calls (ms)
const DELAY_BETWEEN_CALLS = 300;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── MSAL token refresh ───────────────────────────────────────────────────────

let cachedAccessToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken(refreshToken) {
  if (cachedAccessToken && Date.now() < cachedTokenExpiry - 60000) {
    return cachedAccessToken;
  }

  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  cachedAccessToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('[token] Access token refreshed, expires in', data.expires_in, 's');
  return cachedAccessToken;
}

// ─── Supabase: get outlook_refresh_token ─────────────────────────────────────

async function getOutlookRefreshToken() {
  // Priority: env var OUTLOOK_ALEXANDRA_REFRESH_TOKEN
  if (process.env.OUTLOOK_ALEXANDRA_REFRESH_TOKEN) {
    console.log('[supabase] Using OUTLOOK_ALEXANDRA_REFRESH_TOKEN from env');
    return process.env.OUTLOOK_ALEXANDRA_REFRESH_TOKEN;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL + SUPABASE_SERVICE_KEY required');
  }

  const url = `${SUPABASE_URL}/rest/v1/configurations?select=outlook_refresh_token,user_id&order=updated_at.desc&limit=10`;
  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase query failed: ${response.status}`);
  }

  const rows = await response.json();
  // Find the row for the Outlook demo user
  const row = rows.find((r) => r.outlook_refresh_token);
  if (!row) {
    throw new Error(
      'No outlook_refresh_token found in configurations table.\n' +
      'Alexandra must complete the OAuth flow first:\n' +
      '  1. GET https://api.donna-legal.com/api/import/outlook/auth\n' +
      '  2. Click the auth_url\n' +
      '  3. Sign in as alexandra.fernandez.demo@outlook.com'
    );
  }

  console.log('[supabase] Found outlook_refresh_token for user_id:', row.user_id?.substring(0, 8));
  return row.outlook_refresh_token;
}

// ─── Microsoft Graph: check existing messages ────────────────────────────────

async function countInboxMessages(accessToken) {
  const url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$count=true&$top=1&$select=id';
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'ConsistencyLevel': 'eventual',
    },
  });

  if (!response.ok) {
    console.warn('[graph] Could not count inbox messages:', response.status);
    return 0;
  }

  const data = await response.json();
  return data['@odata.count'] || 0;
}

// ─── Microsoft Graph: create message ─────────────────────────────────────────

async function createMessage(accessToken, email, index) {
  // Build a stable internet message ID for idempotence
  const stableId = `donna-inject-${email.affaire}-${email.mail_index}@alexandra.demo`;

  const bodyHtml = email.body_html || '';
  const bodyText = stripHtml(bodyHtml);

  const dt = new Date(email.date_sent);
  const receivedDateTime = dt.toISOString();

  const graphMessage = {
    subject: email.subject,
    body: {
      contentType: 'HTML',
      content: bodyHtml,
    },
    from: {
      emailAddress: {
        address: email.from_email,
        name: email.from_name,
      },
    },
    toRecipients: (email.to_emails || [OUTLOOK_EMAIL]).map((addr) => ({
      emailAddress: { address: addr },
    })),
    receivedDateTime,
    sentDateTime: receivedDateTime,
    isRead: false,
    isDraft: false,
    internetMessageId: stableId,
    // Store donna metadata in singleValueExtendedProperties for idempotence check
    singleValueExtendedProperties: [
      {
        id: 'String {00020329-0000-0000-C000-000000000046} Name donna_inject_id',
        value: stableId,
      },
    ],
  };

  if (DRY_RUN) {
    console.log(`[dry-run] Would create: [${index}] ${email.affaire} | ${email.subject.substring(0, 60)}`);
    return { id: 'dry-run-' + index };
  }

  const url = 'https://graph.microsoft.com/v1.0/me/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(graphMessage),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph POST /me/messages failed: ${response.status} ${text.substring(0, 300)}`);
  }

  const data = await response.json();
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== inject-outlook-alexandra.js ===');
  console.log(`DRY_RUN=${DRY_RUN} SKIP_EXISTING=${SKIP_EXISTING}`);

  // 1. Validate config
  if (!AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !AZURE_TENANT_ID) {
    console.error('ERROR: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID required');
    process.exit(1);
  }

  // 2. Load dataset
  if (!fs.existsSync(DATASET_PATH)) {
    console.error('ERROR: Dataset not found at', DATASET_PATH);
    process.exit(1);
  }
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  console.log(`[dataset] ${dataset.length} emails loaded`);
  const affaires = [...new Set(dataset.map((e) => e.affaire))];
  console.log('[dataset] Affaires:', affaires.join(', '));

  // 3. Get refresh token
  let refreshToken;
  try {
    refreshToken = await getOutlookRefreshToken();
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }

  // 4. Get access token
  let accessToken;
  try {
    accessToken = await getAccessToken(refreshToken);
  } catch (err) {
    console.error('ERROR getting access token:', err.message);
    process.exit(1);
  }

  // 5. Skip if existing messages
  if (SKIP_EXISTING && !DRY_RUN) {
    const count = await countInboxMessages(accessToken);
    console.log(`[graph] Current inbox count: ${count}`);
    if (count > 0) {
      console.log(`[skip] ${count} messages already in inbox — skipping injection (--skip-existing)`);
      process.exit(0);
    }
  }

  // 6. Inject emails
  let injected = 0;
  let failed = 0;

  for (let i = 0; i < dataset.length; i++) {
    const email = dataset[i];
    const label = `[${i + 1}/${dataset.length}] ${email.affaire} | ${email.subject.substring(0, 55)}`;

    // Refresh token if needed
    accessToken = await getAccessToken(refreshToken);

    try {
      const result = await createMessage(accessToken, email, i + 1);
      console.log(`  OK ${label} (id: ${result.id?.substring(0, 20)}...)`);
      injected++;
    } catch (err) {
      console.error(`  FAIL ${label}: ${err.message}`);
      failed++;
    }

    if (!DRY_RUN) {
      await sleep(DELAY_BETWEEN_CALLS);
    }
  }

  console.log('\n=== RESULT ===');
  console.log(`Injected: ${injected}/${dataset.length}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Affaires: ${affaires.join(', ')}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
