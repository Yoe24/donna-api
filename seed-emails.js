require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const UID = '9082c497-0efe-401f-978a-e43cc149ff57';

// Génère une date ISO 8601 à N jours dans le passé, à une heure précise
function daysAgoAt(n, hour, minute) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const emails = [
  // === DOSSIER 1 — Dupont c/ Martin (bail commercial, URGENT) ===
  // Audience TGI: 4 avril 2026 (+11j) — Conclusions deadline: 28 mars 2026 (+4j)
  {
    expediteur: 'Greffe TGI Paris <greffe.tgi.paris@justice.fr>',
    objet: 'Mise au rôle — RG 24/03421',
    body: "Madame, Monsieur,\n\nNous avons l'honneur de vous informer que l'affaire SARL Dupont Immobilier c/ Martin Jean-Pierre a été inscrite au rôle général sous le numéro RG 24/03421.\n\nL'audience de mise en état est fixée au 4 avril 2026. Les parties sont invitées à échanger leurs conclusions au plus tard 15 jours avant l'audience.\n\nLe Greffe du Tribunal judiciaire de Paris",
    created_at: daysAgoAt(28, 9, 15)
  },
  {
    expediteur: 'Michel Dupont <m.dupont@gmail.com>',
    objet: 'Question sur mon dossier bail',
    body: "Bonjour Maître Fernandez,\n\nJ'ai reçu un courrier de l'avocat de M. Martin qui dit que je lui dois des arriérés de charges. C'est faux, j'ai tout payé. Est-ce que vous avez besoin que je vous envoie mes relevés bancaires ?\n\nAussi, est-ce que l'audience est toujours maintenue au 4 avril ? Je dois poser un jour de congé.\n\nMerci pour votre aide.\nMichel Dupont",
    created_at: daysAgoAt(18, 14, 32)
  },
  {
    expediteur: 'Me Laurent Bernard <maitre.bernard@avocats-paris.fr>',
    objet: 'Pièces complémentaires demandées — Dupont c/ Martin',
    body: "Chère Consoeur,\n\nSuite à notre échange téléphonique, pourriez-vous me transmettre les relevés bancaires de la SARL Dupont Immobilier pour la période de janvier à juin 2025 ? Mon client conteste le montant des charges locatives facturées.\n\nPar ailleurs, le bail commercial initial signé en 2019 semble comporter une clause de révision triennale que nous souhaitons examiner.\n\nBien confraternellement,\nMe Bernard",
    created_at: daysAgoAt(12, 10, 47)
  },
  {
    expediteur: 'Me Laurent Bernard <maitre.bernard@avocats-paris.fr>',
    objet: 'RE: Conclusions adverses — Dupont c/ Martin RG 24/03421',
    body: "Chère Consoeur,\n\nVeuillez trouver ci-joint les conclusions en défense de mon client M. Martin. Il conteste formellement la résiliation du bail commercial et invoque l'article L.145-41 du Code de commerce.\n\nJe sollicite un renvoi de l'audience du 4 avril pour permettre à mon client de réunir les justificatifs de paiement des loyers Q3 et Q4 2025.\n\nDans l'attente de votre retour, je vous prie d'agréer, Chère Consoeur, l'expression de mes sentiments distingués.\n\nMe Laurent Bernard",
    created_at: daysAgoAt(5, 16, 22)
  },
  {
    expediteur: 'Greffe TGI Paris <greffe.tgi.paris@justice.fr>',
    objet: 'Convocation audience TGI Paris — RG 24/03421 — Dupont c/ Martin',
    body: "Madame, Monsieur,\n\nVous êtes convoqué(e) à l'audience du 4 avril 2026 à 14h00, salle 4.12 du Tribunal judiciaire de Paris, dans l'affaire enregistrée sous le numéro RG 24/03421.\n\nParties : SARL Dupont Immobilier (demanderesse) c/ M. Jean-Pierre Martin (défendeur).\n\nVous êtes prié(e) de vous présenter muni(e) de l'original de vos conclusions et de l'ensemble des pièces communiquées.\n\nLe Greffier en chef,\nMme Leblanc",
    created_at: daysAgoAt(1, 11, 33)
  },

  // === DOSSIER 2 — Divorce Lemaire (droit de la famille) ===
  // Audience JAF: 8 avril 2026 (+15j)
  {
    expediteur: 'Sophie Lemaire <sophie.lemaire@orange.fr>',
    objet: 'Fiches de paie et avis d\'imposition en PJ',
    body: "Bonjour Maître,\n\nComme convenu, je vous transmets en pièces jointes :\n1. Fiche de paie novembre 2025\n2. Fiche de paie décembre 2025\n3. Fiche de paie janvier 2026\n4. Avis d'imposition 2025 sur les revenus 2024\n\nDites-moi si vous avez besoin d'autres documents.\n\nCordialement,\nSophie Lemaire",
    created_at: daysAgoAt(22, 9, 41)
  },
  {
    expediteur: 'Sophie Lemaire <sophie.lemaire@orange.fr>',
    objet: 'RE: Documents pour la pension alimentaire',
    body: "Maître,\n\nVoici les documents que vous m'avez demandés :\n- Mes 3 dernières fiches de paie (novembre, décembre 2025, janvier 2026)\n- Mon avis d'imposition 2025\n- Les factures de la cantine et des activités extrascolaires des enfants\n\nMon salaire net est de 2 150€/mois. Mon ex-mari gagne environ 4 500€ selon sa dernière déclaration.\n\nSophie",
    created_at: daysAgoAt(15, 11, 18)
  },
  {
    expediteur: 'JAF Lyon <jaf.lyon@justice.fr>',
    objet: 'Convocation JAF Lyon — Lemaire c/ Lemaire — 8 avril 2026',
    body: "Madame, Monsieur,\n\nVous êtes convoqué(e) devant le Juge aux Affaires Familiales du Tribunal judiciaire de Lyon, le 8 avril 2026 à 10h30, salle 2.04.\n\nAffaire : Mme Sophie Lemaire née Dupuis c/ M. Pierre Lemaire\nObjet : Fixation de la résidence des enfants mineurs, droit de visite et d'hébergement, pension alimentaire.\n\nVeuillez vous munir de l'ensemble des pièces justificatives.\n\nLe Greffe du JAF",
    created_at: daysAgoAt(10, 8, 30)
  },
  {
    expediteur: 'Me Philippe Durand <maitre.durand@barreau-lyon.fr>',
    objet: 'Proposition calendrier de garde — Dossier Lemaire',
    body: "Chère Consoeur,\n\nAprès concertation avec mon client M. Lemaire, je vous transmets sa contre-proposition de calendrier de garde :\n- Semaines paires : du vendredi 18h au dimanche 19h chez le père\n- Mercredis : alternance une semaine sur deux\n- Vacances scolaires : partage par moitié\n\nMon client insiste sur le fait qu'il souhaite maintenir un lien fort avec ses enfants. Il propose également une médiation familiale.\n\nConfraternellement,\nMe Durand",
    created_at: daysAgoAt(6, 15, 45)
  },
  {
    expediteur: 'Sophie Lemaire <sophie.lemaire@orange.fr>',
    objet: 'Garde des enfants — mon ex-mari refuse le calendrier',
    body: "Bonjour Maître,\n\nJe suis désespérée. Mon ex-mari refuse catégoriquement le calendrier de garde que vous avez proposé. Il dit qu'il veut les enfants un week-end sur deux ET tous les mercredis, ce qui est impossible avec mon travail.\n\nEn plus, il a déménagé à 40km sans me prévenir. Les enfants se plaignent du trajet.\n\nQu'est-ce qu'on peut faire ? L'audience au JAF est dans 2 semaines.\n\nMerci,\nSophie",
    created_at: daysAgoAt(2, 18, 12)
  },
  {
    expediteur: 'Sophie Lemaire <sophie.lemaire@orange.fr>',
    objet: 'Merci pour votre aide Maître',
    body: "Bonjour Maître Fernandez,\n\nJe voulais simplement vous remercier pour votre disponibilité et votre soutien. Cette période est très difficile pour moi et les enfants, et savoir que vous gérez les choses me rassure énormément.\n\nJ'ai confiance en vous pour l'audience du 8 avril.\n\nBonne journée,\nSophie",
    created_at: daysAgoAt(0, 8, 22)
  },

  // === DOSSIER 3 — SCI Les Oliviers (copropriété) ===
  // AG tenue le 20 mars 2026 — Deadline contestation AG: 2 avril 2026 (+9j)
  {
    expediteur: 'Syndic Foncia Sud <syndic@foncia-sud.fr>',
    objet: 'Relance impayés charges Q4 2025 — SCI Les Oliviers',
    body: "Madame, Monsieur,\n\nNous vous informons que les charges de copropriété du 4ème trimestre 2025 pour les lots n°12 et n°14 (SCI Les Oliviers) restent impayées à ce jour.\n\nMontant dû : 4 876,32€\nÉchéance dépassée : 31/12/2025\n\nNous vous prions de régulariser sous 15 jours, faute de quoi une procédure de recouvrement sera engagée.\n\nService Comptabilité — Foncia Sud",
    created_at: daysAgoAt(25, 10, 5)
  },
  {
    expediteur: 'Patrick Garcia <p.garcia@sci-oliviers.fr>',
    objet: 'Devis travaux toiture — à contester',
    body: "Maître,\n\nCI-joint le devis initial de l'entreprise Bertrand BTP pour la toiture : 45 000€ TTC.\n\nJ'ai fait faire un contre-devis par l'entreprise Martin Couverture : 28 500€ TTC pour des prestations équivalentes.\n\nJe pense que le syndic a un accord avec Bertrand BTP. Peut-on demander une mise en concurrence obligatoire ?\n\nCordialement,\nPatrick Garcia",
    created_at: daysAgoAt(17, 14, 28)
  },
  {
    expediteur: 'Patrick Garcia <p.garcia@sci-oliviers.fr>',
    objet: 'RE: Contestation charges copropriété 2025',
    body: "Maître Fernandez,\n\nJ'ai bien reçu votre courrier au syndic contestant la répartition des charges 2025. Foncia ne m'a toujours pas répondu.\n\nLe problème principal : ils nous facturent des charges d'ascenseur alors que nos lots (RDC + 1er étage) n'en bénéficient pas. Ça représente 3 200€ sur l'année.\n\nPar ailleurs, le devis toiture de 45 000€ me semble très excessif. J'ai obtenu un contre-devis à 28 000€.\n\nPouvez-vous contester l'AG ?\nPatrick Garcia — Gérant SCI Les Oliviers",
    created_at: daysAgoAt(9, 11, 50)
  },
  {
    expediteur: 'Syndic Foncia Sud <syndic@foncia-sud.fr>',
    objet: 'PV AG extraordinaire — Résidence Les Oliviers',
    body: "Madame, Monsieur,\n\nVeuillez trouver ci-joint le procès-verbal de l'Assemblée Générale extraordinaire de la copropriété Les Oliviers, tenue le 20 mars 2026.\n\nRésolutions adoptées :\n- Travaux de réfection toiture : ADOPTÉE (majorité art. 25)\n- Appel de fonds exceptionnel de 45 000€ : ADOPTÉE\n- Changement de syndic : REJETÉE\n\nVous disposez d'un délai de 2 mois pour contester les résolutions conformément à l'article 42 de la loi du 10 juillet 1965.\n\nFoncia Sud — Service Copropriété",
    created_at: daysAgoAt(3, 16, 35)
  },

  // === DOSSIER 4 — Licenciement Petit (droit du travail) ===
  // Entretien préalable: 31 mars 2026 (+7j)
  {
    expediteur: 'Inspection du Travail <inspection.travail@direccte.gouv.fr>',
    objet: 'Accusé réception signalement — Entreprise XYZ',
    body: "Monsieur,\n\nNous accusons réception de votre signalement en date du 4 mars 2026 concernant des faits de harcèlement moral au sein de l'entreprise XYZ SAS.\n\nVotre dossier a été enregistré sous la référence IT-2026-1847.\n\nUn inspecteur du travail prendra contact avec vous dans un délai de 3 semaines pour fixer un rendez-vous.\n\nInspection du Travail — DIRECCTE Île-de-France",
    created_at: daysAgoAt(20, 9, 12)
  },
  {
    expediteur: 'Thomas Petit <thomas.petit@gmail.com>',
    objet: 'Harcèlement au travail — preuves',
    body: "Maître,\n\nDepuis 3 mois, mon supérieur hiérarchique M. Garnier me met à l'écart. Il m'a retiré mes dossiers principaux, m'exclut des réunions d'équipe, et a envoyé un email à toute l'équipe en me dénigrant.\n\nJ'ai conservé :\n- Les emails de dénigrement (captures d'écran)\n- Les témoignages de 2 collègues qui ont vu la scène\n- Un certificat médical de mon médecin (arrêt stress)\n\nEst-ce suffisant pour un dossier de harcèlement moral ?\n\nThomas",
    created_at: daysAgoAt(14, 19, 45)
  },
  {
    expediteur: 'Thomas Petit <thomas.petit@gmail.com>',
    objet: 'RE: Mes bulletins de salaire et contrat en PJ',
    body: "Maître,\n\nVoici les documents demandés :\n- Mon contrat de travail CDI signé en 2014\n- Mes 12 derniers bulletins de salaire\n- Mon dernier entretien annuel (note : Très satisfaisant)\n- La convention collective applicable (Syntec)\n\nMon salaire brut est de 3 800€/mois. Avec 12 ans d'ancienneté, quelle serait mon indemnité si je me fais licencier ?\n\nThomas",
    created_at: daysAgoAt(8, 12, 33)
  },
  {
    expediteur: 'Service RH <rh@entreprise-xyz.fr>',
    objet: 'Convocation entretien préalable — M. Petit Thomas',
    body: "Monsieur Petit,\n\nConformément aux articles L.1232-2 et suivants du Code du travail, nous vous convoquons à un entretien préalable à une éventuelle mesure de licenciement.\n\nDate : Mardi 31 mars 2026 à 10h00\nLieu : Bureau de la DRH, 3ème étage\n\nVous pouvez vous faire assister par une personne de votre choix appartenant au personnel de l'entreprise ou par un conseiller du salarié.\n\nService des Ressources Humaines\nEntreprise XYZ",
    created_at: daysAgoAt(4, 9, 5)
  },
  {
    expediteur: 'Thomas Petit <thomas.petit@gmail.com>',
    objet: 'Mon employeur me menace de licenciement',
    body: "Maître Fernandez,\n\nJe suis paniqué. Mon directeur m'a convoqué aujourd'hui et m'a dit texto : \"Si tu ne signes pas une rupture conventionnelle, on te vire pour faute grave.\"\n\nJe n'ai commis aucune faute. Je pense qu'ils veulent me remplacer par quelqu'un de moins cher. J'ai 12 ans d'ancienneté.\n\nJ'ai enregistré la conversation sur mon téléphone. Est-ce que c'est utilisable ?\n\nAidez-moi s'il vous plaît.\nThomas Petit",
    created_at: daysAgoAt(0, 10, 17)
  },

  // === DOSSIER 5 — Succession Moreau (droit civil) ===
  // Décès: 26 février 2026 — Deadline réponse contestation: 7 avril 2026 (+14j)
  {
    expediteur: 'Claire Moreau <claire.moreau@gmail.com>',
    objet: 'Acte de décès et testament en PJ',
    body: "Bonjour Maître,\n\nVoici les documents importants :\n1. Acte de décès de ma mère (26 février 2026)\n2. Testament olographe original (daté du 14 septembre 2023)\n3. Certificat médical du Dr Blanchard attestant de la lucidité de ma mère en septembre 2023\n4. Livret de famille\n\nDites-moi si vous acceptez de me représenter dans cette succession.\n\nCordialement,\nClaire Moreau",
    created_at: daysAgoAt(26, 15, 20)
  },
  {
    expediteur: 'Jean Moreau <jean.moreau@hotmail.fr>',
    objet: 'Je conteste le testament de ma mère',
    body: "Maître Fernandez,\n\nJe suis le fils de Jeanne Moreau et je conteste le testament qui avantage ma soeur Claire.\n\nMa mère souffrait de la maladie d'Alzheimer depuis 2022. Le testament daté de 2023 ne peut pas être valable.\n\nJe vais engager un avocat pour demander la nullité du testament sur le fondement de l'article 901 du Code civil (insanité d'esprit).\n\nJe vous préviens par courtoisie.\n\nJean Moreau",
    created_at: daysAgoAt(19, 17, 38)
  },
  {
    expediteur: 'Me Claire Leroy <notaire.leroy@notaires-paris.fr>',
    objet: 'Inventaire des biens — Succession Moreau',
    body: "Chère Consoeur,\n\nVeuillez trouver ci-joint l'inventaire provisoire des biens de la succession Moreau :\n\n- Résidence principale (Neuilly) : estimée 350 000€\n- Compte courant BNP : 23 456€\n- Assurance-vie Axa : 85 000€ (bénéficiaire : Claire Moreau)\n- Mobilier et objets : estimation en cours\n- Dettes : crédit immobilier restant 42 000€\n\nActif net provisoire : environ 416 000€\n\nMe Leroy",
    created_at: daysAgoAt(14, 10, 55)
  },
  {
    expediteur: 'Claire Moreau <claire.moreau@gmail.com>',
    objet: 'Désaccord entre héritiers — que faire ?',
    body: "Maître Fernandez,\n\nMon frère Jean refuse d'accepter le testament de notre mère. Il dit que maman n'était \"plus en état de tester\" quand elle l'a rédigé.\n\nC'est faux. Le testament a été rédigé en 2023, quand maman allait bien. Son médecin traitant peut en témoigner.\n\nJean menace de saisir le tribunal pour contester le testament. Quelles sont mes chances de le défendre ?\n\nLa maison vaut environ 350 000€.\n\nClaire Moreau",
    created_at: daysAgoAt(7, 13, 42)
  },
  {
    expediteur: 'Me Claire Leroy <notaire.leroy@notaires-paris.fr>',
    objet: 'Ouverture succession Mme Moreau — acte de notoriété',
    body: "Chère Consoeur,\n\nJe vous informe que j'ai été chargée du règlement de la succession de Mme Jeanne Moreau, décédée le 26 février 2026.\n\nHéritiers identifiés : Mme Claire Moreau (fille) et M. Jean Moreau (fils).\n\nUn testament olographe a été découvert, léguant la résidence principale à Mme Claire Moreau. M. Jean Moreau conteste ce testament.\n\nPourriez-vous me confirmer que vous représentez Mme Claire Moreau dans cette succession ?\n\nConfraternellement,\nMe Leroy, Notaire",
    created_at: daysAgoAt(3, 9, 30)
  },

  // === DOSSIER 6 — Divers / Non rattachables ===
  {
    expediteur: 'Greffe Tribunal Commerce <greffe.tribunal-commerce@justice.fr>',
    objet: 'Extrait Kbis — SCI Les Oliviers',
    body: "Madame,\n\nSuite à votre demande du 27 février 2026, veuillez trouver ci-joint l'extrait Kbis de la SCI Les Oliviers (SIREN 823 456 789).\n\nGérant : M. Patrick Garcia\nSiège social : 45 avenue des Oliviers, 13008 Marseille\nCapital : 150 000€\n\nCe document est valable 3 mois.\n\nGreffe du Tribunal de Commerce de Marseille",
    created_at: daysAgoAt(20, 11, 22)
  },
  {
    expediteur: 'Legal Tech News <legal-tech@lefigaro.fr>',
    objet: 'Newsletter juridique — Réforme du divorce par consentement mutuel 2026',
    body: "Bonjour,\n\nÀ la une cette semaine :\n\n1. Réforme du divorce : le décret d'application du 1er mars 2026 modifie les délais de réflexion\n2. Intelligence artificielle et justice : la Cour de cassation publie ses recommandations\n3. Avocats et RGPD : nouvelles obligations déclaratives\n\nLire la suite sur lefigaro.fr/legal-tech\n\nSe désabonner",
    created_at: daysAgoAt(13, 8, 15)
  },
  {
    expediteur: 'Comptabilité Cabinet <compta@cabinet-fernandez.fr>',
    objet: 'Factures impayées clients — relance trimestrielle',
    body: "Bonjour Alexandra,\n\nVoici le point sur les factures impayées au 15 mars 2026 :\n\n- Dossier Dupont : 2 400€ HT (facture du 15/01/2026, relance 1 envoyée)\n- Dossier Garcia/SCI : 1 800€ HT (facture du 01/02/2026)\n- Dossier Petit : 600€ HT (provision initiale, facture du 10/03/2026)\n\nTotal impayé : 4 800€ HT\n\nMerci de me dire si je relance ou si certains dossiers sont en attente de réglement amiable.\n\nMartine — Comptabilité",
    created_at: daysAgoAt(9, 14, 50)
  },
  {
    expediteur: 'MAAF Pro <assurance@maaf-pro.fr>',
    objet: 'Renouvellement RC Pro — échéance 1er avril 2026',
    body: "Maître Fernandez,\n\nVotre contrat de Responsabilité Civile Professionnelle n° RCP-2024-78432 arrive à échéance le 1er avril 2026.\n\nMontant de la prime 2026 : 1 245€ TTC (en hausse de 3,2%)\nGarantie : 1 500 000€ par sinistre\n\nMerci de nous retourner le bulletin de renouvellement signé avant le 30 mars 2026.\n\nService Professions Libérales — MAAF",
    created_at: daysAgoAt(5, 10, 8)
  },
  {
    expediteur: 'Ordre des Avocats <ordre-avocats@barreau-paris.fr>',
    objet: 'Formation continue obligatoire — Rappel inscription',
    body: "Chère Consoeur,\n\nNous vous rappelons que votre obligation de formation continue pour l'année 2026 n'est pas encore satisfaite.\n\nHeures réalisées : 8h / 20h obligatoires\n\nNous vous invitons à consulter le catalogue des formations disponibles sur notre plateforme et à vous inscrire avant le 30 juin 2026.\n\nLe Bâtonnier",
    created_at: daysAgoAt(3, 16, 40)
  },
];

async function run() {
  console.log('Inserting', emails.length, 'emails...');
  var inserted = [];
  for (var i = 0; i < emails.length; i++) {
    var e = emails[i];
    var { data, error } = await s.from('emails').insert({
      user_id: UID,
      expediteur: e.expediteur,
      objet: e.objet,
      resume: null,
      brouillon: null,
      pipeline_step: 'en_attente',
      statut: 'en_attente',
      contexte_choisi: 'standard',
      metadata: { body: e.body },
      created_at: e.created_at
    }).select('id, objet').single();

    if (error) {
      console.log('ERROR email ' + (i+1) + ':', error.message);
    } else {
      inserted.push(data);
      console.log('✅ ' + (i+1) + '/' + emails.length + ' — ' + data.objet.substring(0, 60));
    }
  }
  console.log('\n=== ' + inserted.length + ' emails insérés ===');

  // Output IDs as JSON for the processing script
  var fs = require('fs');
  var idMap = inserted.map(function(e, i) {
    return { id: e.id, objet: e.objet, body: emails[i].body, sender: emails[i].expediteur };
  });
  fs.writeFileSync('/var/www/donna-api/seed-ids.json', JSON.stringify(idMap, null, 2));
  console.log('IDs saved to seed-ids.json');
}

run().catch(console.error);
