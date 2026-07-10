import { DIMENSION_IDS } from "./rubric.js";
import type { HighStakesFlag, ModeName } from "./types.js";

export const THEORY_NAMES = [
  "Holland RIASEC",
  "Social Cognitive Career Theory",
  "Career Construction Theory",
  "Planned Happenstance",
  "Chaos Theory of Careers",
  "Protean Career",
  "Boundaryless Career",
  "Person Environment Fit",
  "Self Determination Theory",
  "Job Demands Resources",
  "Conservation of Resources",
  "Narrative Identity",
  "Possible Selves",
  "Expectancy Value Theory",
  "Goal Systems Theory",
  "Decision Theory",
  "Regret Minimization",
  "Option Value",
  "Downside Risk Management",
  "Identity Based Motivation",
  "Vocational Calling",
  "Life Design",
  "Work Values",
  "Role Conflict",
  "Ethical Risk Formulation",
  "Acceptance and Commitment Processes",
  "Psychology of Working",
  "Career Decision Difficulties"
] as const;

export type TheoryName = (typeof THEORY_NAMES)[number];

export type TheoryFamily =
  | "matching"
  | "developmental"
  | "learning"
  | "decision"
  | "wellbeing"
  | "identity"
  | "contextual"
  | "governance";

export interface TheoryCitation {
  authors: string;
  year: number;
  title: string;
  source: string;
  doi?: string;
}

export interface TheoryLens {
  theoryId: string;
  name: TheoryName;
  family: TheoryFamily;
  coreConstructs: string[];
  decisionQuestions: string[];
  modeBindings: ModeName[];
  rubricBindings: string[];
  reversibilityNote: string;
  highStakesRelevance: HighStakesFlag[];
  citations: TheoryCitation[];
}

export const THEORY_REGISTRY: TheoryLens[] = [
  {
    theoryId: "RIASEC",
    name: "Holland RIASEC",
    family: "matching",
    coreConstructs: ["vocational interests", "interest environment congruence", "consistency", "differentiation"],
    decisionQuestions: [
      "Which RIASEC interest pattern does this route actually reward day to day?",
      "Where is the congruence gap between the operator profile and the target environment?"
    ],
    modeBindings: ["/profile-audit", "/deep-fit"],
    rubricBindings: ["D01", "D04"],
    reversibilityNote: "Congruence estimates justify R0 exploration, not consequential submission on their own.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Holland, J. L.",
        year: 1997,
        title: "Making vocational choices: A theory of vocational personalities and work environments (3rd ed.)",
        source: "Psychological Assessment Resources"
      }
    ]
  },
  {
    theoryId: "SCCT",
    name: "Social Cognitive Career Theory",
    family: "learning",
    coreConstructs: ["self efficacy", "outcome expectations", "personal goals", "learning experiences", "contextual supports and barriers"],
    decisionQuestions: [
      "Is low self efficacy or a real skill gap driving hesitation on this route?",
      "Which learning experience would most directly raise verified capability here?"
    ],
    modeBindings: ["/profile-audit", "/deep-fit", "/phd-strategy", "/interview-brief"],
    rubricBindings: ["D05", "D13"],
    reversibilityNote: "Efficacy building actions should stay in the R0 to R2 range until evidence catches up with confidence.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Lent, R. W., Brown, S. D., & Hackett, G.",
        year: 1994,
        title: "Toward a unifying social cognitive theory of career and academic interest, choice, and performance",
        source: "Journal of Vocational Behavior, 45(1), 79-122",
        doi: "10.1006/jvbe.1994.1027"
      }
    ]
  },
  {
    theoryId: "CCT",
    name: "Career Construction Theory",
    family: "developmental",
    coreConstructs: ["career adaptability", "concern", "control", "curiosity", "confidence", "vocational self construction"],
    decisionQuestions: [
      "What career story does this move continue, and is that continuity supported by verified claims?",
      "Which adaptability resource, concern, control, curiosity, or confidence, is the binding constraint right now?"
    ],
    modeBindings: ["/cv-tailor", "/cover-letter", "/interview-brief", "/skill-coach"],
    rubricBindings: ["D02", "D13"],
    reversibilityNote: "Narrative framing is R0 drafting until every asserted fact in the story passes claim validation.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Savickas, M. L.",
        year: 2013,
        title: "Career construction theory and practice",
        source: "In S. D. Brown & R. W. Lent (Eds.), Career development and counseling: Putting theory and research to work (2nd ed., pp. 147-183). Wiley"
      },
      {
        authors: "Savickas, M. L., & Porfeli, E. J.",
        year: 2012,
        title: "Career Adapt-Abilities Scale: Construction, reliability, and measurement equivalence across 13 countries",
        source: "Journal of Vocational Behavior, 80(3), 661-673",
        doi: "10.1016/j.jvb.2012.01.011"
      }
    ]
  },
  {
    theoryId: "PHT",
    name: "Planned Happenstance",
    family: "learning",
    coreConstructs: ["curiosity", "persistence", "flexibility", "optimism", "risk taking"],
    decisionQuestions: [
      "Which low cost exploratory action would convert this unplanned event into a usable opportunity?",
      "Is the risk here calculated, meaning bounded and reversible, or merely hopeful?"
    ],
    modeBindings: ["/decision-intake", "/route-map", "/outreach", "/post-action-review", "/skill-coach"],
    rubricBindings: ["D08", "D18"],
    reversibilityNote: "Happenstance skills are exercised through R0 to R2 probes; the theory endorses exploration, not unguarded R3 or R4 commitment.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Mitchell, K. E., Levin, A. S., & Krumboltz, J. D.",
        year: 1999,
        title: "Planned happenstance: Constructing unexpected career opportunities",
        source: "Journal of Counseling and Development, 77(2), 115-124",
        doi: "10.1002/j.1556-6676.1999.tb02431.x"
      },
      {
        authors: "Krumboltz, J. D.",
        year: 2009,
        title: "The happenstance learning theory",
        source: "Journal of Career Assessment, 17(2), 135-154",
        doi: "10.1177/1069072708328861"
      }
    ]
  },
  {
    theoryId: "CTC",
    name: "Chaos Theory of Careers",
    family: "contextual",
    coreConstructs: ["nonlinearity", "attractors", "phase shifts", "emergence", "limits of prediction"],
    decisionQuestions: [
      "Which parts of this forecast are genuinely predictable and which are complexity theater?",
      "What small perturbation could disproportionately change this route, for better or worse?"
    ],
    modeBindings: ["/opportunity-ingest", "/route-map", "/evidence-gap", "/post-action-review"],
    rubricBindings: ["D18", "D19"],
    reversibilityNote: "Under nonlinearity, wide uncertainty bands and reversible moves are the honest default.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Pryor, R. G. L., & Bright, J. E. H.",
        year: 2011,
        title: "The chaos theory of careers: A new perspective on working in the twenty-first century",
        source: "Routledge"
      }
    ]
  },
  {
    theoryId: "PROTEAN",
    name: "Protean Career",
    family: "identity",
    coreConstructs: ["self directedness", "values driven orientation", "psychological success", "identity ownership"],
    decisionQuestions: [
      "Is this route steered by the operator values or by external metrics alone?",
      "What would psychological success look like here, independent of title and compensation?"
    ],
    modeBindings: ["/public-profile", "/route-map"],
    rubricBindings: ["D01", "D11"],
    reversibilityNote: "Values clarification is R0 work that should precede any consequential public identity signal.",
    highStakesRelevance: ["publicReputationSensitive"],
    citations: [
      {
        authors: "Hall, D. T.",
        year: 2004,
        title: "The protean career: A quarter-century journey",
        source: "Journal of Vocational Behavior, 65(1), 1-13",
        doi: "10.1016/j.jvb.2003.10.006"
      }
    ]
  },
  {
    theoryId: "BOUNDARYLESS",
    name: "Boundaryless Career",
    family: "contextual",
    coreConstructs: ["inter organizational mobility", "network embeddedness", "portable competence", "psychological mobility"],
    decisionQuestions: [
      "Which relationships and portable competencies does this route strengthen beyond the current organization?",
      "Does this move increase or decrease future mobility across boundaries?"
    ],
    modeBindings: ["/opportunity-ingest", "/outreach"],
    rubricBindings: ["D09", "D14"],
    reversibilityNote: "Network building outreach is R2 at most; portability claims still require evidence validation.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Arthur, M. B., & Rousseau, D. M. (Eds.)",
        year: 1996,
        title: "The boundaryless career: A new employment principle for a new organizational era",
        source: "Oxford University Press"
      }
    ]
  },
  {
    theoryId: "PEFIT",
    name: "Person Environment Fit",
    family: "matching",
    coreConstructs: ["person job fit", "person organization fit", "demands abilities fit", "needs supplies fit"],
    decisionQuestions: [
      "Which fit facet, job, organization, group, or supervisor, carries the most weight in this decision?",
      "Is the fit judgment based on verified information or on marketing language from the opportunity?"
    ],
    modeBindings: ["/profile-audit", "/deep-fit"],
    rubricBindings: ["D04", "D11", "D16"],
    reversibilityNote: "Fit hypotheses deserve R0 to R2 testing, for example conversations and trial tasks, before R3 commitment.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Kristof-Brown, A. L., Zimmerman, R. D., & Johnson, E. C.",
        year: 2005,
        title: "Consequences of individuals' fit at work: A meta-analysis of person-job, person-organization, person-group, and person-supervisor fit",
        source: "Personnel Psychology, 58(2), 281-342",
        doi: "10.1111/j.1744-6570.2005.00672.x"
      }
    ]
  },
  {
    theoryId: "SDT",
    name: "Self Determination Theory",
    family: "wellbeing",
    coreConstructs: ["autonomy", "competence", "relatedness", "intrinsic motivation", "internalization"],
    decisionQuestions: [
      "Which basic need, autonomy, competence, or relatedness, would this route feed or starve?",
      "Is the motivation here internalized or mostly introjected pressure?"
    ],
    modeBindings: ["/deep-fit", "/skill-coach"],
    rubricBindings: ["D11", "D16"],
    reversibilityNote: "Need satisfaction forecasts are soft signals; treat them as R0 inputs, not as authorization.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Ryan, R. M., & Deci, E. L.",
        year: 2000,
        title: "Self-determination theory and the facilitation of intrinsic motivation, social development, and well-being",
        source: "American Psychologist, 55(1), 68-78",
        doi: "10.1037/0003-066X.55.1.68"
      }
    ]
  },
  {
    theoryId: "JDR",
    name: "Job Demands Resources",
    family: "wellbeing",
    coreConstructs: ["job demands", "job resources", "strain pathway", "motivation pathway", "burnout risk"],
    decisionQuestions: [
      "What is the realistic demands to resources ratio of this route in the first year?",
      "Which specific resource, support, feedback, or control, offsets the heaviest demand?"
    ],
    modeBindings: ["/deep-fit", "/phd-strategy", "/steelman", "/risk-register"],
    rubricBindings: ["D10", "D16"],
    reversibilityNote: "Chronic strain forecasts should trigger the health boundary route review before any R3 action.",
    highStakesRelevance: ["clinicalOrMentalHealthSensitive"],
    citations: [
      {
        authors: "Bakker, A. B., & Demerouti, E.",
        year: 2007,
        title: "The Job Demands-Resources model: State of the art",
        source: "Journal of Managerial Psychology, 22(3), 309-328",
        doi: "10.1108/02683940710733115"
      }
    ]
  },
  {
    theoryId: "COR",
    name: "Conservation of Resources",
    family: "wellbeing",
    coreConstructs: ["resource loss aversion", "loss spirals", "gain spirals", "resource investment"],
    decisionQuestions: [
      "Which resources, time, money, energy, or standing, does this route put at risk of a loss spiral?",
      "What resource reserve must stay protected regardless of the outcome?"
    ],
    modeBindings: ["/negotiation", "/risk-register", "/founder-route"],
    rubricBindings: ["D06", "D16"],
    reversibilityNote: "Loss asymmetry justifies conservative reversibility tagging when reserves are thin.",
    highStakesRelevance: ["financialLiabilitySensitive"],
    citations: [
      {
        authors: "Hobfoll, S. E.",
        year: 1989,
        title: "Conservation of resources: A new attempt at conceptualizing stress",
        source: "American Psychologist, 44(3), 513-524",
        doi: "10.1037/0003-066X.44.3.513"
      }
    ]
  },
  {
    theoryId: "NARRID",
    name: "Narrative Identity",
    family: "identity",
    coreConstructs: ["life story coherence", "redemption sequences", "agency themes", "meaning making"],
    decisionQuestions: [
      "Does the written narrative claim more agency or coherence than the evidence supports?",
      "Which verified episode best carries the theme this document needs?"
    ],
    modeBindings: ["/cv-tailor", "/cover-letter", "/public-profile", "/post-action-review"],
    rubricBindings: ["D02", "D15"],
    reversibilityNote: "Story drafts are R0; publishing an identity narrative is a reputation relevant action and gates accordingly.",
    highStakesRelevance: ["publicReputationSensitive"],
    citations: [
      {
        authors: "McAdams, D. P., & McLean, K. C.",
        year: 2013,
        title: "Narrative identity",
        source: "Current Directions in Psychological Science, 22(3), 233-238",
        doi: "10.1177/0963721413475622"
      }
    ]
  },
  {
    theoryId: "POSSELVES",
    name: "Possible Selves",
    family: "identity",
    coreConstructs: ["hoped for selves", "feared selves", "self regulatory function of future selves"],
    decisionQuestions: [
      "Which hoped for self does this route serve, and which feared self does it guard against?",
      "Is the feared self realistic enough to justify the caution it is producing?"
    ],
    modeBindings: ["/route-map", "/skill-coach"],
    rubricBindings: ["D02", "D13"],
    reversibilityNote: "Future self imagery guides planning at R0 and never substitutes for evidence at the gates.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Markus, H., & Nurius, P.",
        year: 1986,
        title: "Possible selves",
        source: "American Psychologist, 41(9), 954-969",
        doi: "10.1037/0003-066X.41.9.954"
      }
    ]
  },
  {
    theoryId: "EVT",
    name: "Expectancy Value Theory",
    family: "decision",
    coreConstructs: ["expectancy of success", "attainment value", "intrinsic value", "utility value", "cost"],
    decisionQuestions: [
      "What is the honest probability of success here, and what evidence anchors that number?",
      "Which value component, attainment, intrinsic, or utility, dominates, and what is the full cost term?"
    ],
    modeBindings: ["/deep-fit", "/fellowship-watch"],
    rubricBindings: ["D01", "D06"],
    reversibilityNote: "Expectancy estimates inherit the evidence status of their inputs and cap confidence accordingly.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Eccles, J. S., & Wigfield, A.",
        year: 2002,
        title: "Motivational beliefs, values, and goals",
        source: "Annual Review of Psychology, 53, 109-132",
        doi: "10.1146/annurev.psych.53.100901.135153"
      }
    ]
  },
  {
    theoryId: "GOALSYS",
    name: "Goal Systems Theory",
    family: "decision",
    coreConstructs: ["means end structure", "multifinality", "equifinality", "goal shielding"],
    decisionQuestions: [
      "How many distinct goals does this single route serve, and is that multifinality real or wishful?",
      "If this means fails, which equifinal alternatives already exist?"
    ],
    modeBindings: ["/decision-intake", "/route-map"],
    rubricBindings: ["D01", "D18"],
    reversibilityNote: "Routes with rich equifinal alternatives can afford bolder probes; single path dependence argues for caution.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Kruglanski, A. W., Shah, J. Y., Fishbach, A., Friedman, R., Chun, W. Y., & Sleeth-Keppler, D.",
        year: 2002,
        title: "A theory of goal systems",
        source: "Advances in Experimental Social Psychology, 34, 331-378",
        doi: "10.1016/S0065-2601(02)80008-9"
      }
    ]
  },
  {
    theoryId: "DECISION",
    name: "Decision Theory",
    family: "decision",
    coreConstructs: ["reference dependence", "loss aversion", "probability weighting", "framing effects"],
    decisionQuestions: [
      "Is the current frame, gain or loss, distorting how this option is being weighed?",
      "Which probabilities in this analysis are being over weighted because they are vivid rather than likely?"
    ],
    modeBindings: ["/decision-intake", "/negotiation", "/evidence-gap", "/application-packet"],
    rubricBindings: ["D17", "D19"],
    reversibilityNote: "Bias diagnostics run at R0 and inform, never replace, the runtime gates.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Kahneman, D., & Tversky, A.",
        year: 1979,
        title: "Prospect theory: An analysis of decision under risk",
        source: "Econometrica, 47(2), 263-291",
        doi: "10.2307/1914185"
      }
    ]
  },
  {
    theoryId: "REGRET",
    name: "Regret Minimization",
    family: "decision",
    coreConstructs: ["anticipated regret", "action versus inaction regret", "post decision evaluation"],
    decisionQuestions: [
      "Looking back from a plausible future, which choice would the operator regret more, acting or waiting?",
      "Is anticipated regret here informative signal or anxiety in costume?"
    ],
    modeBindings: ["/negotiation", "/steelman", "/post-action-review"],
    rubricBindings: ["D18", "D19"],
    reversibilityNote: "Regret framing is a lens for review conversations, not a license to bypass evidence gates.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Bell, D. E.",
        year: 1982,
        title: "Regret in decision making under uncertainty",
        source: "Operations Research, 30(5), 961-981",
        doi: "10.1287/opre.30.5.961"
      }
    ]
  },
  {
    theoryId: "OPTVAL",
    name: "Option Value",
    family: "decision",
    coreConstructs: ["irreversibility premium", "value of waiting", "uncertainty resolution", "staged commitment"],
    decisionQuestions: [
      "What information would arrive by simply waiting, and is it worth the delay cost?",
      "Can this commitment be staged so that each stage stays individually reversible?"
    ],
    modeBindings: ["/route-map", "/fellowship-watch", "/steelman", "/founder-route", "/auto-apply-config"],
    rubricBindings: ["D08", "D18"],
    reversibilityNote: "This lens is the economic rationale for the R0 to R4 gate: irreversible action under uncertainty destroys option value.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Dixit, A. K., & Pindyck, R. S.",
        year: 1994,
        title: "Investment under uncertainty",
        source: "Princeton University Press"
      }
    ]
  },
  {
    theoryId: "DOWNSIDE",
    name: "Downside Risk Management",
    family: "decision",
    coreConstructs: ["safety first principle", "ruin avoidance", "disaster threshold", "asymmetric outcomes"],
    decisionQuestions: [
      "What is the ruin scenario for this route, and is its probability actually bounded?",
      "Which safeguard keeps the worst case survivable rather than merely unlikely?"
    ],
    modeBindings: ["/founder-route", "/risk-register", "/steelman", "/auto-apply-config"],
    rubricBindings: ["D06", "D17"],
    reversibilityNote: "When a route carries ruin risk, the safety first principle dominates expected value arguments.",
    highStakesRelevance: ["financialLiabilitySensitive"],
    citations: [
      {
        authors: "Roy, A. D.",
        year: 1952,
        title: "Safety first and the holding of assets",
        source: "Econometrica, 20(3), 431-449"
      }
    ]
  },
  {
    theoryId: "IBM",
    name: "Identity Based Motivation",
    family: "identity",
    coreConstructs: ["dynamic construction of identity", "action readiness", "interpretation of difficulty"],
    decisionQuestions: [
      "Is difficulty on this route being read as importance or as impossibility, and which reading fits the evidence?",
      "Does the target environment make the desired identity feel congruent or alien?"
    ],
    modeBindings: ["/cover-letter", "/public-profile", "/steelman"],
    rubricBindings: ["D02", "D13"],
    reversibilityNote: "Identity congruence checks refine the identity congruent steelman route at R0.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Oyserman, D., & Destin, M.",
        year: 2010,
        title: "Identity-based motivation: Implications for intervention",
        source: "The Counseling Psychologist, 38(7), 1001-1043",
        doi: "10.1177/0011000010374775"
      }
    ]
  },
  {
    theoryId: "CALLING",
    name: "Vocational Calling",
    family: "identity",
    coreConstructs: ["transcendent summons", "purposeful work", "prosocial orientation", "overwork risk"],
    decisionQuestions: [
      "Is the sense of calling here supported by lived engagement or by idealization of the role?",
      "What boundary protects the operator if the calling becomes a justification for exploitation or overwork?"
    ],
    modeBindings: ["/phd-strategy", "/deep-fit"],
    rubricBindings: ["D01", "D16"],
    reversibilityNote: "Calling intensifies commitment; the system responds by holding the energy sustainability dimension in view.",
    highStakesRelevance: ["clinicalOrMentalHealthSensitive"],
    citations: [
      {
        authors: "Dik, B. J., & Duffy, R. D.",
        year: 2009,
        title: "Calling and vocation at work: Definitions and prospects for research and practice",
        source: "The Counseling Psychologist, 37(3), 424-450",
        doi: "10.1177/0011000008316430"
      }
    ]
  },
  {
    theoryId: "LIFEDESIGN",
    name: "Life Design",
    family: "developmental",
    coreConstructs: ["identity work", "adaptability", "narratability", "intentional life construction"],
    decisionQuestions: [
      "How does this route fit the whole life design, not only the occupational lane?",
      "Which small identity experiment would test this design before large commitment?"
    ],
    modeBindings: ["/phd-strategy", "/route-map", "/skill-coach"],
    rubricBindings: ["D02", "D14"],
    reversibilityNote: "Life design favors prototyping: small reversible experiments before consequential redesign.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Savickas, M. L., Nota, L., Rossier, J., Dauwalder, J.-P., Duarte, M. E., Guichard, J., Soresi, S., Van Esbroeck, R., & van Vianen, A. E. M.",
        year: 2009,
        title: "Life designing: A paradigm for career construction in the 21st century",
        source: "Journal of Vocational Behavior, 75(3), 239-250",
        doi: "10.1016/j.jvb.2009.04.004"
      }
    ]
  },
  {
    theoryId: "TWA",
    name: "Work Values",
    family: "matching",
    coreConstructs: ["needs and values", "reinforcer patterns", "satisfaction", "satisfactoriness", "correspondence"],
    decisionQuestions: [
      "Which reinforcers, achievement, comfort, status, altruism, safety, or autonomy, does this environment reliably supply?",
      "Where would correspondence break first, operator satisfaction or environment satisfactoriness?"
    ],
    modeBindings: ["/profile-audit", "/deep-fit", "/negotiation"],
    rubricBindings: ["D01", "D06", "D11"],
    reversibilityNote: "Value correspondence estimates inform negotiation targets and remain advisory inputs.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Dawis, R. V., & Lofquist, L. H.",
        year: 1984,
        title: "A psychological theory of work adjustment: An individual-differences model and its applications",
        source: "University of Minnesota Press"
      }
    ]
  },
  {
    theoryId: "ROLECONF",
    name: "Role Conflict",
    family: "contextual",
    coreConstructs: ["time based conflict", "strain based conflict", "behavior based conflict", "inter role pressure"],
    decisionQuestions: [
      "Which concrete time, strain, or behavior conflict would this route create between work and family roles?",
      "Whose schedule, caregiving load, or relocation cost absorbs the pressure this route generates?"
    ],
    modeBindings: ["/risk-register", "/deep-fit"],
    rubricBindings: ["D07", "D16"],
    reversibilityNote: "Family system impact is a named high stakes flag; conflict forecasts route into the certainty gate.",
    highStakesRelevance: ["familyRelocationSensitive"],
    citations: [
      {
        authors: "Greenhaus, J. H., & Beutell, N. J.",
        year: 1985,
        title: "Sources of conflict between work and family roles",
        source: "Academy of Management Review, 10(1), 76-88",
        doi: "10.5465/amr.1985.4277352"
      }
    ]
  },
  {
    theoryId: "ETHRISK",
    name: "Ethical Risk Formulation",
    family: "governance",
    coreConstructs: ["integrity of public claims", "conflict of interest exposure", "reputational externalities", "accountable automation"],
    decisionQuestions: [
      "Could this action misrepresent evidence, violate an agreement, or shift risk onto someone who did not consent?",
      "Which accountable human must review this route before it leaves the draft stage?"
    ],
    modeBindings: ["/risk-register", "/application-packet", "/auto-apply-config", "/public-profile"],
    rubricBindings: ["D17"],
    reversibilityNote: "This is an engineering formulation aligned to risk management practice, not a vocational psychology theory, and it powers the non negotiable gates.",
    highStakesRelevance: ["researchIntegritySensitive", "conflictOfInterestSensitive", "publicReputationSensitive"],
    citations: [
      {
        authors: "National Institute of Standards and Technology",
        year: 2023,
        title: "Artificial Intelligence Risk Management Framework (AI RMF 1.0)",
        source: "NIST AI 100-1",
        doi: "10.6028/NIST.AI.100-1"
      }
    ]
  },
  {
    theoryId: "ACT",
    name: "Acceptance and Commitment Processes",
    family: "wellbeing",
    coreConstructs: ["acceptance", "cognitive defusion", "present moment contact", "self as context", "values", "committed action"],
    decisionQuestions: [
      "Is avoidance of uncertainty, rather than the evidence, steering this decision?",
      "What is the smallest committed action that moves toward stated values this week?"
    ],
    modeBindings: ["/skill-coach", "/decision-intake", "/post-action-review"],
    rubricBindings: ["D16", "D20"],
    reversibilityNote: "Psychological flexibility work is R0 self coaching; clinical level distress routes to a human professional, never to automation.",
    highStakesRelevance: ["clinicalOrMentalHealthSensitive"],
    citations: [
      {
        authors: "Hayes, S. C., Luoma, J. B., Bond, F. W., Masuda, A., & Lillis, J.",
        year: 2006,
        title: "Acceptance and commitment therapy: Model, processes and outcomes",
        source: "Behaviour Research and Therapy, 44(1), 1-25",
        doi: "10.1016/j.brat.2005.06.006"
      }
    ]
  },
  {
    theoryId: "PWT",
    name: "Psychology of Working",
    family: "contextual",
    coreConstructs: ["decent work", "economic constraints", "marginalization", "work volition", "survival and self determination needs"],
    decisionQuestions: [
      "Does this opportunity meet decent work markers, safety, fair compensation, adequate rest, and value alignment?",
      "Which structural constraint, not personal deficit, is limiting the option set here?"
    ],
    modeBindings: ["/opportunity-ingest", "/deep-fit", "/fellowship-watch"],
    rubricBindings: ["D06", "D07", "D17"],
    reversibilityNote: "Constraint aware analysis keeps the system honest about options the operator cannot simply choose away.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Duffy, R. D., Blustein, D. L., Diemer, M. A., & Autin, K. L.",
        year: 2016,
        title: "The psychology of working theory",
        source: "Journal of Counseling Psychology, 63(2), 127-148",
        doi: "10.1037/cou0000140"
      }
    ]
  },
  {
    theoryId: "CDDQ",
    name: "Career Decision Difficulties",
    family: "decision",
    coreConstructs: ["lack of readiness", "lack of information", "inconsistent information", "internal and external conflicts"],
    decisionQuestions: [
      "Is the block here readiness, missing information, or conflicting information, since each demands a different next mode?",
      "If information conflicts, is the conflict inside the operator, between sources, or with significant others?"
    ],
    modeBindings: ["/decision-intake"],
    rubricBindings: ["D10", "D19"],
    reversibilityNote: "Difficulty classification is the R0 front door of the system and routes work to the right mode before any action.",
    highStakesRelevance: [],
    citations: [
      {
        authors: "Gati, I., Krausz, M., & Osipow, S. H.",
        year: 1996,
        title: "A taxonomy of difficulties in career decision making",
        source: "Journal of Counseling Psychology, 43(4), 510-526",
        doi: "10.1037/0022-0167.43.4.510"
      }
    ]
  }
];

export function getTheoryLens(theoryId: string): TheoryLens | undefined {
  return THEORY_REGISTRY.find((lens) => lens.theoryId === theoryId);
}

export function getTheoryLensByName(name: TheoryName): TheoryLens | undefined {
  return THEORY_REGISTRY.find((lens) => lens.name === name);
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
}

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

export function validateTheoryRegistry(): RegistryValidationResult {
  const errors: string[] = [];
  const dimensionIds = new Set<string>(DIMENSION_IDS);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  if (THEORY_REGISTRY.length !== THEORY_NAMES.length) {
    errors.push(`registry-size-mismatch: registry ${THEORY_REGISTRY.length} names ${THEORY_NAMES.length}`);
  }

  for (const lens of THEORY_REGISTRY) {
    if (seenIds.has(lens.theoryId)) {
      errors.push(`duplicate-theory-id:${lens.theoryId}`);
    }
    seenIds.add(lens.theoryId);

    if (seenNames.has(lens.name)) {
      errors.push(`duplicate-theory-name:${lens.name}`);
    }
    seenNames.add(lens.name);

    if (lens.coreConstructs.length === 0) {
      errors.push(`missing-constructs:${lens.theoryId}`);
    }
    if (lens.decisionQuestions.length === 0) {
      errors.push(`missing-questions:${lens.theoryId}`);
    }
    if (lens.modeBindings.length === 0) {
      errors.push(`missing-mode-bindings:${lens.theoryId}`);
    }
    for (const dimension of lens.rubricBindings) {
      if (!dimensionIds.has(dimension)) {
        errors.push(`unknown-rubric-dimension:${lens.theoryId}:${dimension}`);
      }
    }
    if (lens.citations.length === 0) {
      errors.push(`missing-citations:${lens.theoryId}`);
    }
    for (const citation of lens.citations) {
      if (!citation.authors || !citation.title || !citation.source || !Number.isInteger(citation.year)) {
        errors.push(`incomplete-citation:${lens.theoryId}`);
      }
      if (citation.doi !== undefined && !DOI_PATTERN.test(citation.doi)) {
        errors.push(`malformed-doi:${lens.theoryId}:${citation.doi}`);
      }
    }
  }

  for (const name of THEORY_NAMES) {
    if (!seenNames.has(name)) {
      errors.push(`name-without-registry-entry:${name}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
