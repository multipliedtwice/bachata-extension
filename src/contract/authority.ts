import type { ExecutionContract } from "./executionContract";
import type { WorkspaceWriteScope } from "../adapters/types";

export type ContractAuthority = {
  pipelineId: string;
  workingDirectory?: string;
  writeScope: WorkspaceWriteScope;
  writablePaths: string[];
  readablePaths: string[];
  protectedPaths: string[];
  commitPolicy: "never" | "allow";
  verification: string[];
  providers: string[];
  outboundContext: string[];
};

export type AuthorityChange = {
  label: string;
  from: string;
  to: string;
  expands: boolean;
};

export type AuthorityDiff = {
  changes: AuthorityChange[];
  expanded: boolean;
};

const writeScopeRank: Record<WorkspaceWriteScope, number> = {
  readOnly: 0,
  task: 1,
  configured: 2,
  workspace: 3,
};

const sorted = (values: string[]): string[] => [...new Set(values)].sort();

export const contractAuthority = (contract: ExecutionContract): ContractAuthority => ({
  pipelineId: contract.pipelineId,
  ...(contract.scope.workingDirectory === undefined
    ? {}
    : { workingDirectory: contract.scope.workingDirectory }),
  writeScope: contract.scope.writeScope,
  writablePaths: sorted(contract.scope.writablePaths),
  readablePaths: sorted(contract.scope.readablePaths),
  protectedPaths: sorted(contract.scope.protectedPaths),
  commitPolicy: contract.commitPolicy,
  verification: sorted(contract.verification),
  providers: sorted(contract.providers.map((provider) =>
    provider.model
      ? `${provider.agentId}:${provider.adapter}:${provider.model}`
      : `${provider.agentId}:${provider.adapter}`,
  )),
  outboundContext: sorted((contract.outboundContext ?? []).map((manifest) =>
    `${manifest.agentId}:${manifest.transport}:${String(manifest.entries.length)}`,
  )),
});

export const authorityFingerprint = (authority: ContractAuthority): string =>
  JSON.stringify([
    authority.pipelineId,
    authority.workingDirectory ?? "",
    authority.writeScope,
    authority.writablePaths,
    authority.readablePaths,
    authority.protectedPaths,
    authority.commitPolicy,
    authority.verification,
    authority.providers,
    authority.outboundContext,
  ]);

const listLabel = (values: string[]): string =>
  values.length === 0 ? "none" : values.join(", ");

const addedTo = (previous: string[], next: string[]): string[] =>
  next.filter((value) => !previous.includes(value));

const listChange = (
  label: string,
  previous: string[],
  next: string[],
  expandsOnAdd: boolean,
): AuthorityChange[] => {
  const added = addedTo(previous, next);
  const removed = addedTo(next, previous);
  if (added.length === 0 && removed.length === 0) return [];
  return [{
    label,
    from: listLabel(previous),
    to: listLabel(next),
    expands: expandsOnAdd ? added.length > 0 : removed.length > 0,
  }];
};

export const authorityDiff = (
  previous: ContractAuthority | undefined,
  next: ContractAuthority,
): AuthorityDiff => {
  if (!previous) return { changes: [], expanded: false };
  const changes: AuthorityChange[] = [];
  if (previous.pipelineId !== next.pipelineId) {
    changes.push({
      label: "Pipeline",
      from: previous.pipelineId,
      to: next.pipelineId,
      expands: false,
    });
  }
  if ((previous.workingDirectory ?? "") !== (next.workingDirectory ?? "")) {
    changes.push({
      label: "Working directory",
      from: previous.workingDirectory ?? "not selected",
      to: next.workingDirectory ?? "not selected",
      expands: true,
    });
  }
  if (previous.writeScope !== next.writeScope) {
    changes.push({
      label: "Write scope",
      from: previous.writeScope,
      to: next.writeScope,
      expands: writeScopeRank[next.writeScope] > writeScopeRank[previous.writeScope],
    });
  }
  changes.push(...listChange("Writable paths", previous.writablePaths, next.writablePaths, true));
  changes.push(...listChange("Readable paths", previous.readablePaths, next.readablePaths, true));
  changes.push(...listChange("Protected paths", previous.protectedPaths, next.protectedPaths, false));
  if (previous.commitPolicy !== next.commitPolicy) {
    changes.push({
      label: "Commit authority",
      from: previous.commitPolicy,
      to: next.commitPolicy,
      expands: next.commitPolicy === "allow",
    });
  }
  changes.push(...listChange("Verification", previous.verification, next.verification, false));
  changes.push(...listChange("Providers", previous.providers, next.providers, true));
  changes.push(...listChange("Outbound context", previous.outboundContext, next.outboundContext, true));
  return { changes, expanded: changes.some((change) => change.expands) };
};

export type ContractAcknowledgement = {
  authority: ContractAuthority;
  fingerprint: string;
  diff: AuthorityDiff;
  open: boolean;
  acknowledgementRequired: boolean;
};

export const contractAcknowledgement = (
  contract: ExecutionContract,
  acknowledged: ContractAuthority | undefined,
): ContractAcknowledgement => {
  const authority = contractAuthority(contract);
  const fingerprint = authorityFingerprint(authority);
  const diff = authorityDiff(acknowledged, authority);
  // EX-UI-02. The contract opens when there is something new to read in it: an authority that
  // moved since the reader last acknowledged one. A room that has never run has acknowledged
  // nothing, and opening ten evidence sections above the composer before anything has executed
  // buries the thing the reader came to do. The requirement to acknowledge is still said, beside
  // Send, where it blocks.
  return {
    authority,
    fingerprint,
    diff,
    open: acknowledged !== undefined && diff.changes.length > 0,
    acknowledgementRequired: acknowledged === undefined
      ? contract.scope.writeScope !== "readOnly" || contract.commitPolicy === "allow"
      : diff.expanded,
  };
};
