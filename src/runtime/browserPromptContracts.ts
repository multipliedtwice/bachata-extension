import type { BrowserContextReferences } from "../browser/contextReferences";
import type { ControllerEvidenceLine } from "./controllerVerification";
import { randomUUID } from "node:crypto";

export const managedBrowserWirePrompt = (prompt: string): string => `BACHATA_REQUEST_ID:${randomUUID()}\n\n${prompt}`;

export const browserControllerText = (text: string, workspaceRoot: string): string => {
  if (!workspaceRoot || workspaceRoot === "." || workspaceRoot === "/") return text;
  return text.split(workspaceRoot).join(".").split(workspaceRoot.replace(/\\/g, "/")).join(".");
};

export const browserControllerEvidence = (
  evidence: readonly ControllerEvidenceLine[], workspaceRoot: string,
): ControllerEvidenceLine[] => evidence.map((line) => ({
  ...line,
  command: `configured check ${line.id}`,
  output: browserControllerText(line.output, workspaceRoot),
}));

export const composeAgentPrompt = (input: {
  task: string;
  continuity?: string | undefined;
  managedHandoff?: string | undefined;
  controllerContract?: string | undefined;
  workspaceProtocol?: string | undefined;
}): string => [input.continuity, input.managedHandoff ?? input.task, input.controllerContract, input.workspaceProtocol]
  .filter((part): part is string => typeof part === "string" && part.length > 0)
  .join("\n\n");

export const browserCandidateReference = (references: BrowserContextReferences, candidate: string): string =>
  references.objectReference("candidate", candidate);
