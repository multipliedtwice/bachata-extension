import {
  actionRisk,
  BrowserActionCandidate,
  createBrowserActionCandidate,
  deduplicateBrowserActions,
} from "./actions";
import {
  createReadOnlyInterpretationCandidates,
  interpretLocalCandidates,
} from "./localInterpretation";
import { CapturedSegment } from "./protocol";
import type { BrowserControlAction } from "./controlProtocol";

export type SemanticInterpreterOptions = {
  backend?: "auto" | "lmstudio" | "ollama" | undefined;
  endpoint?: string | undefined;
  model: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  maxInputBytes: number;
  allowRemote: boolean;
  managedContextActions?: boolean | undefined;
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
};

const endpointUrl = (value: string): URL => {
  const normalized = value.trim();
  return new URL(normalized.includes("://") ? normalized : `http://${normalized}`);
};

const sourceForEvidence = (responseText: string, evidence: string) => {
  const start = Math.max(0, responseText.indexOf(evidence));
  return {
    start,
    end: start + evidence.length,
    text: evidence,
  };
};

export type SemanticInterpretationResult = {
  actions: BrowserActionCandidate[];
  contextActions: BrowserControlAction[];
  warning?: string;
};

export const interpretBrowserActions = async (
  responseText: string,
  _segments: CapturedSegment[],
  deterministicActions: BrowserActionCandidate[],
  options: SemanticInterpreterOptions,
  signal: AbortSignal,
): Promise<SemanticInterpretationResult> => {
  if (deterministicActions.some((action) => action.origin === "structured")) {
    return { actions: deterministicActions, contextActions: [] };
  }
  try {
    const endpoint = options.endpoint?.trim() ? endpointUrl(options.endpoint) : undefined;
    if (endpoint && !options.allowRemote && !isLoopbackHostname(endpoint.hostname)) {
      throw new Error("Remote semantic interpreters are disabled");
    }
    const bounded = Buffer.from(responseText, "utf8");
    if (bounded.length > Math.max(16_384, options.maxInputBytes)) {
      throw new Error(
        `Browser response exceeds the semantic interpreter input limit of ${String(options.maxInputBytes)} bytes`,
      );
    }
    const candidates = createReadOnlyInterpretationCandidates(responseText).filter(
      (candidate) => options.managedContextActions
        || (candidate.kindHint !== "dependencies" && candidate.kindHint !== "dependents"),
    );
    if (candidates.length === 0) {
      return { actions: deterministicActions, contextActions: [] };
    }
    const interpretation = await interpretLocalCandidates(
      candidates,
      {
        backend: options.backend ?? (endpoint?.port === "11434" ? "ollama" : endpoint?.port === "1234" ? "lmstudio" : "auto"),
        ...(endpoint ? { endpoint: `${endpoint.protocol}//${endpoint.host}` } : {}),
        model: options.model,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        timeoutMs: options.timeoutMs,
        // EX-R26-02. Carry authority only on the opted-in remote path; opt-out is already rejected
        // above and selector healing never sets allowRemote, so both stay loopback-only.
        ...(options.allowRemote && endpoint && !isLoopbackHostname(endpoint.hostname)
          ? { allowRemoteEndpoint: true }
          : {}),
      },
      signal,
    );
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const semanticContextActions: BrowserControlAction[] = [];
    const semanticActions = interpretation.execute.flatMap((id): BrowserActionCandidate[] => {
      const candidate = byId.get(id);
      if (!candidate) {
        return [];
      }
      if (candidate.kindHint === "list" && typeof candidate.parsedArguments.path === "string") {
        const value = { kind: "workspace.list" as const, path: candidate.parsedArguments.path };
        return [createBrowserActionCandidate({ ...value, risk: actionRisk(value.kind), origin: "semantic", confidence: "medium", source: sourceForEvidence(responseText, candidate.evidence) })];
      }
      if (candidate.kindHint === "dependencies" && typeof candidate.parsedArguments.path === "string") {
        semanticContextActions.push({ kind: "context.dependencies", path: candidate.parsedArguments.path });
        return [];
      }
      if (candidate.kindHint === "dependents" && typeof candidate.parsedArguments.path === "string") {
        semanticContextActions.push({ kind: "context.dependents", path: candidate.parsedArguments.path });
        return [];
      }
      if (candidate.kindHint === "read" && typeof candidate.parsedArguments.path === "string") {
        const value = {
          kind: "workspace.read" as const,
          path: candidate.parsedArguments.path,
        };
        return [createBrowserActionCandidate({
          ...value,
          risk: actionRisk(value.kind),
          origin: "semantic",
          confidence: "medium",
          source: sourceForEvidence(responseText, candidate.evidence),
        })];
      }
      if (candidate.kindHint === "search" && typeof candidate.parsedArguments.query === "string") {
        const value = {
          kind: "workspace.search" as const,
          path: ".",
          query: candidate.parsedArguments.query,
        };
        return [createBrowserActionCandidate({
          ...value,
          risk: actionRisk(value.kind),
          origin: "semantic",
          confidence: "medium",
          source: sourceForEvidence(responseText, candidate.evidence),
        })];
      }
      return [];
    });
    return {
      actions: deduplicateBrowserActions([...deterministicActions, ...semanticActions]),
      contextActions: semanticContextActions,
      ...(interpretation.ambiguous.length > 0
        ? { warning: `Local semantic interpreter abstained on ${String(interpretation.ambiguous.length)} candidate(s).` }
        : {}),
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return {
      actions: deterministicActions,
      contextActions: [],
      warning: `Optional semantic action interpretation failed; deterministic extraction continued: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
