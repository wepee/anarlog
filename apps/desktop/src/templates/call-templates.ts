import type { TemplateSection } from "@anlg/store";

import { insertUserTemplate, listUserTemplates } from "./queries";

import { getStoredSettingValues, setSettingValue } from "~/settings/queries";

type CallTemplateDefinition = {
  title: string;
  description: string;
  sections: TemplateSection[];
};

// The six call types were chosen from a simulation on real calls (see the
// Live Assist v2 spec): with them, the type of 13 of 15 calls fit well and
// no wrong type was ever shown live. Their sections double as the points
// Live Assist tracks during the call, so each section names something the
// summary needs to be filled.
const CALL_TEMPLATES: Record<"fr" | "en", CallTemplateDefinition[]> = {
  fr: [
    {
      title: "Commercial",
      description:
        "Prospect ou client potentiel : découverte, démo, proposition, négociation, accord de distribution que vous proposez.",
      sections: [
        {
          title: "Contexte et besoin",
          description: "Situation du prospect et besoin exprimé.",
        },
        {
          title: "Décideurs",
          description: "Qui décide, qui valide, qui influence.",
        },
        {
          title: "Budget",
          description: "Budget annoncé ou fourchette, modalités.",
        },
        {
          title: "Objections",
          description: "Freins, doutes et réponses apportées.",
        },
        {
          title: "Prochaines étapes",
          description: "Ce qui est convenu, avec responsables et dates.",
        },
      ],
    },
    {
      title: "Coaching",
      description:
        "Séance avec une personne accompagnée : restitution d'audit, plan d'action, onboarding d'un nouveau coaché.",
      sections: [
        {
          title: "Situation",
          description:
            "Où en est la personne, ce qui a changé depuis la dernière fois.",
        },
        {
          title: "Recommandations",
          description: "Conseils et pistes donnés pendant la séance.",
        },
        {
          title: "Plan d'action",
          description: "Actions concrètes à mener, avec échéances.",
        },
        {
          title: "Blocages",
          description: "Ce qui freine et comment le lever.",
        },
        {
          title: "Prochaine séance",
          description: "Date et objectif du prochain rendez-vous.",
        },
      ],
    },
    {
      title: "Projet client",
      description:
        "Projet signé : kickoff, point d'avancement, revue ou livraison.",
      sections: [
        {
          title: "Objectifs et périmètre",
          description: "Ce que le projet doit produire et ses limites.",
        },
        { title: "Avancement", description: "Ce qui est fait, ce qui reste." },
        {
          title: "Retours et validations",
          description: "Retours du client et points validés.",
        },
        {
          title: "Changements",
          description: "Demandes ou changements de périmètre.",
        },
        {
          title: "Prochaines échéances",
          description: "Dates et livrables à venir.",
        },
      ],
    },
    {
      title: "Équipe",
      description:
        "Réunion interne ou entre associés, même avec un conseiller présent.",
      sections: [
        { title: "Décisions", description: "Ce qui a été décidé." },
        { title: "Responsables", description: "Qui prend quoi en charge." },
        {
          title: "Blocages",
          description: "Ce qui bloque et l'aide nécessaire.",
        },
        { title: "Échéances", description: "Dates à tenir." },
      ],
    },
    {
      title: "Partenaire",
      description:
        "Fournisseur, prestataire ou partenaire qui vous propose quelque chose.",
      sections: [
        { title: "Offre", description: "Ce qui est proposé." },
        { title: "Conditions", description: "Prix, durée, modalités." },
        { title: "Engagement", description: "Ce que chacun s'engage à faire." },
        {
          title: "Prochaines étapes",
          description: "Suite convenue, avec dates.",
        },
      ],
    },
    {
      title: "Entretien",
      description: "Recrutement ou entretien avec un freelance.",
      sections: [
        { title: "Parcours", description: "Expérience et compétences." },
        {
          title: "Motivations",
          description: "Pourquoi cette personne, pourquoi maintenant.",
        },
        {
          title: "Disponibilité",
          description: "Disponibilité, rythme, localisation.",
        },
        {
          title: "Rémunération",
          description: "Attentes de rémunération ou tarif.",
        },
        { title: "Prochaines étapes", description: "Suite du processus." },
      ],
    },
  ],
  en: [
    {
      title: "Sales",
      description:
        "A prospect or potential client: discovery, demo, proposal, negotiation, a distribution deal you pitch.",
      sections: [
        {
          title: "Context and need",
          description: "The prospect's situation and stated need.",
        },
        {
          title: "Decision makers",
          description: "Who decides, who signs off, who influences.",
        },
        { title: "Budget", description: "Stated budget or range, terms." },
        {
          title: "Objections",
          description: "Concerns raised and how they were answered.",
        },
        {
          title: "Next steps",
          description: "What was agreed, with owners and dates.",
        },
      ],
    },
    {
      title: "Coaching",
      description:
        "A session with someone you coach: audit review, action plan, onboarding a new coachee.",
      sections: [
        {
          title: "Situation",
          description: "Where the person stands, what changed since last time.",
        },
        {
          title: "Recommendations",
          description: "Advice and directions given in the session.",
        },
        {
          title: "Action plan",
          description: "Concrete actions with deadlines.",
        },
        {
          title: "Blockers",
          description: "What holds them back and how to unblock it.",
        },
        {
          title: "Next session",
          description: "Date and goal of the next meeting.",
        },
      ],
    },
    {
      title: "Client project",
      description:
        "A signed project: kickoff, progress update, review or delivery.",
      sections: [
        {
          title: "Goals and scope",
          description: "What the project must deliver and its limits.",
        },
        { title: "Progress", description: "What is done and what remains." },
        {
          title: "Feedback and sign-offs",
          description: "Client feedback and approved items.",
        },
        { title: "Changes", description: "Requests and scope changes." },
        {
          title: "Upcoming deadlines",
          description: "Dates and deliverables ahead.",
        },
      ],
    },
    {
      title: "Team",
      description:
        "An internal meeting or one between partners, even with an advisor present.",
      sections: [
        { title: "Decisions", description: "What was decided." },
        { title: "Owners", description: "Who takes what." },
        {
          title: "Blockers",
          description: "What is blocked and the help needed.",
        },
        { title: "Deadlines", description: "Dates to hold." },
      ],
    },
    {
      title: "Partner",
      description: "A supplier, provider or partner offering you something.",
      sections: [
        { title: "Offer", description: "What is offered." },
        { title: "Terms", description: "Price, duration, conditions." },
        { title: "Commitments", description: "What each side commits to." },
        { title: "Next steps", description: "Agreed follow-up, with dates." },
      ],
    },
    {
      title: "Interview",
      description: "A hiring or freelancer interview.",
      sections: [
        { title: "Background", description: "Experience and skills." },
        { title: "Motivation", description: "Why this person, why now." },
        { title: "Availability", description: "Availability, pace, location." },
        { title: "Compensation", description: "Pay or rate expectations." },
        { title: "Next steps", description: "Next steps in the process." },
      ],
    },
  ],
};

export function getCallTemplateDefinitions(
  language: string | null | undefined,
): CallTemplateDefinition[] {
  return language?.toLowerCase().startsWith("fr")
    ? CALL_TEMPLATES.fr
    : CALL_TEMPLATES.en;
}

let seeding: Promise<void> | null = null;

// Adds the call templates once per install. A template the user already has
// under the same title is left alone, so a synced device or a manual copy
// never ends up with duplicates.
export function ensureCallTemplates(): Promise<void> {
  seeding ??= seedCallTemplates().catch((error) => {
    seeding = null;
    console.error("[templates] failed to add call templates", error);
  });
  return seeding;
}

async function seedCallTemplates() {
  const { values } = await getStoredSettingValues();
  if (values.call_templates_seeded) {
    return;
  }

  const existingTitles = new Set(
    (await listUserTemplates()).map((template) =>
      template.title.trim().toLowerCase(),
    ),
  );
  for (const definition of getCallTemplateDefinitions(values.ai_language)) {
    if (existingTitles.has(definition.title.toLowerCase())) {
      continue;
    }
    await insertUserTemplate({
      title: definition.title,
      description: definition.description,
      category: undefined,
      targets: undefined,
      sections: definition.sections,
    });
  }

  await setSettingValue("call_templates_seeded", true);
}
