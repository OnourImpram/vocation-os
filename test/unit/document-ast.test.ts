import { describe, expect, it } from "vitest";
import { renderDocumentText, validateDocumentAst, type DocumentAst } from "../../src/document-ast.js";
import { DEMO_CLAIM_TEXT, demoGraph } from "../fixtures.js";

function documentAst(overrides: Partial<DocumentAst> = {}): DocumentAst {
  return {
    documentId: "DOC-DEMO-001",
    kind: "cv",
    profileId: "DEMO-OPERATOR-001",
    opportunityId: "OPP-DEMO-001",
    generatedAt: "2026-07-11T00:00:00.000Z",
    sections: [
      {
        sectionId: "SEC-PROJECTS",
        label: "Projects",
        nodes: [
          {
            nodeId: "NODE-PROJECT-001",
            type: "sentence",
            bindingMode: "verbatim-claim",
            text: DEMO_CLAIM_TEXT,
            claimIds: ["CLM-DEMO-001"]
          }
        ]
      }
    ],
    ...overrides
  };
}

describe("claim first document AST", () => {
  it("renders a fully traced document", () => {
    const ast = documentAst();
    const validation = validateDocumentAst(ast, demoGraph(), new Date("2026-07-11T00:00:00.000Z"));
    expect(validation.valid).toBe(true);
    expect(validation.traceCoverage).toBe(1);
    expect(renderDocumentText(ast, demoGraph())).toContain("synthetic project");
  });

  it("rejects an untraced sentence", () => {
    const ast = documentAst({
      sections: [{ sectionId: "SEC-PROJECTS", label: "Projects", nodes: [{ nodeId: "NODE-PROJECT-001", type: "sentence", bindingMode: "verbatim-claim", text: "Unsupported sentence.", claimIds: [] }] }]
    });
    expect(validateDocumentAst(ast, demoGraph()).reasons).toContain("untraced-sentence:NODE-PROJECT-001");
    expect(() => renderDocumentText(ast, demoGraph())).toThrow("Document AST validation failed");
  });

  it("rejects a missing claim id", () => {
    const ast = documentAst({
      sections: [{ sectionId: "SEC-PROJECTS", label: "Projects", nodes: [{ nodeId: "NODE-PROJECT-001", type: "sentence", bindingMode: "verbatim-claim", text: "Fabricated claim.", claimIds: ["CLM-FAKE-001"] }] }]
    });
    expect(validateDocumentAst(ast, demoGraph()).reasons).toContain("missing-document-claim:NODE-PROJECT-001:CLM-FAKE-001");
  });

  it("rejects private claims in rendered career documents", () => {
    const graph = demoGraph({
      claims: [{ ...demoGraph().claims[0]!, publiclyAssertable: false }],
      validationSummary: { verifiedClaims: 1, unverifiedClaims: 0, privateClaims: 1 }
    });
    expect(validateDocumentAst(documentAst(), graph).reasons).toContain("private-document-claim:NODE-PROJECT-001:CLM-DEMO-001");
  });

  it("rejects claim inflation even when the claim id is valid", () => {
    const ast = documentAst({
      sections: [
        {
          sectionId: "SEC-PROJECTS",
          label: "Projects",
          nodes: [
            {
              nodeId: "NODE-PROJECT-001",
              type: "sentence",
              bindingMode: "verbatim-claim",
              text: "Demo operator completed an internationally awarded synthetic project.",
              claimIds: ["CLM-DEMO-001"]
            }
          ]
        }
      ]
    });
    expect(validateDocumentAst(ast, demoGraph()).reasons).toContain(
      "document-claim-text-mismatch:NODE-PROJECT-001:CLM-DEMO-001"
    );
    expect(() => renderDocumentText(ast, demoGraph())).toThrow("Document AST validation failed");
  });
});
