import OpenAI from 'openai';
import { supabase } from '../config/supabase';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface DossierRow {
  id: string;
  nom_client: string;
  email_client: string;
  domaine: string | null;
  resume_situation: string | null;
  statut: string;
  opposing_party: string | null;
  case_reference: string | null;
}

interface EmailRow {
  id: string;
  expediteur: string | null;
  objet: string | null;
  resume: string | null;
  classification: {
    case_reference?: string;
    opposing_party?: string;
  } | null;
  urgency: string | null;
}

interface DossierData {
  id: string;
  nom_client: string;
  email_client: string;
  domaine: string | null;
  resume_situation: string | null;
  email_count: number;
  subjects: string[];
  senders: string[];
  case_references: string[];
  opposing_parties: string[];
}

interface MergeGroup {
  merged_name: string;
  dossier_ids: string[];
  client_name?: string;
  opposing_party?: string;
  case_reference?: string;
  domaine?: string;
  resume_situation?: string;
}

interface ResultGroup {
  name: string;
  primary_id: string;
  merged_from: number;
  email_count: number | null;
}

interface MergeResult {
  original_count?: number;
  merged: number;
  final_count: number | null;
  groups: ResultGroup[];
}

interface DossierUpdateData {
  nom_client: string;
  email_count: number;
  opposing_party?: string;
  case_reference?: string;
  domaine?: string;
  resume_situation?: string;
}

export async function mergeDossiers(userId: string): Promise<MergeResult> {
  console.log("🔀 Dossier merger started for user:", userId);

  // === ÉTAPE 1 — Récupérer les données ===
  const { data: dossiers, error: dErr } = await supabase
    .from("dossiers")
    .select("id, nom_client, email_client, domaine, resume_situation, statut, opposing_party, case_reference")
    .eq("user_id", userId)
    .eq("statut", "actif");

  if (dErr) {
    console.error("❌ Merger: erreur récupération dossiers:", dErr.message);
    throw new Error("Erreur récupération dossiers: " + dErr.message);
  }

  if (!dossiers || dossiers.length <= 1) {
    console.log("🔀 Merger: " + (dossiers ? dossiers.length : 0) + " dossier(s) — rien à fusionner");
    return { merged: 0, final_count: dossiers ? dossiers.length : 0, groups: [] };
  }

  console.log("🔀 Merger: " + dossiers.length + " dossiers à analyser");

  // Pour chaque dossier, récupérer les emails
  const dossiersData: DossierData[] = [];
  for (const d of dossiers as DossierRow[]) {
    const { data: emails } = await supabase
      .from("emails")
      .select("id, expediteur, objet, resume, classification, urgency")
      .eq("dossier_id", d.id)
      .order("created_at", { ascending: false })
      .limit(10);

    const caseRefs: string[] = [];
    const opposingParties: string[] = [];
    const subjects: string[] = [];
    const senders: string[] = [];

    ((emails as EmailRow[] | null) || []).forEach((e) => {
      if (e.objet) subjects.push(e.objet);
      if (e.expediteur) senders.push(e.expediteur);
      if (e.classification) {
        if (e.classification.case_reference) caseRefs.push(e.classification.case_reference);
        if (e.classification.opposing_party) opposingParties.push(e.classification.opposing_party);
      }
    });

    dossiersData.push({
      id: d.id,
      nom_client: d.nom_client,
      email_client: d.email_client,
      domaine: d.domaine,
      resume_situation: d.resume_situation,
      email_count: ((emails as EmailRow[] | null) || []).length,
      subjects,
      senders: [...new Set(senders)],
      case_references: [...new Set(caseRefs)],
      opposing_parties: [...new Set(opposingParties)],
    });
  }

  // === ÉTAPE 2 — GPT-4o pour identifier les groupes ===
  const dossiersForPrompt = dossiersData.map((d) => {
    return "ID: " + d.id + "\n" +
      "Nom: " + d.nom_client + " (" + d.email_client + ")\n" +
      "Emails (" + d.email_count + "): " + d.subjects.join(" | ") + "\n" +
      "Expéditeurs: " + d.senders.join(", ") + "\n" +
      "Références RG: " + (d.case_references.length > 0 ? d.case_references.join(", ") : "aucune") + "\n" +
      "Parties adverses: " + (d.opposing_parties.length > 0 ? d.opposing_parties.join(", ") : "aucune") + "\n" +
      "Domaine: " + (d.domaine || "non défini") + "\n" +
      "Résumé: " + (d.resume_situation || "aucun");
  }).join("\n---\n");

  const systemPrompt = "Tu es Donna, assistante juridique IA. Voici une liste de dossiers créés automatiquement. Beaucoup sont en fait des fragments d'une même affaire (ex: un dossier pour le client, un pour son avocat adverse, un pour le greffe, mais tous concernent la même affaire).\n\n" +
    "Regroupe-les en VRAIS dossiers juridiques. Un dossier = une affaire/un litige/une procédure.\n\n" +
    "INDICES pour regrouper :\n" +
    "- Même référence RG → même affaire\n" +
    "- Même partie adverse → probablement même affaire\n" +
    "- Mêmes noms dans les sujets d'emails (ex: 'Dupont c/ Martin' dans plusieurs dossiers)\n" +
    "- Un avocat qui écrit au sujet du même client → même dossier que le client\n" +
    "- Un greffe/tribunal qui envoie une convocation mentionnant les mêmes parties\n" +
    "- Un syndic et un client qui parlent de la même copropriété\n" +
    "- Un notaire et des héritiers qui parlent de la même succession\n" +
    "- Emails internes du cabinet (comptabilité, assurance, formation) → regrouper dans un dossier 'Gestion Cabinet'\n\n" +
    "Les dossiers qui ne peuvent être rattachés à aucune affaire mais sont de la gestion interne du cabinet (formation, assurance, comptabilité) doivent être regroupés dans un seul dossier 'Gestion Cabinet'.\n\n" +
    "Pour chaque groupe, donne :\n" +
    "- Le nom du dossier fusionné (format: 'Nom Client c/ Partie Adverse — Type' ou 'Nom Client — Type procédure')\n" +
    "- Les IDs des dossiers à fusionner\n" +
    "- Le client principal (la personne physique ou morale que l'avocate représente)\n" +
    "- La partie adverse si applicable\n" +
    "- La référence RG si trouvée\n" +
    "- Le domaine juridique\n" +
    "- Un résumé de la situation en 2-3 phrases\n\n" +
    "Renvoie UNIQUEMENT un JSON valide :\n" +
    '{\n  "groups": [\n    {\n      "merged_name": "Dupont c/ Martin — Litige bail commercial",\n      "dossier_ids": ["uuid1", "uuid2", "uuid3"],\n      "client_name": "Michel Dupont",\n      "opposing_party": "Jean-Pierre Martin",\n      "case_reference": "RG 24/03421",\n      "domaine": "droit commercial",\n      "resume_situation": "Litige entre le bailleur et le locataire..."\n    }\n  ]\n}';

  console.log("🤖 Merger: appel GPT-4o pour analyse des groupes...");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    store: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Voici les " + dossiersData.length + " dossiers avec leurs emails :\n\n" + dossiersForPrompt },
    ],
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: "json_object" },
  });

  const raw = (completion.choices[0].message.content || "").trim();
  let parsed: { groups?: MergeGroup[] };
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr: unknown) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error("❌ Merger: erreur parsing GPT response:", message);
    console.error("Raw:", raw.substring(0, 500));
    throw new Error("Erreur parsing réponse GPT");
  }

  const groups: MergeGroup[] = parsed.groups || [];
  console.log("🔀 Merger: " + groups.length + " groupes identifiés par GPT");

  // === ÉTAPE 3 — Exécuter les fusions ===
  let mergedCount = 0;
  const resultGroups: ResultGroup[] = [];

  for (const group of groups) {
    const ids = group.dossier_ids || [];
    if (ids.length === 0) continue;

    // Vérifier que les IDs existent parmi nos dossiers
    const validIds = ids.filter((id) => dossiersData.some((d) => d.id === id));

    if (validIds.length === 0) {
      console.warn("⚠️ Merger: groupe '" + group.merged_name + "' — aucun ID valide, skip");
      continue;
    }

    const primaryId = validIds[0];
    const secondaryIds = validIds.slice(1);

    console.log("🔀 Fusionner: " + group.merged_name + " (" + validIds.length + " dossiers → 1)");

    // a. Rattacher les emails des dossiers secondaires au dossier principal
    if (secondaryIds.length > 0) {
      for (const secId of secondaryIds) {
        const { error: moveErr } = await supabase
          .from("emails")
          .update({ dossier_id: primaryId })
          .eq("dossier_id", secId);

        if (moveErr) {
          console.error("❌ Merger: erreur déplacement emails de " + secId + ":", moveErr.message);
        }
      }
    }

    // b. Compter les emails du dossier fusionné
    const { count: emailCount } = await supabase
      .from("emails")
      .select("*", { count: "exact", head: true })
      .eq("dossier_id", primaryId);

    // c. Mettre à jour le dossier principal
    const updateData: DossierUpdateData = {
      nom_client: group.client_name || group.merged_name,
      email_count: emailCount || 0,
    };
    if (group.opposing_party) updateData.opposing_party = group.opposing_party;
    if (group.case_reference) updateData.case_reference = group.case_reference;
    if (group.domaine) updateData.domaine = group.domaine;
    if (group.resume_situation) updateData.resume_situation = group.resume_situation;

    const { error: updateErr } = await supabase
      .from("dossiers")
      .update(updateData)
      .eq("id", primaryId);

    if (updateErr) {
      console.error("❌ Merger: erreur update dossier principal:", updateErr.message);
    }

    // d. Supprimer les dossiers secondaires (maintenant vides)
    if (secondaryIds.length > 0) {
      const { error: deleteErr } = await supabase
        .from("dossiers")
        .delete()
        .in("id", secondaryIds);

      if (deleteErr) {
        console.error("❌ Merger: erreur suppression dossiers secondaires:", deleteErr.message);
      }
    }

    mergedCount += secondaryIds.length;
    resultGroups.push({
      name: group.merged_name,
      primary_id: primaryId,
      merged_from: validIds.length,
      email_count: emailCount,
    });

    console.log("   ✅ " + group.merged_name + " — " + emailCount + " emails");
  }

  // Compter les dossiers restants
  const { count: finalCount } = await supabase
    .from("dossiers")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  console.log("🔀 Merger terminé: " + dossiers.length + " dossiers → " + finalCount + " dossiers (" + mergedCount + " fusionnés)");

  return {
    original_count: dossiers.length,
    merged: mergedCount,
    final_count: finalCount,
    groups: resultGroups,
  };
}
