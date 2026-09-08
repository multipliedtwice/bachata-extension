const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderCapturedAssetSummary,
} = require("../dist/browser/responseFormatting.js");

test("captured provider assets are represented without exposing provider identifiers", () => {
  const summary = renderCapturedAssetSummary([
    {
      id: "asset-1",
      provider: "chatgpt",
      kind: "generatedFile",
      name: "report.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 184_320,
      sourceElement: "assistantMessage",
      providerAssetId: "signed-provider-file-id",
      downloadAvailable: true,
    },
    {
      id: "asset-2",
      provider: "claude",
      kind: "codeArtifact",
      name: "App.tsx",
      mimeType: "text/plain",
      size: 42,
      sourceElement: "artifactPane",
      providerAssetId: "artifact-secret-id",
      downloadAvailable: true,
      previewText: "Authorization: Bearer private-token-value",
    },
  ]);

  assert.match(summary, /report\.docx/);
  assert.match(summary, /codeArtifact/);
  assert.match(summary, /not present in the workspace/);
  assert.doesNotMatch(summary, /signed-provider-file-id|artifact-secret-id/);
  assert.doesNotMatch(summary, /private-token-value/);
});

test("empty provider asset lists do not alter an answer", () => {
  assert.equal(renderCapturedAssetSummary([]), undefined);
});
