import { selectionIsEmpty, type PatchSelection } from "../orchestrator/patchSelection";

// EX-3. Apply-confirmation policy as a pure function of a retained run's state: what it refuses,
// what it asks, and what it discloses before staging. Effects (runtime reads, verification, stage,
// Source Control) stay in the conversation manager, which reads the verdict below.

export type ApplyConfirmationInput = {
  blockedReason?: string | undefined;
  overrideReason?: string | undefined;
  selection: PatchSelection;
  hasSelectionVerifier: boolean;
};

export type ApplyConfirmationVerdict =
  | { kind: "blocked"; logLine: string; message: string; detail: string }
  | { kind: "unverifiablePartial"; message: string; detail: string }
  | {
      kind: "confirm";
      selectedPaths: string[];
      hunkCount: number;
      needsVerification: boolean;
      confirmAction: string;
      question: string;
      detail: string;
    };

const selectedPathsOf = (selection: PatchSelection): string[] =>
  Array.from(new Set([
    ...(selection.paths ?? []),
    ...(selection.hunks ?? []).map((reference) => reference.path),
  ]));

// The confirmation question, pluralised where it is counted. Wording is the public contract the
// apply tests assert, so it is reproduced exactly: hunks read "across N file(s)" (no "selected"),
// whole files read "N selected file(s) from this run".
export const applyConfirmationQuestion = (input: {
  selectedPathCount: number;
  hunkCount: number;
}): string => {
  if (input.selectedPathCount <= 0) {
    return "Apply this run to your current branch?";
  }
  if (input.hunkCount > 0) {
    return `Apply ${String(input.hunkCount)} selected hunk${input.hunkCount === 1 ? "" : "s"} across ${String(input.selectedPathCount)} file${input.selectedPathCount === 1 ? "" : "s"} to your current branch?`;
  }
  return `Apply ${String(input.selectedPathCount)} selected file${input.selectedPathCount === 1 ? "" : "s"} from this run to your current branch?`;
};

// The modal body. An inconclusive run leads with the override disclosure before stating what
// staging does and does not do.
export const applyConfirmationDetail = (input: {
  overrideReason?: string | undefined;
  selectedPaths: string[];
}): string =>
  [
    ...(input.overrideReason
      ? [
          `This run is inconclusive: ${input.overrideReason}.`,
          "Applying it is an explicit override. Bachata does not consider this work proven.",
          "",
        ]
      : []),
    input.selectedPaths.length > 0
      ? `Bachata stages only this selection and creates no commit:\n${input.selectedPaths.slice(0, 20).join("\n")}`
      : "Bachata stages the retained work in your working tree and creates no commit.",
    "You review it in Source Control and commit it yourself.",
    "",
    "The repository must be clean and on your own branch.",
    "If applying conflicts, the working tree is restored and the run worktree is kept.",
  ].join("\n");

export const applyConfirmationPolicy = (input: ApplyConfirmationInput): ApplyConfirmationVerdict => {
  if (input.blockedReason) {
    return {
      kind: "blocked",
      logLine: `Run apply refused: ${input.blockedReason}`,
      message: `This run was not applied: ${input.blockedReason}.`,
      detail:
        "Rerun the approved checks and apply again once verification is recorded and passing. Nothing was changed.",
    };
  }
  const empty = selectionIsEmpty(input.selection);
  if (!empty && !input.hasSelectionVerifier) {
    return {
      kind: "unverifiablePartial",
      message: "A partial selection cannot be verified in this window, so it was not applied.",
      detail: "Apply the whole run, or export the patch and apply it yourself.",
    };
  }
  const selectedPaths = selectedPathsOf(input.selection);
  const hunkCount = (input.selection.hunks ?? []).length;
  return {
    kind: "confirm",
    selectedPaths,
    hunkCount,
    needsVerification: !empty && input.hasSelectionVerifier,
    confirmAction: input.overrideReason ? "Apply despite inconclusive result" : "Apply",
    question: applyConfirmationQuestion({ selectedPathCount: selectedPaths.length, hunkCount }),
    detail: applyConfirmationDetail({ overrideReason: input.overrideReason, selectedPaths }),
  };
};

// A subset of a verified run is not itself verified: the notice when the run's checks, run against
// exactly the selected bytes, did not all pass. Undefined when they did.
export const applySelectionUnprovenNotice = (input: {
  unproven: ReadonlyArray<{ command: string; status: string; stderr?: string; stdout?: string }>;
}): { message: string; detail: string } | undefined => {
  if (input.unproven.length === 0) {
    return undefined;
  }
  return {
    message: `This selection was not applied: ${String(input.unproven.length)} check${input.unproven.length === 1 ? "" : "s"} did not pass against the selected work alone.`,
    detail: [
      "A subset of a verified run is not itself verified. Bachata ran the run's checks against exactly the bytes you selected.",
      "",
      ...input.unproven.map((check) => `${check.command}: ${check.status}` + "\n" + (check.stderr || check.stdout || "").slice(0, 2_000)),
    ].join("\n"),
  };
};
