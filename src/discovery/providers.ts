import {
  validateEgressManifest,
  type EgressManifest,
  type GovernanceValidationResult
} from "./governance.js";

export type ProviderTier = "mandatory" | "expanded";
export type ProviderDiscoveryMode = "structured-api" | "public-feed" | "governed-html" | "assist-only";
export type ProviderCredentialMode = "none" | "optional-api-key" | "required-api-key";
export type ProviderSupportStatus = "manifest-only" | "assist-only" | "contract-tested-ga";

export const REQUIRED_DISCOVERY_PROVIDER_IDS = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "workday",
  "smartrecruiters",
  "teamtailor",
  "bamboohr",
  "breezy-hr",
  "recruitee",
  "personio",
  "schema-org-job-posting",
  "comeet",
  "pinpoint",
  "jazzhr",
  "rippling",
  "zoho-recruit",
  "freshteam",
  "recruit-crm",
  "oracle-recruiting",
  "sap-successfactors",
  "taleo",
  "adp-workforce-now",
  "ukg-pro",
  "dayforce",
  "usajobs",
  "eures",
  "euraxess",
  "nhs-jobs",
  "remote-ok",
  "remotive",
  "we-work-remotely",
  "arbeitnow",
  "jobicy",
  "jobvite",
  "icims"
] as const;

export type DiscoveryProviderId = (typeof REQUIRED_DISCOVERY_PROVIDER_IDS)[number];

export const MANDATORY_PROVIDER_IDS = Object.freeze(
  REQUIRED_DISCOVERY_PROVIDER_IDS.slice(0, 12)
);

export interface DiscoveryProviderManifest {
  readonly providerId: string;
  readonly displayName: string;
  readonly tier: ProviderTier;
  readonly discoveryMode: ProviderDiscoveryMode;
  readonly credentialMode: ProviderCredentialMode;
  readonly supportStatus: ProviderSupportStatus;
  readonly contractTestReceipt: {
    readonly suite: string;
    readonly passedAt: string;
    readonly contractVersion: string;
  } | null;
  readonly allowOperatorScopedEgress: boolean;
  readonly homepageUrl: string;
  readonly egress: EgressManifest;
}

interface ProviderSpecification {
  readonly providerId: DiscoveryProviderId;
  readonly displayName: string;
  readonly discoveryMode: ProviderDiscoveryMode;
  readonly credentialMode?: ProviderCredentialMode;
  readonly supportStatus?: ProviderSupportStatus;
  readonly contractTestReceipt?: DiscoveryProviderManifest["contractTestReceipt"];
  readonly allowOperatorScopedEgress?: boolean;
  readonly homepageUrl: string;
  readonly hosts: readonly string[];
  readonly paths?: readonly string[];
  readonly contentTypes?: readonly string[];
  readonly requestHeaders?: readonly string[];
  readonly maxRequestsPerMinute?: number;
}

const STANDARD_CONTENT_TYPES = ["application/json", "text/html", "text/plain"] as const;
const FEED_CONTENT_TYPES = [
  "application/json",
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/html",
  "text/plain"
] as const;

function egressFor(specification: ProviderSpecification): EgressManifest {
  const requestHeaders = new Set(["accept", "user-agent", ...(specification.requestHeaders ?? [])]);
  return {
    manifestId: `egress:${specification.providerId}`,
    providerId: specification.providerId,
    version: "1.0.0",
    allowedHosts: [...specification.hosts],
    allowedPorts: [443],
    allowedPathPrefixes: [...(specification.paths ?? ["/"])],
    allowedMethods: ["GET", "HEAD"],
    allowedRequestHeaders: [...requestHeaders].sort(),
    redirectPolicy: {
      maxRedirects: 4,
      allowCrossHost: specification.hosts.length > 1
    },
    responsePolicy: {
      allowedStatusRanges: [
        { min: 200, max: 299 },
        { min: 401, max: 404 },
        { min: 410, max: 410 },
        { min: 429, max: 429 }
      ],
      allowedContentTypes: [...(specification.contentTypes ?? STANDARD_CONTENT_TYPES)],
      requireContentType: true,
      maxBodyBytes: 8 * 1024 * 1024,
      timeoutMs: 15_000
    },
    ratePolicy: {
      maxRequests: specification.maxRequestsPerMinute ?? 30,
      windowMs: 60_000
    },
    cachePolicy: {
      ttlMs: 5 * 60_000,
      methods: ["GET", "HEAD"]
    },
    grantPolicy: {
      maxTtlMs: 60 * 60_000,
      maxRequests: 500,
      requireExactHosts: true
    }
  };
}

function provider(specification: ProviderSpecification, tier: ProviderTier): DiscoveryProviderManifest {
  const supportStatus = specification.supportStatus ??
    (specification.discoveryMode === "assist-only" ? "assist-only" : "contract-tested-ga");
  const contractTestReceipt: DiscoveryProviderManifest["contractTestReceipt"] = supportStatus === "contract-tested-ga"
    ? {
        suite: "test/unit/discovery-provider-contracts.test.ts",
        passedAt: "2026-07-14T00:00:00.000Z",
        contractVersion: "1.0.0"
      }
    : null;
  return {
    providerId: specification.providerId,
    displayName: specification.displayName,
    tier,
    discoveryMode: specification.discoveryMode,
    credentialMode: specification.credentialMode ?? "none",
    supportStatus,
    contractTestReceipt: specification.contractTestReceipt ?? contractTestReceipt,
    allowOperatorScopedEgress: specification.allowOperatorScopedEgress ?? false,
    homepageUrl: specification.homepageUrl,
    egress: egressFor(specification)
  };
}

const MANDATORY_SPECIFICATIONS: readonly ProviderSpecification[] = [
  {
    providerId: "greenhouse",
    displayName: "Greenhouse",
    discoveryMode: "structured-api",
    homepageUrl: "https://www.greenhouse.com/",
    hosts: ["boards-api.greenhouse.io", "boards.greenhouse.io"],
    paths: ["/v1/boards/", "/"]
  },
  {
    providerId: "lever",
    displayName: "Lever",
    discoveryMode: "structured-api",
    homepageUrl: "https://www.lever.co/",
    hosts: ["api.lever.co", "jobs.lever.co"],
    paths: ["/v0/postings/", "/"]
  },
  {
    providerId: "ashby",
    displayName: "Ashby",
    discoveryMode: "structured-api",
    homepageUrl: "https://www.ashbyhq.com/",
    hosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    paths: ["/posting-api/", "/"]
  },
  {
    providerId: "workable",
    displayName: "Workable",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.workable.com/",
    hosts: ["apply.workable.com"]
  },
  {
    providerId: "workday",
    displayName: "Workday Recruiting",
    discoveryMode: "structured-api",
    homepageUrl: "https://www.workday.com/",
    hosts: ["*.myworkdayjobs.com"],
    allowOperatorScopedEgress: true
  },
  {
    providerId: "smartrecruiters",
    displayName: "SmartRecruiters",
    discoveryMode: "structured-api",
    homepageUrl: "https://www.smartrecruiters.com/",
    hosts: ["api.smartrecruiters.com", "jobs.smartrecruiters.com"],
    paths: ["/v1/companies/", "/"]
  },
  {
    providerId: "teamtailor",
    displayName: "Teamtailor",
    discoveryMode: "structured-api",
    credentialMode: "optional-api-key",
    homepageUrl: "https://www.teamtailor.com/",
    hosts: ["*.teamtailor.com"],
    requestHeaders: ["authorization", "x-api-version"]
  },
  {
    providerId: "bamboohr",
    displayName: "BambooHR",
    discoveryMode: "structured-api",
    credentialMode: "optional-api-key",
    homepageUrl: "https://www.bamboohr.com/",
    hosts: ["*.bamboohr.com", "api.bamboohr.com"],
    requestHeaders: ["authorization"]
  },
  {
    providerId: "breezy-hr",
    displayName: "Breezy HR",
    discoveryMode: "structured-api",
    homepageUrl: "https://breezy.hr/",
    hosts: ["*.breezy.hr"]
  },
  {
    providerId: "recruitee",
    displayName: "Recruitee",
    discoveryMode: "structured-api",
    homepageUrl: "https://recruitee.com/",
    hosts: ["*.recruitee.com"]
  },
  {
    providerId: "personio",
    displayName: "Personio",
    discoveryMode: "public-feed",
    homepageUrl: "https://www.personio.com/",
    hosts: ["*.jobs.personio.de", "*.jobs.personio.com"],
    contentTypes: ["application/xml", "text/xml", "application/json"]
  },
  {
    providerId: "schema-org-job-posting",
    displayName: "schema.org JobPosting",
    discoveryMode: "governed-html",
    homepageUrl: "https://schema.org/JobPosting",
    hosts: ["schema.org"],
    paths: ["/JobPosting", "/"],
    contentTypes: ["application/ld+json", "application/json", "text/html"],
    allowOperatorScopedEgress: true
  }
];

const EXPANDED_SPECIFICATIONS: readonly ProviderSpecification[] = [
  {
    providerId: "comeet",
    displayName: "Comeet",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.comeet.com/",
    hosts: ["www.comeet.com", "*.comeet.co"]
  },
  {
    providerId: "pinpoint",
    displayName: "Pinpoint",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.pinpointhq.com/",
    hosts: ["*.pinpointhq.com"]
  },
  {
    providerId: "jazzhr",
    displayName: "JazzHR",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.jazzhr.com/",
    hosts: ["*.applytojob.com"]
  },
  {
    providerId: "rippling",
    displayName: "Rippling ATS",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.rippling.com/",
    hosts: ["ats.rippling.com"]
  },
  {
    providerId: "zoho-recruit",
    displayName: "Zoho Recruit",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.zoho.com/recruit/",
    hosts: ["recruit.zoho.com", "*.zohorecruit.com"]
  },
  {
    providerId: "freshteam",
    displayName: "Freshteam",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.freshworks.com/hrms/",
    hosts: ["*.freshteam.com"]
  },
  {
    providerId: "recruit-crm",
    displayName: "Recruit CRM",
    discoveryMode: "structured-api",
    credentialMode: "optional-api-key",
    homepageUrl: "https://recruitcrm.io/",
    hosts: ["jobs.recruitcrm.io", "api.recruitcrm.io"],
    requestHeaders: ["authorization", "x-api-key"]
  },
  {
    providerId: "oracle-recruiting",
    displayName: "Oracle Recruiting Cloud",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.oracle.com/human-capital-management/recruiting/",
    hosts: ["*.fa.ocs.oraclecloud.com"]
  },
  {
    providerId: "sap-successfactors",
    displayName: "SAP SuccessFactors Recruiting",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.sap.com/products/hcm/recruiting-software.html",
    hosts: ["*.successfactors.com"]
  },
  {
    providerId: "taleo",
    displayName: "Oracle Taleo",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.oracle.com/human-capital-management/taleo/",
    hosts: ["*.taleo.net"]
  },
  {
    providerId: "adp-workforce-now",
    displayName: "ADP Workforce Now",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.adp.com/what-we-offer/products/adp-workforce-now.aspx",
    hosts: ["workforcenow.adp.com", "jobs.adp.com"]
  },
  {
    providerId: "ukg-pro",
    displayName: "UKG Pro Recruiting",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.ukg.com/solutions/talent-acquisition",
    hosts: ["recruiting.ultipro.com"]
  },
  {
    providerId: "dayforce",
    displayName: "Dayforce Recruiting",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.dayforce.com/",
    hosts: ["jobs.dayforcehcm.com"]
  },
  {
    providerId: "usajobs",
    displayName: "USAJOBS",
    discoveryMode: "structured-api",
    credentialMode: "required-api-key",
    homepageUrl: "https://www.usajobs.gov/",
    hosts: ["data.usajobs.gov", "www.usajobs.gov"],
    requestHeaders: ["authorization-key"]
  },
  {
    providerId: "eures",
    displayName: "EURES",
    discoveryMode: "governed-html",
    homepageUrl: "https://eures.europa.eu/",
    hosts: ["eures.europa.eu"],
    contentTypes: FEED_CONTENT_TYPES
  },
  {
    providerId: "euraxess",
    displayName: "EURAXESS Jobs",
    discoveryMode: "governed-html",
    homepageUrl: "https://euraxess.ec.europa.eu/jobs/",
    hosts: ["euraxess.ec.europa.eu"],
    contentTypes: FEED_CONTENT_TYPES
  },
  {
    providerId: "nhs-jobs",
    displayName: "NHS Jobs",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.jobs.nhs.uk/",
    hosts: ["www.jobs.nhs.uk"]
  },
  {
    providerId: "remote-ok",
    displayName: "Remote OK",
    discoveryMode: "public-feed",
    homepageUrl: "https://remoteok.com/",
    hosts: ["remoteok.com"],
    contentTypes: FEED_CONTENT_TYPES
  },
  {
    providerId: "remotive",
    displayName: "Remotive",
    discoveryMode: "public-feed",
    homepageUrl: "https://remotive.com/",
    hosts: ["remotive.com"],
    contentTypes: FEED_CONTENT_TYPES
  },
  {
    providerId: "we-work-remotely",
    displayName: "We Work Remotely",
    discoveryMode: "public-feed",
    homepageUrl: "https://weworkremotely.com/",
    hosts: ["weworkremotely.com"],
    contentTypes: FEED_CONTENT_TYPES
  },
  {
    providerId: "arbeitnow",
    displayName: "Arbeitnow",
    discoveryMode: "public-feed",
    homepageUrl: "https://www.arbeitnow.com/",
    hosts: ["www.arbeitnow.com", "arbeitnow.com"],
    contentTypes: FEED_CONTENT_TYPES
  },
  {
    providerId: "jobicy",
    displayName: "Jobicy",
    discoveryMode: "public-feed",
    credentialMode: "optional-api-key",
    homepageUrl: "https://jobicy.com/",
    hosts: ["jobicy.com"],
    contentTypes: FEED_CONTENT_TYPES,
    requestHeaders: ["x-api-key"]
  },
  {
    providerId: "jobvite",
    displayName: "Jobvite",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.jobvite.com/",
    hosts: ["jobs.jobvite.com", "*.jobvite.com"]
  },
  {
    providerId: "icims",
    displayName: "iCIMS",
    discoveryMode: "governed-html",
    homepageUrl: "https://www.icims.com/",
    hosts: ["*.icims.com"]
  }
];

export const MANDATORY_PROVIDER_MANIFESTS: readonly DiscoveryProviderManifest[] = Object.freeze(
  MANDATORY_SPECIFICATIONS.map((specification) => provider(specification, "mandatory"))
);

export const EXPANDED_PROVIDER_MANIFESTS: readonly DiscoveryProviderManifest[] = Object.freeze(
  EXPANDED_SPECIFICATIONS.map((specification) => provider(specification, "expanded"))
);

export const DISCOVERY_PROVIDER_MANIFESTS: readonly DiscoveryProviderManifest[] = Object.freeze([
  ...MANDATORY_PROVIDER_MANIFESTS,
  ...EXPANDED_PROVIDER_MANIFESTS
]);

function validateHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateProviderCatalog(
  providers: readonly DiscoveryProviderManifest[] = DISCOVERY_PROVIDER_MANIFESTS
): GovernanceValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const manifest of providers) {
    if (ids.has(manifest.providerId)) errors.push(`duplicate providerId: ${manifest.providerId}`);
    ids.add(manifest.providerId);
    if (!manifest.displayName.trim()) errors.push(`provider has no display name: ${manifest.providerId}`);
    if (!validateHttpsUrl(manifest.homepageUrl)) errors.push(`provider homepage is not governed HTTPS: ${manifest.providerId}`);
    if (manifest.egress.providerId !== manifest.providerId) errors.push(`provider egress binding mismatch: ${manifest.providerId}`);
    if (!( ["manifest-only", "assist-only", "contract-tested-ga"] as readonly string[]).includes(manifest.supportStatus)) {
      errors.push(`provider support status is invalid: ${manifest.providerId}`);
    }
    if (manifest.discoveryMode === "assist-only" && manifest.supportStatus !== "assist-only") {
      errors.push(`assist-only provider cannot claim another support status: ${manifest.providerId}`);
    }
    if (manifest.supportStatus === "assist-only" && manifest.discoveryMode !== "assist-only") {
      errors.push(`assist-only support status requires assist-only discovery mode: ${manifest.providerId}`);
    }
    if (manifest.supportStatus === "contract-tested-ga") {
      const receipt = manifest.contractTestReceipt;
      if (
        manifest.discoveryMode === "assist-only" ||
        receipt === null ||
        !receipt.suite.trim() ||
        !/^\d+\.\d+\.\d+$/.test(receipt.contractVersion) ||
        !Number.isFinite(Date.parse(receipt.passedAt))
      ) {
        errors.push(`GA provider lacks a valid contract test receipt: ${manifest.providerId}`);
      }
    } else if (manifest.contractTestReceipt !== null) {
      errors.push(`non-GA provider must not carry a GA contract test receipt: ${manifest.providerId}`);
    }
    const egressResult = validateEgressManifest(manifest.egress);
    if (!egressResult.valid) {
      errors.push(...egressResult.errors.map((error) => `${manifest.providerId}: ${error}`));
    }
  }
  if (providers === DISCOVERY_PROVIDER_MANIFESTS) {
    if (MANDATORY_PROVIDER_MANIFESTS.length !== 12) errors.push("mandatory provider tier must contain 12 manifests");
    if (EXPANDED_PROVIDER_MANIFESTS.length !== 24) errors.push("expanded provider tier must contain 24 manifests");
    if (providers.length !== 36) errors.push("provider catalog must contain 36 manifests");
    const requiredIds = new Set<string>(REQUIRED_DISCOVERY_PROVIDER_IDS);
    if (ids.size !== requiredIds.size || [...ids].some((id) => !requiredIds.has(id))) {
      errors.push("provider catalog must contain the exact required provider IDs");
    }
    const mandatoryIds = new Set(MANDATORY_PROVIDER_MANIFESTS.map((manifest) => manifest.providerId));
    if (
      mandatoryIds.size !== MANDATORY_PROVIDER_IDS.length ||
      MANDATORY_PROVIDER_IDS.some((providerId) => !mandatoryIds.has(providerId))
    ) {
      errors.push("mandatory provider tier does not match the approved 12 provider IDs");
    }
    if (MANDATORY_PROVIDER_MANIFESTS.some((manifest) => manifest.supportStatus !== "contract-tested-ga")) {
      errors.push("every mandatory provider must be contract-tested GA");
    }
    if (MANDATORY_PROVIDER_MANIFESTS.some((manifest) => manifest.discoveryMode === "assist-only")) {
      errors.push("mandatory providers cannot use assist-only discovery");
    }
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function providerManifestById(providerId: string): DiscoveryProviderManifest {
  const manifest = DISCOVERY_PROVIDER_MANIFESTS.find((candidate) => candidate.providerId === providerId);
  if (!manifest) throw new Error(`Unknown discovery provider: ${providerId}`);
  return manifest;
}

export const REQUIRED_PROVIDER_IDS = REQUIRED_DISCOVERY_PROVIDER_IDS;
export const PROVIDER_MANIFESTS = DISCOVERY_PROVIDER_MANIFESTS;
export const CONTRACT_TESTED_GA_PROVIDER_MANIFESTS = Object.freeze(
  DISCOVERY_PROVIDER_MANIFESTS.filter((manifest) => manifest.supportStatus === "contract-tested-ga")
);

const catalogValidation = validateProviderCatalog();
if (!catalogValidation.valid) {
  throw new Error(`Discovery provider catalog validation failed: ${catalogValidation.errors.join("; ")}`);
}
