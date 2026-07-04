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
  "Ethical Risk Formulation"
] as const;

export type TheoryName = (typeof THEORY_NAMES)[number];
