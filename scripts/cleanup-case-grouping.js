#!/usr/bin/env node
/**
 * cleanup-case-grouping.js
 *
 * Idempotent script that reassigns emails to the correct dossier based on
 * CASEREF extracted from email subjects (format: "CASEREF — description").
 *
 * Usage:
 *   node scripts/cleanup-case-grouping.js
 *   node scripts/cleanup-case-grouping.js --user 5c3e24f4-3646-4f72-bbf6-dc0890c19207
 *   node scripts/cleanup-case-grouping.js --dry-run
 *
 * Default users processed:
 *   - 5c3e24f4-3646-4f72-bbf6-dc0890c19207 (Outlook/Alexandra)
 *   - 378cf355-8faa-4b90-add0-6dd3a6db1518 (Gmail/Alexandra)
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const userArgIdx = args.indexOf('--user');
const specificUser = userArgIdx >= 0 ? args[userArgIdx + 1] : null;

const DEFAULT_USERS = [
  { id: '5c3e24f4-3646-4f72-bbf6-dc0890c19207', label: 'Outlook/Alexandra' },
  { id: '378cf355-8faa-4b90-add0-6dd3a6db1518', label: 'Gmail/Alexandra' },
];

const USERS_TO_PROCESS = specificUser
  ? [{ id: specificUser, label: 'specified user' }]
  : DEFAULT_USERS;

// ─── Canonical case name mapping ─────────────────────────────────────────────
const CANONICAL_CASE_NAMES = {
  'BELAIR': 'BELAIR Distribution',
  'TECHFLOW': 'TechFlow SAS',
  'BELLINI': 'Bellini SAS',
  'MARLOT': 'MARLOT Industrie',
  'LUMIERE': 'LUMIERE Cosmétiques',
  'LUMIÈRE': 'LUMIERE Cosmétiques',
};

function getCanonicalCaseName(caseRef) {
  return CANONICAL_CASE_NAMES[caseRef] || caseRef;
}

// ─── CASEREF extraction (mirrors TypeScript version) ─────────────────────────
function extractCaseReference(subject) {
  if (!subject) return null;
  // Split on em-dash, en-dash, colon, or spaced hyphen
  const separators = /\s*[—–:]\s*|\s+-\s+/;
  const parts = subject.split(separators);
  if (parts.length < 2) return null;
  const ref = parts[0].trim().toUpperCase();
  if (!ref || /^\d+$/.test(ref)) return null;
  if (ref.length > 50) return null;
  return ref;
}

// ─── Main cleanup logic ───────────────────────────────────────────────────────
async function processUser(userId, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing user: ${label} (${userId})`);
  console.log(`${'='.repeat(60)}`);

  // 1. List all emails for this user
  const { data: emails, error: emailsErr } = await supabase
    .from('emails')
    .select('id, objet, dossier_id, expediteur')
    .eq('user_id', userId);

  if (emailsErr) {
    console.error('❌ Error fetching emails:', emailsErr.message);
    return;
  }

  console.log(`📧 Total emails found: ${emails.length}`);

  // 2. Group emails by CASEREF
  const byCaseRef = {};
  const noRef = [];

  for (const email of emails) {
    const caseRef = extractCaseReference(email.objet);
    if (caseRef) {
      if (!byCaseRef[caseRef]) byCaseRef[caseRef] = [];
      byCaseRef[caseRef].push(email);
    } else {
      noRef.push(email);
    }
  }

  const caseRefs = Object.keys(byCaseRef);
  console.log(`\n📋 CASEREFs detected: ${caseRefs.length}`);
  for (const ref of caseRefs) {
    console.log(`  - ${ref}: ${byCaseRef[ref].length} emails → "${getCanonicalCaseName(ref)}"`);
  }
  console.log(`  - (no CASEREF): ${noRef.length} emails`);

  if (isDryRun) {
    console.log('\n🔍 DRY RUN — no changes will be made.');
    return;
  }

  // 3. Get existing dossiers for this user (before changes)
  const { data: dossiersBeforeRaw, error: dossiersBefErr } = await supabase
    .from('dossiers')
    .select('id, nom_client, email_client')
    .eq('user_id', userId);

  if (dossiersBefErr) {
    console.error('❌ Error fetching dossiers:', dossiersBefErr.message);
    return;
  }
  const dossiersBefore = dossiersBeforeRaw || [];
  console.log(`\n📂 Dossiers BEFORE: ${dossiersBefore.length}`);
  for (const d of dossiersBefore) {
    console.log(`  - "${d.nom_client}" (${d.email_client || 'no email'}) [${d.id}]`);
  }

  // 4. For each CASEREF, find or create the canonical dossier
  const caseRefDossierMap = {}; // CASEREF → dossier_id

  for (const caseRef of caseRefs) {
    const canonicalName = getCanonicalCaseName(caseRef);

    // Search by metadata->case_reference
    const { data: byMeta } = await supabase
      .from('dossiers')
      .select('id, nom_client')
      .eq('user_id', userId)
      .contains('metadata', { case_reference: caseRef })
      .limit(1)
      .maybeSingle();

    if (byMeta) {
      caseRefDossierMap[caseRef] = byMeta.id;
      console.log(`\n♻️  CASEREF "${caseRef}": reusing existing dossier "${byMeta.nom_client}" [${byMeta.id}]`);
      continue;
    }

    // Search by nom_client ILIKE
    const { data: byNom } = await supabase
      .from('dossiers')
      .select('id, nom_client')
      .eq('user_id', userId)
      .ilike('nom_client', `%${caseRef}%`)
      .limit(1)
      .maybeSingle();

    if (byNom) {
      caseRefDossierMap[caseRef] = byNom.id;
      console.log(`\n♻️  CASEREF "${caseRef}": reusing existing dossier (nom_client match) "${byNom.nom_client}" [${byNom.id}]`);
      // Ensure metadata is set
      await supabase
        .from('dossiers')
        .update({ metadata: { case_reference: caseRef } })
        .eq('id', byNom.id);
      continue;
    }

    // Create new canonical dossier
    const { data: newDossier, error: insertErr } = await supabase
      .from('dossiers')
      .insert({
        user_id: userId,
        nom_client: canonicalName,
        email_client: null,
        statut: 'actif',
        metadata: { case_reference: caseRef },
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error(`❌ Error creating dossier for CASEREF "${caseRef}":`, insertErr.message);
      continue;
    }
    caseRefDossierMap[caseRef] = newDossier.id;
    console.log(`\n✅ CASEREF "${caseRef}": created new dossier "${canonicalName}" [${newDossier.id}]`);
  }

  // 5. Reassign emails to canonical dossiers
  let reassigned = 0;
  let alreadyCorrect = 0;

  for (const caseRef of caseRefs) {
    const targetDossierId = caseRefDossierMap[caseRef];
    if (!targetDossierId) continue;

    const emailsForRef = byCaseRef[caseRef];
    const emailsNeedingUpdate = emailsForRef.filter(e => e.dossier_id !== targetDossierId);

    if (emailsNeedingUpdate.length === 0) {
      alreadyCorrect += emailsForRef.length;
      continue;
    }

    const emailIds = emailsNeedingUpdate.map(e => e.id);
    const { error: updateErr } = await supabase
      .from('emails')
      .update({ dossier_id: targetDossierId })
      .in('id', emailIds);

    if (updateErr) {
      console.error(`❌ Error reassigning emails for CASEREF "${caseRef}":`, updateErr.message);
    } else {
      reassigned += emailsNeedingUpdate.length;
      alreadyCorrect += (emailsForRef.length - emailsNeedingUpdate.length);
      console.log(`📧 CASEREF "${caseRef}": reassigned ${emailsNeedingUpdate.length} emails → "${getCanonicalCaseName(caseRef)}"`);
    }
  }

  console.log(`\n📊 Reassignment summary:`);
  console.log(`  - Reassigned: ${reassigned} emails`);
  console.log(`  - Already correct: ${alreadyCorrect} emails`);
  console.log(`  - No CASEREF (unchanged): ${noRef.length} emails`);

  // 6. Delete dossiers that are now empty (after reassignment)
  // First, count emails per dossier
  const { data: allDossiers } = await supabase
    .from('dossiers')
    .select('id, nom_client')
    .eq('user_id', userId);

  const deletedDossiers = [];
  for (const d of (allDossiers || [])) {
    const { count } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('dossier_id', d.id);

    if (count === 0) {
      // Check if this is one of our canonical dossiers (keep even if empty)
      const isCanonical = Object.values(caseRefDossierMap).includes(d.id);
      if (isCanonical) {
        console.log(`⚠️  Canonical dossier "${d.nom_client}" is empty but keeping it [${d.id}]`);
        continue;
      }

      const { error: delErr } = await supabase
        .from('dossiers')
        .delete()
        .eq('id', d.id);

      if (delErr) {
        console.error(`❌ Error deleting empty dossier "${d.nom_client}":`, delErr.message);
      } else {
        deletedDossiers.push(d.nom_client);
        console.log(`🗑️  Deleted empty dossier: "${d.nom_client}" [${d.id}]`);
      }
    }
  }

  // 7. Final state
  const { data: dossiersAfterRaw } = await supabase
    .from('dossiers')
    .select('id, nom_client')
    .eq('user_id', userId);

  const dossiersAfter = dossiersAfterRaw || [];
  console.log(`\n📂 Dossiers AFTER: ${dossiersAfter.length} (was ${dossiersBefore.length})`);
  for (const d of dossiersAfter) {
    const { count } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('dossier_id', d.id);
    console.log(`  - "${d.nom_client}": ${count} emails`);
  }

  console.log(`\n✅ User ${label} done:`);
  console.log(`  ${dossiersBefore.length} dossiers → ${dossiersAfter.length} dossiers`);
  if (deletedDossiers.length > 0) {
    console.log(`  Deleted: ${deletedDossiers.join(', ')}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 Donna Case Grouping Cleanup');
  console.log(`   Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Users: ${USERS_TO_PROCESS.map(u => u.label).join(', ')}`);

  for (const user of USERS_TO_PROCESS) {
    await processUser(user.id, user.label);
  }

  console.log('\n\n✅ All users processed. Done.');
  process.exit(0);
})().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
