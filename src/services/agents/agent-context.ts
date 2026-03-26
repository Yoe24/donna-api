import { supabase } from "../../config/supabase";

interface GetEmailContextParams {
  senderEmail: string;
  userId: string;
}

interface EmailRecord {
  objet: string;
  resume: string;
  brouillon: string;
  created_at: string;
}

interface DocumentRecord {
  nom_fichier: string;
  contenu_extrait: string;
  date_reception: string;
}

interface EmailContext {
  dossier: Record<string, any> | null;
  emails_recents: EmailRecord[];
  documents_recents: DocumentRecord[];
}

const FALLBACK: EmailContext = { dossier: null, emails_recents: [], documents_recents: [] };

export async function getEmailContext({ senderEmail, userId }: GetEmailContextParams): Promise<EmailContext> {
  try {
    // 1. Cherche le dossier correspondant à l'email expéditeur
    const { data: dossiers, error: dossierError } = await supabase
      .from("dossiers")
      .select("*")
      .eq("user_id", userId)
      .ilike("email_client", senderEmail.trim().toLowerCase())
      .limit(1);

    if (dossierError) {
      console.error("❌ agent-context: dossier lookup error:", dossierError.message);
      return FALLBACK;
    }

    if (!dossiers || dossiers.length === 0) {
      console.log("📂 agent-context: aucun dossier trouvé pour", senderEmail);
      return FALLBACK;
    }

    const dossier = dossiers[0];
    console.log("📂 agent-context: dossier trouvé —", dossier.nom_client, "(id:", dossier.id + ")");

    // 2. Récupère les 5 derniers emails liés à ce dossier
    const { data: emails_recents, error: emailsError } = await supabase
      .from("emails")
      .select("objet, resume, brouillon, created_at")
      .eq("dossier_id", dossier.id)
      .order("created_at", { ascending: false })
      .limit(5);

    if (emailsError) {
      console.error("❌ agent-context: emails lookup error:", emailsError.message);
    }

    // 3. Récupère les 5 derniers documents liés à ce dossier
    const { data: documents_recents, error: docsError } = await supabase
      .from("dossier_documents")
      .select("nom_fichier, contenu_extrait, date_reception")
      .eq("dossier_id", dossier.id)
      .order("date_reception", { ascending: false })
      .limit(5);

    if (docsError) {
      console.error("❌ agent-context: documents lookup error:", docsError.message);
    }

    return {
      dossier,
      emails_recents: (emails_recents as EmailRecord[]) || [],
      documents_recents: (documents_recents as DocumentRecord[]) || [],
    };
  } catch (e: any) {
    console.error("❌ agent-context: unexpected error:", e.message);
    return FALLBACK;
  }
}
