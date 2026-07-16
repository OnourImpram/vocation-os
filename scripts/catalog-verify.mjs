import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  SOURCE_PACK_IDS,
  canonicalizeHttpsUrl,
  inferProvider,
  registrableDomain
} from "./catalog-check.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_VERSION = "1.0.0";
const REMOTEINTECH_REPOSITORY = "https://github.com/remoteintech/remote-jobs";
const REMOTEINTECH_REVISION = "acffb49fd1ab2c05f249f7ca5b80709ffb6d0fc9";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_CONCURRENCY = 16;
const REMOTE_ENTRIES_PER_PACK = 170;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SOURCE_PACK_NAMES = Object.freeze({
  ai: "Artificial intelligence",
  clinical: "Clinical care",
  academic: "Academic institutions",
  education: "Education",
  health: "Health and life sciences",
  product: "Product organizations",
  startup: "Startups",
  fellowship: "Fellowship and research funders",
  public: "Public institutions",
  "international-institution": "International institutions"
});
const AGGREGATOR_DOMAINS = new Set([
  "angel.co",
  "builtin.com",
  "glassdoor.com",
  "indeed.com",
  "linkedin.com",
  "remote.co",
  "remoteok.com",
  "weworkremotely.com",
  "wellfound.com"
]);
const IDENTITY_STOP_WORDS = new Set([
  "academy",
  "association",
  "care",
  "center",
  "centre",
  "clinical",
  "college",
  "company",
  "corporation",
  "digital",
  "foundation",
  "global",
  "government",
  "group",
  "health",
  "healthcare",
  "hospital",
  "institute",
  "international",
  "laboratories",
  "laboratory",
  "labs",
  "medical",
  "national",
  "network",
  "organisation",
  "organization",
  "public",
  "research",
  "science",
  "sciences",
  "service",
  "services",
  "solutions",
  "systems",
  "technology",
  "technologies",
  "trust",
  "university"
]);
const CAREER_TERMS = Object.freeze([
  "career",
  "careers",
  "employment",
  "emploi",
  "hiring",
  "is ilan",
  "job",
  "jobs",
  "join our team",
  "join us",
  "kariera",
  "kariyer",
  "karriere",
  "opportunities",
  "opportunity",
  "open roles",
  "recruitment",
  "stellen",
  "trabaja con nosotros",
  "vacancies",
  "vacancy",
  "vacatures",
  "valtiolle",
  "werken",
  "work at",
  "work for us",
  "work with us",
  "working at"
]);

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 128);
}

function normalizeText(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&(?:amp|#38);/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeRequestUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${value}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`URL must not contain credentials: ${value}`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") {
    url.port = "";
  }
  return url.toString();
}

function identityTokens(name) {
  const normalized = normalizeText(name);
  const tokens = normalized
    .split(" ")
    .filter((token) => token.length >= 4 && !IDENTITY_STOP_WORDS.has(token))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return { normalized, tokens: [...new Set(tokens)] };
}

function manual(sourcePackId, sectors, organizationName, officialCareersUrl, officialWebsiteUrl, countriesOrRegions) {
  return {
    organizationId: slugify(organizationName),
    organizationName,
    sectors,
    countriesOrRegions,
    sourcePackId,
    seedCareersUrl: canonicalizeHttpsUrl(officialCareersUrl),
    providerHint: inferProvider(officialCareersUrl),
    remoteSignal: "not-stated",
    discovery: {
      sourceId: "official-organization-site",
      sourceUrl: canonicalizeHttpsUrl(officialCareersUrl),
      officialWebsiteUrl: canonicalizeHttpsUrl(officialWebsiteUrl),
      sourceLicense: null,
      sourceRevision: null,
      retrievedAt: null
    }
  };
}

const MANUAL_CANDIDATES = Object.freeze([
  manual("ai", ["artificial-intelligence", "research", "technology"], "OpenAI", "https://openai.com/careers/", "https://openai.com/", ["US"]),
  manual("ai", ["artificial-intelligence", "research", "technology"], "Anthropic", "https://www.anthropic.com/careers", "https://www.anthropic.com/", ["US", "GB"]),
  manual("ai", ["artificial-intelligence", "research", "technology"], "Google DeepMind", "https://deepmind.google/careers/", "https://deepmind.google/", ["GB", "US", "FR", "CA"]),
  manual("ai", ["artificial-intelligence", "technology"], "Mistral AI", "https://mistral.ai/careers", "https://mistral.ai/", ["FR", "GB", "US"]),
  manual("ai", ["artificial-intelligence", "technology"], "Cohere", "https://cohere.com/careers", "https://cohere.com/", ["CA", "US", "GB"]),
  manual("ai", ["artificial-intelligence", "software", "technology"], "Hugging Face", "https://huggingface.co/jobs", "https://huggingface.co/", ["worldwide"]),
  manual("ai", ["artificial-intelligence", "technology"], "Scale AI", "https://scale.com/careers", "https://scale.com/", ["US", "GB"]),
  manual("ai", ["artificial-intelligence", "research", "technology"], "xAI", "https://x.ai/careers", "https://x.ai/", ["US", "GB"]),
  manual("ai", ["artificial-intelligence", "technology"], "AI21 Labs", "https://www.ai21.com/careers", "https://www.ai21.com/", ["IL", "US"]),
  manual("ai", ["artificial-intelligence", "research", "technology"], "Aleph Alpha", "https://aleph-alpha.com/careers/", "https://aleph-alpha.com/", ["DE"]),
  manual("ai", ["artificial-intelligence", "technology"], "Stability AI", "https://stability.ai/careers", "https://stability.ai/", ["GB", "US"]),
  manual("ai", ["artificial-intelligence", "software", "technology"], "Databricks", "https://www.databricks.com/company/careers", "https://www.databricks.com/", ["worldwide"]),
  manual("ai", ["artificial-intelligence", "technology"], "NVIDIA", "https://www.nvidia.com/en-us/about-nvidia/careers/", "https://www.nvidia.com/", ["worldwide"]),
  manual("ai", ["artificial-intelligence", "product", "technology"], "Perplexity", "https://www.perplexity.ai/hub/careers", "https://www.perplexity.ai/", ["US"]),
  manual("ai", ["artificial-intelligence", "product", "technology"], "ElevenLabs", "https://elevenlabs.io/careers", "https://elevenlabs.io/", ["worldwide"]),
  manual("ai", ["artificial-intelligence", "product", "technology"], "Runway", "https://runwayml.com/careers", "https://runwayml.com/", ["US"]),
  manual("ai", ["artificial-intelligence", "product", "technology"], "DeepL", "https://www.deepl.com/en/jobs", "https://www.deepl.com/", ["DE", "GB", "NL", "PL", "JP", "US"]),
  manual("ai", ["artificial-intelligence", "technology"], "SambaNova Systems", "https://sambanova.ai/careers", "https://sambanova.ai/", ["US", "GB", "IN"]),

  manual("clinical", ["clinical-care", "healthcare"], "Mayo Clinic", "https://jobs.mayoclinic.org/", "https://www.mayoclinic.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare"], "Cleveland Clinic", "https://jobs.clevelandclinic.org/", "https://my.clevelandclinic.org/", ["US", "GB"]),
  manual("clinical", ["clinical-care", "healthcare"], "Johns Hopkins Medicine", "https://jobs.hopkinsmedicine.org/", "https://www.hopkinsmedicine.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare"], "Mass General Brigham", "https://www.massgeneralbrigham.org/en/about/careers", "https://www.massgeneralbrigham.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare"], "King's College Hospital NHS Foundation Trust", "https://www.kch.nhs.uk/careers/", "https://www.kch.nhs.uk/", ["GB"]),
  manual("clinical", ["clinical-care", "healthcare", "research"], "Tavistock and Portman NHS Foundation Trust", "https://tavistockandportman.nhs.uk/about-us/work-for-us/", "https://tavistockandportman.nhs.uk/", ["GB"]),
  manual("clinical", ["clinical-care", "healthcare"], "South London and Maudsley NHS Foundation Trust", "https://www.slam.nhs.uk/work-for-us/", "https://www.slam.nhs.uk/", ["GB"]),
  manual("clinical", ["clinical-care", "healthcare"], "NYU Langone Health", "https://jobs.nyulangone.org/", "https://nyulangone.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare"], "Mount Sinai Health System", "https://careers.mountsinai.org/", "https://www.mountsinai.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare", "research"], "Boston Children's Hospital", "https://jobs.childrenshospital.org/", "https://www.childrenshospital.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare", "research"], "Centre for Addiction and Mental Health", "https://www.camh.ca/en/driving-change/about-camh/careers-at-camh", "https://www.camh.ca/", ["CA"]),
  manual("clinical", ["clinical-care", "healthcare"], "Priory", "https://jobs.priorygroup.com/", "https://www.priorygroup.com/", ["GB"]),
  manual("clinical", ["clinical-care", "healthcare"], "Kaiser Permanente", "https://www.kaiserpermanentejobs.org/", "https://www.kaiserpermanente.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare", "research"], "Memorial Sloan Kettering Cancer Center", "https://careers.mskcc.org/", "https://www.mskcc.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare", "research"], "MD Anderson Cancer Center", "https://jobs.mdanderson.org/", "https://www.mdanderson.org/", ["US"]),
  manual("clinical", ["clinical-care", "healthcare", "research"], "University Health Network", "https://www.uhn.ca/corporate/ways-help/careers", "https://www.uhn.ca/", ["CA"]),

  manual("academic", ["academia", "education", "research"], "Harvard University", "https://hr.harvard.edu/jobs", "https://www.harvard.edu/", ["US"]),
  manual("academic", ["academia", "education", "research"], "Stanford University", "https://careersearch.stanford.edu/", "https://www.stanford.edu/", ["US"]),
  manual("academic", ["academia", "education", "research"], "Massachusetts Institute of Technology", "https://hr.mit.edu/careers", "https://www.mit.edu/", ["US"]),
  manual("academic", ["academia", "education", "research"], "University of Oxford", "https://www.jobs.ox.ac.uk/", "https://www.ox.ac.uk/", ["GB"]),
  manual("academic", ["academia", "education", "research"], "University of Cambridge", "https://www.jobs.cam.ac.uk/", "https://www.cam.ac.uk/", ["GB"]),
  manual("academic", ["academia", "education", "research"], "University College London", "https://www.ucl.ac.uk/work-at-ucl/", "https://www.ucl.ac.uk/", ["GB"]),
  manual("academic", ["academia", "education", "research"], "Imperial College London", "https://www.imperial.ac.uk/jobs/", "https://www.imperial.ac.uk/", ["GB"]),
  manual("academic", ["academia", "education", "research"], "King's College London", "https://www.kcl.ac.uk/jobs", "https://www.kcl.ac.uk/", ["GB"]),
  manual("academic", ["academia", "education", "research"], "University of Edinburgh", "https://www.ed.ac.uk/jobs", "https://www.ed.ac.uk/", ["GB"]),
  manual("academic", ["academia", "education", "research"], "Trinity College Dublin", "https://www.tcd.ie/hr/vacancies/", "https://www.tcd.ie/", ["IE"]),
  manual("academic", ["academia", "education", "research"], "University College Dublin", "https://www.ucd.ie/workatucd/jobs/", "https://www.ucd.ie/", ["IE"]),
  manual("academic", ["academia", "education", "research"], "University of Amsterdam", "https://werkenbij.uva.nl/en", "https://www.uva.nl/en", ["NL"]),
  manual("academic", ["academia", "education", "research"], "KU Leuven", "https://www.kuleuven.be/personeel/jobsite/en/", "https://www.kuleuven.be/english/", ["BE"]),
  manual("academic", ["academia", "education", "research"], "ETH Zurich", "https://jobs.ethz.ch/", "https://ethz.ch/en.html", ["CH"]),
  manual("academic", ["academia", "education", "research"], "University of Zurich", "https://jobs.uzh.ch/", "https://www.uzh.ch/en.html", ["CH"]),
  manual("academic", ["academia", "education", "research"], "Yale University", "https://your.yale.edu/work-yale/careers", "https://www.yale.edu/", ["US"]),
  manual("academic", ["academia", "education", "research"], "Princeton University", "https://hr.princeton.edu/careers", "https://www.princeton.edu/", ["US"]),
  manual("academic", ["academia", "education", "research"], "University of California Berkeley", "https://jobs.berkeley.edu/", "https://www.berkeley.edu/", ["US"]),

  manual("education", ["education", "product", "technology"], "Coursera", "https://www.coursera.org/about/careers", "https://www.coursera.org/", ["worldwide"]),
  manual("education", ["education", "philanthropy", "technology"], "Khan Academy", "https://www.khanacademy.org/careers", "https://www.khanacademy.org/", ["worldwide"]),
  manual("education", ["education", "product", "technology"], "Duolingo", "https://careers.duolingo.com/", "https://www.duolingo.com/", ["US", "GB", "CN"]),
  manual("education", ["education", "product", "technology"], "edX", "https://www.edx.org/careers", "https://www.edx.org/", ["US"]),
  manual("education", ["education", "product", "technology"], "Pearson", "https://pearson.jobs/", "https://www.pearson.com/", ["worldwide"]),
  manual("education", ["education", "product"], "McGraw Hill", "https://careers.mheducation.com/", "https://www.mheducation.com/", ["worldwide"]),
  manual("education", ["education", "product"], "Scholastic", "https://www.scholastic.com/site/careers.html", "https://www.scholastic.com/", ["US", "GB", "CA"]),
  manual("education", ["education", "product", "technology"], "2U", "https://2u.com/careers/", "https://2u.com/", ["US", "ZA"]),
  manual("education", ["education", "product", "technology"], "Chegg", "https://www.chegg.com/about/working-at-chegg/", "https://www.chegg.com/", ["US", "IN"]),
  manual("education", ["education", "product", "technology"], "Udemy", "https://about.udemy.com/careers/", "https://www.udemy.com/", ["worldwide"]),
  manual("education", ["education", "product", "technology"], "Instructure", "https://www.instructure.com/about/careers", "https://www.instructure.com/", ["worldwide"]),
  manual("education", ["education", "product", "technology"], "Guild", "https://www.guild.com/careers", "https://www.guild.com/", ["US"]),
  manual("education", ["education", "product"], "Curriculum Associates", "https://www.curriculumassociates.com/careers", "https://www.curriculumassociates.com/", ["US"]),
  manual("education", ["education", "philanthropy"], "Teach For All", "https://teachforall.org/careers", "https://teachforall.org/", ["worldwide"]),
  manual("education", ["education", "research"], "Education Development Center", "https://www.edc.org/careers", "https://www.edc.org/", ["worldwide"]),
  manual("education", ["education", "product", "technology"], "Anthology", "https://careers.anthology.com/", "https://www.anthology.com/", ["worldwide"]),
  manual("education", ["education", "product", "technology"], "Turnitin", "https://www.turnitin.com/about/careers", "https://www.turnitin.com/", ["worldwide"]),
  manual("education", ["education", "product", "technology"], "Kahoot", "https://kahoot.com/jobs/", "https://kahoot.com/", ["NO", "GB", "US"]),

  manual("health", ["healthcare", "international-development", "public-service"], "World Health Organization", "https://www.who.int/careers", "https://www.who.int/", ["worldwide"]),
  manual("health", ["healthcare", "public-service", "research"], "Centers for Disease Control and Prevention", "https://jobs.cdc.gov/", "https://www.cdc.gov/", ["US"]),
  manual("health", ["healthcare", "public-service"], "NHS England", "https://www.england.nhs.uk/about/working-for/", "https://www.england.nhs.uk/", ["GB"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Pfizer", "https://www.pfizer.com/about/careers", "https://www.pfizer.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Roche", "https://careers.roche.com/global/en", "https://www.roche.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Novartis", "https://www.novartis.com/careers", "https://www.novartis.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "AstraZeneca", "https://careers.astrazeneca.com/", "https://www.astrazeneca.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Johnson and Johnson", "https://www.careers.jnj.com/", "https://www.jnj.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "GSK", "https://jobs.gsk.com/", "https://www.gsk.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Sanofi", "https://jobs.sanofi.com/", "https://www.sanofi.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Moderna", "https://www.modernatx.com/en-US/careers", "https://www.modernatx.com/", ["US", "GB", "CA"]),
  manual("health", ["clinical-care", "healthcare"], "Bupa", "https://careers.bupa.co.uk/", "https://www.bupa.com/", ["worldwide"]),
  manual("health", ["healthcare", "technology"], "Philips", "https://www.careers.philips.com/", "https://www.philips.com/", ["worldwide"]),
  manual("health", ["healthcare", "technology"], "Medtronic", "https://www.medtronic.com/en-us/our-company/careers.html", "https://www.medtronic.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Merck", "https://jobs.merck.com/", "https://www.merck.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Eli Lilly and Company", "https://careers.lilly.com/", "https://www.lilly.com/", ["worldwide"]),
  manual("health", ["biotechnology", "healthcare", "research"], "Novo Nordisk", "https://www.novonordisk.com/careers.html", "https://www.novonordisk.com/", ["worldwide"]),
  manual("health", ["healthcare", "international-development", "research"], "PATH", "https://www.path.org/careers/", "https://www.path.org/", ["worldwide"]),

  manual("fellowship", ["philanthropy", "research"], "Wellcome", "https://wellcome.org/jobs", "https://wellcome.org/", ["GB", "DE"]),
  manual("fellowship", ["education", "philanthropy", "research"], "American Association for the Advancement of Science", "https://www.aaas.org/careers", "https://www.aaas.org/", ["US"]),
  manual("fellowship", ["academia", "philanthropy", "research"], "National Academies of Sciences Engineering and Medicine", "https://www.nationalacademies.org/about/careers", "https://www.nationalacademies.org/", ["US"]),
  manual("fellowship", ["education", "international-development", "philanthropy"], "Institute of International Education", "https://www.iie.org/careers/", "https://www.iie.org/", ["worldwide"]),
  manual("fellowship", ["education", "philanthropy"], "Rhodes Trust", "https://www.rhodeshouse.ox.ac.uk/about-us/jobs/", "https://www.rhodeshouse.ox.ac.uk/", ["GB"]),
  manual("fellowship", ["education", "philanthropy"], "Aspen Institute", "https://www.aspeninstitute.org/about/careers/", "https://www.aspeninstitute.org/", ["US", "worldwide"]),
  manual("fellowship", ["international-development", "philanthropy"], "Open Society Foundations", "https://www.opensocietyfoundations.org/employment", "https://www.opensocietyfoundations.org/", ["worldwide"]),
  manual("fellowship", ["philanthropy"], "Ford Foundation", "https://www.fordfoundation.org/about/people/careers/", "https://www.fordfoundation.org/", ["worldwide"]),
  manual("fellowship", ["philanthropy", "research"], "MacArthur Foundation", "https://www.macfound.org/about/work-at-macarthur", "https://www.macfound.org/", ["US"]),
  manual("fellowship", ["healthcare", "philanthropy", "research"], "Gates Foundation", "https://www.gatesfoundation.org/about/careers", "https://www.gatesfoundation.org/", ["worldwide"]),
  manual("fellowship", ["international-development", "philanthropy"], "Rockefeller Foundation", "https://www.rockefellerfoundation.org/about-us/careers/", "https://www.rockefellerfoundation.org/", ["worldwide"]),
  manual("fellowship", ["education", "philanthropy"], "Carnegie Corporation of New York", "https://www.carnegie.org/about/jobs/", "https://www.carnegie.org/", ["US"]),
  manual("fellowship", ["philanthropy", "technology"], "Knight Foundation", "https://knightfoundation.org/careers/", "https://knightfoundation.org/", ["US"]),
  manual("fellowship", ["philanthropy", "technology"], "Mozilla Foundation", "https://foundation.mozilla.org/en/who-we-are/careers/", "https://foundation.mozilla.org/", ["worldwide"]),
  manual("fellowship", ["philanthropy", "research"], "CIFAR", "https://cifar.ca/careers/", "https://cifar.ca/", ["CA"]),
  manual("fellowship", ["philanthropy", "research"], "Human Frontier Science Program", "https://www.hfsp.org/jobs", "https://www.hfsp.org/", ["worldwide"]),
  manual("fellowship", ["academia", "philanthropy", "research"], "European Molecular Biology Organization", "https://www.embo.org/about-embo/jobs/", "https://www.embo.org/", ["DE", "worldwide"]),
  manual("fellowship", ["philanthropy", "research"], "Simons Foundation", "https://www.simonsfoundation.org/careers/", "https://www.simonsfoundation.org/", ["US"]),

  manual("public", ["public-service"], "USAJobs", "https://www.usajobs.gov/", "https://www.usajobs.gov/", ["US"]),
  manual("public", ["public-service"], "UK Civil Service", "https://www.civilservicejobs.service.gov.uk/", "https://www.civilservicejobs.service.gov.uk/", ["GB"]),
  manual("public", ["public-service"], "European Personnel Selection Office", "https://eu-careers.europa.eu/en", "https://eu-careers.europa.eu/en", ["europe"]),
  manual("public", ["public-service"], "Government of Canada", "https://www.canada.ca/en/services/jobs/opportunities/government.html", "https://www.canada.ca/", ["CA"]),
  manual("public", ["public-service"], "Australian Public Service", "https://www.apsjobs.gov.au/", "https://www.apsjobs.gov.au/", ["AU"]),
  manual("public", ["public-service"], "New Zealand Government Jobs", "https://jobs.govt.nz/", "https://jobs.govt.nz/", ["NZ"]),
  manual("public", ["public-service"], "Public Jobs Ireland", "https://www.publicjobs.ie/", "https://www.publicjobs.ie/", ["IE"]),
  manual("public", ["public-service"], "Turkiye Career Gate", "https://kariyerkapisi.cbiko.gov.tr/", "https://kariyerkapisi.cbiko.gov.tr/", ["TR"]),
  manual("public", ["public-service"], "Supreme Council for Civil Personnel Selection Greece", "https://www.asep.gr/", "https://www.asep.gr/", ["GR"]),
  manual("public", ["public-service"], "Choisir le service public", "https://choisirleservicepublic.gouv.fr/", "https://choisirleservicepublic.gouv.fr/", ["FR"]),
  manual("public", ["public-service"], "Service Bund", "https://www.service.bund.de/Content/DE/Stellen/Suche/Formular.html", "https://www.service.bund.de/", ["DE"]),
  manual("public", ["public-service"], "Werken voor Nederland", "https://www.werkenvoornederland.nl/", "https://www.werkenvoornederland.nl/", ["NL"]),
  manual("public", ["public-service"], "Careers at Government Singapore", "https://www.careers.gov.sg/", "https://www.careers.gov.sg/", ["SG"]),
  manual("public", ["public-service"], "Job i Staten Denmark", "https://www.job-i-staten.dk/", "https://www.job-i-staten.dk/", ["DK"]),
  manual("public", ["public-service"], "Norwegian Labour and Welfare Administration", "https://arbeidsplassen.nav.no/stillinger", "https://www.nav.no/", ["NO"]),
  manual("public", ["public-service"], "Jobs in the Finnish State", "https://valtiolle.fi/en/", "https://valtiolle.fi/en/", ["FI"]),
  manual("public", ["public-service", "research", "technology"], "NASA", "https://www.nasa.gov/careers/", "https://www.nasa.gov/", ["US"]),
  manual("public", ["healthcare", "public-service", "research"], "National Institutes of Health", "https://jobs.nih.gov/", "https://www.nih.gov/", ["US"]),
  manual("public", ["public-service"], "UK Parliament", "https://www.parliament.uk/about/working/jobs/", "https://www.parliament.uk/", ["GB"]),
  manual("public", ["public-service", "technology"], "GovTech Singapore", "https://www.tech.gov.sg/careers/", "https://www.tech.gov.sg/", ["SG"]),

  manual("international-institution", ["international-development", "public-service"], "United Nations", "https://careers.un.org/", "https://www.un.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "United Nations Development Programme", "https://www.undp.org/careers", "https://www.undp.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "UNICEF", "https://www.unicef.org/careers", "https://www.unicef.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "UNHCR", "https://www.unhcr.org/careers", "https://www.unhcr.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "World Food Programme", "https://www.wfp.org/careers", "https://www.wfp.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "Food and Agriculture Organization", "https://www.fao.org/employment/home/en/", "https://www.fao.org/", ["worldwide"]),
  manual("international-institution", ["education", "international-development", "public-service"], "UNESCO", "https://careers.unesco.org/", "https://www.unesco.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "World Bank", "https://www.worldbank.org/en/about/careers", "https://www.worldbank.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "International Monetary Fund", "https://www.imf.org/en/About/Recruitment", "https://www.imf.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "Organisation for Economic Co-operation and Development", "https://www.oecd.org/careers/", "https://www.oecd.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "NATO", "https://www.nato.int/cps/en/natohq/recruitment.htm", "https://www.nato.int/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "Council of Europe", "https://www.coe.int/en/web/jobs", "https://www.coe.int/", ["europe"]),
  manual("international-institution", ["international-development", "public-service"], "Organization for Security and Co-operation in Europe", "https://jobs.osce.org/", "https://www.osce.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "International Committee of the Red Cross", "https://careers.icrc.org/", "https://www.icrc.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "International Federation of Red Cross and Red Crescent Societies", "https://www.ifrc.org/jobs", "https://www.ifrc.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "International Organization for Migration", "https://www.iom.int/careers", "https://www.iom.int/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "International Labour Organization", "https://jobs.ilo.org/", "https://www.ilo.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "International Criminal Court", "https://www.icc-cpi.int/jobs", "https://www.icc-cpi.int/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "European Bank for Reconstruction and Development", "https://www.ebrd.com/home/work-with-us/careers.html", "https://www.ebrd.com/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "Asian Development Bank", "https://www.adb.org/work-with-us/careers", "https://www.adb.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "Inter-American Development Bank", "https://www.iadb.org/en/careers", "https://www.iadb.org/", ["americas"]),
  manual("international-institution", ["international-development", "public-service"], "African Development Bank", "https://www.afdb.org/en/about-us/careers", "https://www.afdb.org/", ["region-other"]),
  manual("international-institution", ["international-development", "public-service"], "World Trade Organization", "https://www.wto.org/english/thewto_e/vacan_e/vacan_e.htm", "https://www.wto.org/", ["worldwide"]),
  manual("international-institution", ["international-development", "public-service"], "European Investment Bank", "https://www.eib.org/en/about/careers/index.htm", "https://www.eib.org/", ["europe"])
]);

class VerificationFailure extends Error {
  constructor(code, message, state = {}) {
    super(message);
    this.name = "VerificationFailure";
    this.code = code;
    this.state = state;
  }
}

function parseArgs(argv) {
  const options = {
    catalog: resolve(ROOT, "catalog/v1/company-portals.json"),
    unresolved: resolve(ROOT, "catalog/v1/unresolved-company-portals.json"),
    report: resolve(ROOT, "catalog/v1/verification-report.json"),
    bootstrapRemoteInTech: null,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRedirects: DEFAULT_MAX_REDIRECTS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    limit: null,
    write: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--json") {
      options[argument.slice(2)] = true;
      continue;
    }
    const pathOptions = new Map([
      ["--catalog", "catalog"],
      ["--unresolved", "unresolved"],
      ["--report", "report"],
      ["--bootstrap-remoteintech", "bootstrapRemoteInTech"]
    ]);
    if (pathOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
      options[pathOptions.get(argument)] = resolve(value);
      index += 1;
      continue;
    }
    const numericOptions = new Map([
      ["--concurrency", "concurrency"],
      ["--timeout-ms", "timeoutMs"],
      ["--max-redirects", "maxRedirects"],
      ["--max-response-bytes", "maxResponseBytes"],
      ["--limit", "limit"]
    ]);
    if (numericOptions.has(argument)) {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} requires a positive integer`);
      }
      options[numericOptions.get(argument)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.concurrency > 32) {
    throw new Error("--concurrency may not exceed 32");
  }
  if (options.timeoutMs > 15000) {
    throw new Error("--timeout-ms may not exceed 15000");
  }
  if (options.maxRedirects > 8) {
    throw new Error("--max-redirects may not exceed 8");
  }
  if (options.maxResponseBytes > 1024 * 1024) {
    throw new Error("--max-response-bytes may not exceed 1048576");
  }
  return options;
}

function scalar(frontmatter, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = frontmatter.match(new RegExp(`^${escaped}:\\s*(.+)$`, "mu"))?.[1]?.trim();
  return value?.replace(/^['"]|['"]$/gu, "") ?? null;
}

function candidateFromCatalogEntry(entry) {
  return {
    organizationId: entry.organizationId,
    organizationName: entry.organizationName,
    sectors: entry.sectors,
    countriesOrRegions: entry.countriesOrRegions,
    sourcePackId: entry.sourcePackId,
    seedCareersUrl: entry.officialCareersUrl,
    providerHint: entry.providerHint,
    remoteSignal: entry.remoteSignal,
    discovery: entry.provenance.discovery
  };
}

async function loadExistingCandidates(options) {
  const [catalog, unresolved] = await Promise.all([
    readFile(options.catalog, "utf8").then(JSON.parse),
    readFile(options.unresolved, "utf8").then(JSON.parse)
  ]);
  return [...catalog.organizations, ...unresolved.organizations].map(candidateFromCatalogEntry);
}

async function loadRemoteInTechCandidates(directory, retrievedAt) {
  const { stdout } = await execFileAsync("git", ["-C", resolve(directory), "rev-parse", "HEAD"], { encoding: "utf8" });
  const revision = stdout.trim();
  if (revision !== REMOTEINTECH_REVISION) {
    throw new Error(`Remote In Tech checkout must be pinned to ${REMOTEINTECH_REVISION}, received ${revision}`);
  }
  const companiesDirectory = join(directory, "src", "companies");
  const files = (await readdir(companiesDirectory)).filter((file) => file.endsWith(".md")).sort();
  const candidates = [];
  for (const file of files) {
    const text = await readFile(join(companiesDirectory, file), "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
    if (!frontmatter) {
      continue;
    }
    const organizationName = scalar(frontmatter, "title");
    const website = scalar(frontmatter, "website");
    const careers = scalar(frontmatter, "careers_url");
    const region = scalar(frontmatter, "region");
    const remotePolicy = scalar(frontmatter, "remote_policy");
    const companySize = scalar(frontmatter, "company_size");
    if (!organizationName || !website || !careers || !region || !remotePolicy || !companySize) {
      continue;
    }
    let officialWebsiteUrl;
    let seedCareersUrl;
    try {
      officialWebsiteUrl = canonicalizeHttpsUrl(website);
      seedCareersUrl = canonicalizeHttpsUrl(careers);
    } catch {
      continue;
    }
    const careersDomain = registrableDomain(seedCareersUrl);
    const websiteDomain = registrableDomain(officialWebsiteUrl);
    if (AGGREGATOR_DOMAINS.has(careersDomain)) {
      continue;
    }
    if (careersDomain !== websiteDomain && inferProvider(seedCareersUrl) === null) {
      continue;
    }
    const sourcePackId = ["tiny", "small", "startup"].includes(companySize) ? "startup" : "product";
    const remoteSignal = remotePolicy === "fully-remote" || remotePolicy === "remote-first"
      ? "remote-first"
      : remotePolicy === "remote-friendly"
        ? "remote-eligible"
        : "hybrid-or-onsite";
    const sourcePath = `src/companies/${encodeURIComponent(file)}`;
    candidates.push({
      organizationId: slugify(organizationName),
      organizationName,
      sectors: sourcePackId === "startup"
        ? ["software", "startup", "technology"]
        : ["product", "software", "technology"],
      countriesOrRegions: [region === "other" ? "region-other" : region],
      sourcePackId,
      seedCareersUrl,
      providerHint: inferProvider(seedCareersUrl),
      remoteSignal,
      discovery: {
        sourceId: "remoteintech-remote-jobs",
        sourceUrl: canonicalizeHttpsUrl(`${REMOTEINTECH_REPOSITORY}/blob/${REMOTEINTECH_REVISION}/${sourcePath}`),
        officialWebsiteUrl,
        sourceLicense: "ISC",
        sourceRevision: REMOTEINTECH_REVISION,
        retrievedAt
      }
    });
  }
  const byPack = Object.fromEntries(["product", "startup"].map((pack) => [pack, candidates
    .filter((candidate) => candidate.sourcePackId === pack)
    .sort((left, right) => left.organizationId.localeCompare(right.organizationId))
    .slice(0, REMOTE_ENTRIES_PER_PACK)]));
  return [...byPack.product, ...byPack.startup];
}

function deduplicateCandidates(candidates) {
  const byId = new Set();
  const byName = new Set();
  const bySeedUrl = new Set();
  const deduplicated = [];
  for (const candidate of candidates) {
    const normalizedName = normalizeText(candidate.organizationName);
    if (!candidate.organizationId || byId.has(candidate.organizationId) || byName.has(normalizedName) || bySeedUrl.has(candidate.seedCareersUrl)) {
      continue;
    }
    byId.add(candidate.organizationId);
    byName.add(normalizedName);
    bySeedUrl.add(candidate.seedCareersUrl);
    deduplicated.push(candidate);
  }
  return deduplicated.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
}

async function readBoundedBody(response, maximumBytes, state) {
  if (!response.body) {
    throw new VerificationFailure("response-empty", "Response has no body", state);
  }
  const chunks = [];
  let total = 0;
  for await (const chunkValue of response.body) {
    const chunk = Buffer.from(chunkValue);
    total += chunk.length;
    if (total > maximumBytes) {
      throw new VerificationFailure("response-too-large", `Response exceeds ${maximumBytes} bytes`, {
        ...state,
        responseBytes: total
      });
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    throw new VerificationFailure("response-empty", "Response body is empty", state);
  }
  return Buffer.concat(chunks, total);
}

function findCareerSignal(finalUrl, titleText, provider) {
  if (provider !== null) {
    return { kind: "ats-provider", matchedValue: provider };
  }
  const parsed = new URL(finalUrl);
  const pathText = normalizeText(`${parsed.hostname} ${decodeURIComponent(parsed.pathname)}`);
  const titleNormalized = normalizeText(titleText);
  for (const term of CAREER_TERMS) {
    const normalizedTerm = normalizeText(term);
    if (pathText.includes(normalizedTerm)) {
      return { kind: "url-path", matchedValue: term };
    }
    if (titleNormalized.includes(normalizedTerm)) {
      return { kind: "page-title", matchedValue: term };
    }
  }
  return null;
}

function findIdentity(candidate, finalUrl, titleText, bodyText, provider) {
  const officialDomain = registrableDomain(candidate.discovery.officialWebsiteUrl);
  const finalDomain = registrableDomain(finalUrl);
  if (officialDomain === finalDomain) {
    return { kind: "official-domain", matchedValue: finalDomain };
  }
  const { normalized, tokens } = identityTokens(candidate.organizationName);
  const titleNormalized = normalizeText(titleText);
  const bodyNormalized = normalizeText(bodyText);
  if (normalized.length >= 3 && titleNormalized.includes(normalized)) {
    return { kind: provider === null ? "page-title" : "ats-tenant-and-page", matchedValue: candidate.organizationName };
  }
  const titleToken = tokens.find((token) => token.length >= 6 && titleNormalized.split(" ").includes(token));
  if (titleToken) {
    return { kind: provider === null ? "page-title" : "ats-tenant-and-page", matchedValue: titleToken };
  }
  if (provider === null) {
    return null;
  }
  if (normalized.length >= 3 && bodyNormalized.includes(normalized)) {
    return { kind: "ats-tenant-and-page", matchedValue: candidate.organizationName };
  }
  const bodyWords = new Set(bodyNormalized.split(" "));
  const bodyToken = tokens.find((token) => bodyWords.has(token));
  if (bodyToken) {
    return { kind: "ats-tenant-and-page", matchedValue: bodyToken };
  }
  return null;
}

async function verifyCandidate(candidate, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const redirectChain = [];
  let currentUrl = normalizeRequestUrl(candidate.seedCareersUrl);
  const requestedUrls = new Set([currentUrl]);
  let statusCode = null;
  let responseBytes = 0;
  let responseSha256 = null;
  try {
    for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
      let response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml,application/json;q=0.8,text/plain;q=0.6",
            "Accept-Language": "en-US,en;q=0.8",
            "User-Agent": "VocationOS-CatalogVerifier/1.0 (+https://github.com/OnourImpram/vocation-os)"
          }
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new VerificationFailure("timeout", `Request exceeded ${options.timeoutMs} ms`, { finalUrl: currentUrl, redirectChain });
        }
        throw new VerificationFailure("network-error", error instanceof Error ? error.message : String(error), { finalUrl: currentUrl, redirectChain });
      }
      statusCode = response.status;
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new VerificationFailure("redirect-error", `HTTP ${response.status} has no Location header`, { statusCode, finalUrl: currentUrl, redirectChain });
        }
        if (redirectCount === options.maxRedirects) {
          throw new VerificationFailure("redirect-limit", `Redirect limit ${options.maxRedirects} reached`, { statusCode, finalUrl: currentUrl, redirectChain });
        }
        const next = new URL(location, currentUrl);
        if (next.protocol !== "https:") {
          throw new VerificationFailure("non-https-redirect", `Redirected to ${next.protocol}`, { statusCode, finalUrl: currentUrl, redirectChain });
        }
        const requestNext = normalizeRequestUrl(next.toString());
        if (requestedUrls.has(requestNext)) {
          throw new VerificationFailure("redirect-loop", "Redirect loop detected", { statusCode, finalUrl: currentUrl, redirectChain });
        }
        requestedUrls.add(requestNext);
        const canonicalNext = canonicalizeHttpsUrl(requestNext);
        if (!redirectChain.includes(canonicalNext)) {
          redirectChain.push(canonicalNext);
        }
        currentUrl = requestNext;
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        const code = response.status >= 500 ? "http-server-error" : "http-client-error";
        throw new VerificationFailure(code, `HTTP ${response.status}`, { statusCode, finalUrl: currentUrl, redirectChain });
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!/(?:html|json|text|xhtml)/u.test(contentType)) {
        throw new VerificationFailure("unsupported-content-type", `Unsupported content type ${contentType || "unknown"}`, { statusCode, finalUrl: currentUrl, redirectChain });
      }
      const body = await readBoundedBody(response, options.maxResponseBytes, { statusCode, finalUrl: currentUrl, redirectChain });
      responseBytes = body.length;
      responseSha256 = createHash("sha256").update(body).digest("hex");
      const bodyText = body.toString("utf8");
      const titleText = bodyText.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "";
      const finalUrl = canonicalizeHttpsUrl(currentUrl);
      const providerHint = inferProvider(finalUrl);
      const careerSignal = findCareerSignal(finalUrl, titleText, providerHint);
      if (!careerSignal) {
        throw new VerificationFailure("career-signal-not-found", "Response does not identify a career or jobs surface", {
          statusCode,
          finalUrl,
          redirectChain,
          responseBytes,
          responseSha256
        });
      }
      const identity = findIdentity(candidate, finalUrl, titleText, bodyText, providerHint);
      if (!identity) {
        throw new VerificationFailure("identity-not-confirmed", "Response does not confirm the organization identity", {
          statusCode,
          finalUrl,
          redirectChain,
          responseBytes,
          responseSha256,
          careerSignal
        });
      }
      const checkedAt = new Date().toISOString();
      return {
        ok: true,
        organization: {
          organizationId: candidate.organizationId,
          organizationName: candidate.organizationName,
          sectors: candidate.sectors,
          countriesOrRegions: candidate.countriesOrRegions,
          sourcePackId: candidate.sourcePackId,
          officialCareersUrl: finalUrl,
          providerHint,
          remoteSignal: candidate.remoteSignal,
          healthState: "verified",
          lastVerifiedAt: checkedAt,
          provenance: {
            discovery: candidate.discovery,
            verification: {
              method: "bounded-https-identity-v1",
              outcome: "identity-confirmed",
              checkedAt,
              statusCode,
              finalUrl,
              redirectChain,
              identity,
              careerSignal,
              responseBytes,
              responseSha256
            }
          }
        }
      };
    }
    throw new VerificationFailure("redirect-limit", "Redirect limit reached", { statusCode, finalUrl: currentUrl, redirectChain });
  } catch (error) {
    const failure = error instanceof VerificationFailure
      ? error
      : new VerificationFailure("verification-error", error instanceof Error ? error.message : String(error), {
        statusCode,
        finalUrl: currentUrl,
        redirectChain,
        responseBytes,
        responseSha256
      });
    const checkedAt = new Date().toISOString();
    const state = failure.state ?? {};
    return {
      ok: false,
      organization: {
        organizationId: candidate.organizationId,
        organizationName: candidate.organizationName,
        sectors: candidate.sectors,
        countriesOrRegions: candidate.countriesOrRegions,
        sourcePackId: candidate.sourcePackId,
        officialCareersUrl: candidate.seedCareersUrl,
        providerHint: inferProvider(candidate.seedCareersUrl),
        remoteSignal: candidate.remoteSignal,
        healthState: "unresolved",
        lastVerifiedAt: null,
        provenance: {
          discovery: candidate.discovery,
          verification: {
            method: "bounded-https-identity-v1",
            outcome: "unresolved",
            checkedAt,
            statusCode: state.statusCode ?? statusCode,
            finalUrl: state.finalUrl ? canonicalizeHttpsUrl(state.finalUrl) : null,
            redirectChain: state.redirectChain ?? redirectChain,
            identity: state.identity ?? null,
            careerSignal: state.careerSignal ?? null,
            responseBytes: state.responseBytes ?? responseBytes,
            responseSha256: state.responseSha256 ?? responseSha256,
            failureCode: failure.code,
            reason: failure.message.slice(0, 500)
          }
        }
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await operation(items[index]);
      completed += 1;
      if (completed % 25 === 0 || completed === items.length) {
        process.stderr.write(`Verified ${completed}/${items.length} candidate URLs\n`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function prettyJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeArtifacts(options, catalog, unresolved, reportBase) {
  await Promise.all([mkdir(dirname(options.catalog), { recursive: true }), mkdir(dirname(options.unresolved), { recursive: true }), mkdir(dirname(options.report), { recursive: true })]);
  const catalogBytes = prettyJson(catalog);
  const unresolvedBytes = prettyJson(unresolved);
  const report = {
    ...reportBase,
    catalogSha256: digest(catalogBytes),
    unresolvedSha256: digest(unresolvedBytes)
  };
  await writeFile(options.catalog, catalogBytes);
  await writeFile(options.unresolved, unresolvedBytes);
  await writeFile(options.report, prettyJson(report));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const manualCandidates = MANUAL_CANDIDATES.map((candidate) => ({
    ...candidate,
    discovery: { ...candidate.discovery, retrievedAt: candidate.discovery.retrievedAt ?? startedAt }
  }));
  let candidates;
  if (options.bootstrapRemoteInTech) {
    const remoteCandidates = await loadRemoteInTechCandidates(options.bootstrapRemoteInTech, startedAt);
    candidates = deduplicateCandidates([...manualCandidates, ...remoteCandidates]);
  } else {
    candidates = deduplicateCandidates(await loadExistingCandidates(options));
  }
  if (options.limit !== null) {
    candidates = candidates.slice(0, options.limit);
  }
  if (candidates.length === 0) {
    throw new Error("No catalog candidates found");
  }
  if (options.write && candidates.length < 250) {
    throw new Error("Refusing to write a catalog with fewer than 250 candidates");
  }
  const runId = `catalog-verify-${createHash("sha256").update(`${startedAt}\n${candidates.map((candidate) => candidate.organizationId).join("\n")}`).digest("hex").slice(0, 16)}`;
  const results = await mapConcurrent(candidates, options.concurrency, (candidate) => verifyCandidate(candidate, options));
  const verifiedByUrl = new Map();
  const verified = [];
  const unresolved = [];
  for (const result of results) {
    if (result.ok) {
      const url = result.organization.officialCareersUrl;
      if (verifiedByUrl.has(url)) {
        unresolved.push({
          ...result.organization,
          officialCareersUrl: result.organization.provenance.discovery.sourceUrl,
          providerHint: inferProvider(result.organization.provenance.discovery.sourceUrl),
          healthState: "unresolved",
          lastVerifiedAt: null,
          provenance: {
            ...result.organization.provenance,
            verification: {
              method: "bounded-https-identity-v1",
              outcome: "unresolved",
              checkedAt: result.organization.provenance.verification.checkedAt,
              statusCode: result.organization.provenance.verification.statusCode,
              finalUrl: result.organization.provenance.verification.finalUrl,
              redirectChain: result.organization.provenance.verification.redirectChain,
              identity: result.organization.provenance.verification.identity,
              careerSignal: result.organization.provenance.verification.careerSignal,
              responseBytes: result.organization.provenance.verification.responseBytes,
              responseSha256: result.organization.provenance.verification.responseSha256,
              failureCode: "duplicate-final-url",
              reason: `Final URL already belongs to ${verifiedByUrl.get(url)}`
            }
          }
        });
        continue;
      }
      verifiedByUrl.set(url, result.organization.organizationId);
      verified.push(result.organization);
    } else {
      unresolved.push(result.organization);
    }
  }
  verified.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
  unresolved.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
  const completedAt = new Date().toISOString();
  const publishedAt = new Date().toISOString();
  const verificationRun = {
    id: runId,
    startedAt,
    completedAt,
    method: "bounded-https-identity-v1",
    timeoutMs: options.timeoutMs,
    maxRedirects: options.maxRedirects,
    maxResponseBytes: options.maxResponseBytes
  };
  const bySourcePack = Object.fromEntries(SOURCE_PACK_IDS.map((id) => [id, verified.filter((organization) => organization.sourcePackId === id).length]));
  const counts = {
    attempted: candidates.length,
    verified: verified.length,
    unresolved: unresolved.length,
    bySourcePack
  };
  const catalog = {
    catalogVersion: CATALOG_VERSION,
    publishedAt,
    verificationRun,
    counts,
    sourcePacks: SOURCE_PACK_IDS.map((id) => ({
      id,
      name: SOURCE_PACK_NAMES[id],
      minimumVerified: 5,
      verifiedCount: bySourcePack[id]
    })),
    organizations: verified
  };
  const unresolvedCatalog = {
    catalogVersion: CATALOG_VERSION,
    publishedAt,
    verificationRun,
    count: unresolved.length,
    organizations: unresolved
  };
  const failureReasons = Object.fromEntries([...new Set(unresolved.map((organization) => organization.provenance.verification.failureCode))]
    .sort()
    .map((code) => [code, unresolved.filter((organization) => organization.provenance.verification.failureCode === code).length]));
  const reportBase = {
    catalogVersion: CATALOG_VERSION,
    publishedAt,
    verificationRun,
    counts,
    failureReasons
  };
  if (options.write) {
    await writeArtifacts(options, catalog, unresolvedCatalog, reportBase);
  }
  const summary = {
    wroteArtifacts: options.write,
    counts,
    failureReasons,
    paths: options.write ? {
      catalog: options.catalog,
      unresolved: options.unresolved,
      report: options.report
    } : null
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(`Catalog verification complete: ${counts.verified} verified, ${counts.unresolved} unresolved from ${counts.attempted} candidates.\n`);
  }
  if (options.write && (verified.length < 250 || SOURCE_PACK_IDS.some((id) => bySourcePack[id] < 5))) {
    process.exitCode = 1;
  }
}

await main();
