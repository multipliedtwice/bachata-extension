/**
 * What a step means when it names a permission mode, before an adapter is chosen.
 *
 * A step may key `permissionModes` by agent id or by role id. An agent id names one adapter, so
 * an adapter's own word — Codex's `workspaceWrite`, Claude's `acceptEdits` — is unambiguous
 * there. A role id names whichever agent the run assigns to it, and every role in a shipped
 * preset lists more than one candidate, so an adapter's word under a role key is a claim about
 * an adapter the run has not chosen yet. `feature-delivery` shipped `worker: "acceptEdits"` and
 * assigned its Worker role to Codex, which has no such mode: the whole built-in catalog failed
 * to validate and every default pipeline disappeared from the editor.
 *
 * So the vocabulary a role uses is `read` and `write`, which name what the participant may do
 * rather than how one provider spells it, and the translation to a provider's own word happens
 * once, here. Execution and validation call the same function: the earlier defect was not that
 * the translation was missing — the runner already had it — but that validation judged the
 * declared word and execution judged the translated one, so a pipeline could be rejected for a
 * mode it would never have been sent.
 */

/** Modes that grant no write, in every vocabulary this project accepts. */
export const readOnlyPermissionModes = new Set(["read", "readOnly", "plan"]);

/** The vocabulary a pipeline may use without naming a provider. */
export const adapterIndependentPermissionModes = new Set(["read", "write"]);

/**
 * The word each adapter actually accepts, by intent.
 *
 * An adapter absent from this table receives the requested mode verbatim and its own
 * `validateOptions` decides: a browser adapter takes no permission mode at all, and saying so is
 * its answer to give, not this table's.
 */
const adapterPermissionVocabulary: Record<string, { read: string; write: string }> = {
  "codex-app-server": { read: "readOnly", write: "workspaceWrite" },
  "claude-code": { read: "plan", write: "acceptEdits" },
  // Z.AI GLM drives the Claude CLI, so it takes Claude's words. Leaving it out of this table
  // made `write` reach its validator verbatim, and its validator only knows Claude's vocabulary,
  // so every semantic mode declared for a zAI candidate was rejected as unsupported.
  "zai-glm": { read: "plan", write: "acceptEdits" },
};

/**
 * Which adapters have an approval concept at all.
 *
 * Approval policies are Codex's, and no other adapter accepts one. This is a SEPARATE question
 * from whether an adapter has permission modes: Claude and zAI have permission modes and no
 * approval policies, so a single "does this adapter take options" test made a role-keyed approval
 * policy an error the moment a Claude candidate could hold the role, even though the policy was
 * declared for the Codex candidate and would never be sent to Claude.
 */
const adapterApprovalVocabulary = new Set(["codex-app-server"]);

/** Whether an adapter accepts an approval policy. */
export const adapterHasApprovalVocabulary = (adapter: string): boolean =>
  adapterApprovalVocabulary.has(adapter);

/**
 * Whether an adapter has a permission vocabulary at all.
 *
 * A browser adapter has no permission or approval concept: there is no mode to send it and no
 * mode it could refuse. A step that names a mode under a ROLE key is describing what the role may
 * do across every candidate that could hold it, and `todo-implementation` lists browser agents
 * beside local ones — so for those candidates the declaration is inert rather than wrong, and
 * validation must not reject the pipeline over it. A mode named under an AGENT key is a different
 * statement: it names one adapter, and naming a setting that adapter does not have is an
 * authoring mistake that is still reported.
 */
export const adapterHasPermissionVocabulary = (adapter: string): boolean =>
  adapterPermissionVocabulary[adapter] !== undefined;

/**
 * Whether a participant may write at all, before any adapter is chosen.
 *
 * A role declared read-only is read-only whatever the step asked for: the role is the stronger
 * statement, and a step that contradicted it would be granting a write the pipeline already
 * refused.
 */
export const grantsNoWrite = (input: {
  requested: string | undefined;
  roleReadOnly: boolean;
}): boolean =>
  input.roleReadOnly ||
  (input.requested !== undefined && readOnlyPermissionModes.has(input.requested));

/**
 * The mode an adapter is actually sent.
 */
export const effectivePermissionMode = (input: {
  adapter: string;
  requested: string | undefined;
  roleReadOnly: boolean;
}): string | undefined => {
  const native = adapterPermissionVocabulary[input.adapter];
  if (!native) {
    return input.requested;
  }
  if (input.roleReadOnly) {
    return native.read;
  }
  if (input.requested === undefined) {
    return undefined;
  }
  // Only the adapter-independent words are translated. A word that is already in some adapter's
  // own vocabulary is passed through untouched so that the adapter's own validator judges it:
  // translating everything meant `workspceWrite`, `acceptEdits` on Codex and any other typo were
  // silently rewritten to a mode the adapter accepts, and an authoring mistake became a working
  // pipeline with a permission the author never asked for.
  if (adapterIndependentPermissionModes.has(input.requested)) {
    return input.requested === "read" ? native.read : native.write;
  }
  return input.requested;
};
