import { minimumGitMajor, minimumGitMinor } from "../process/gitVersionSupport";
import { verifiedDocumentationUrl } from "./providerDocs";

export type RemediationAction =
  | { kind: "openExternal"; label: string; url: string }
  | { kind: "openDocument"; label: string; document: string }
  | { kind: "openSettings"; label: string; setting: string }
  | { kind: "runInTerminal"; label: string; command: string; args: string[] }
  | { kind: "runCommand"; label: string; command: string };

export type RemediationRecheck =
  | { kind: "provider"; provider: "codex" | "claude" | "zai"; label: string }
  | { kind: "git"; label: string }
  | { kind: "gitStatus"; label: string }
  | { kind: "readiness"; label: string }
  | { kind: "none" };

export type RemediationPlan = {
  id: string;
  title: string;
  condition: string;
  steps: string[];
  actions: RemediationAction[];
  recheck: RemediationRecheck;
};

export type RemediationContext = {
  detail?: string;
  codexCommand: string;
  claudeCommand: string;
  zaiCommand?: string;
  zaiTokenVariable?: string;
  remoteName?: string;
};

const providerPlan = (
  provider: "codex" | "claude",
  command: string,
  detail: string | undefined,
): RemediationPlan => {
  const name = provider === "codex" ? "Codex" : "Claude Code";
  const setting = provider === "codex" ? "bachata.codexCommand" : "bachata.claudeCommand";
  const url = verifiedDocumentationUrl(provider);
  return {
    id: `provider.install.${provider}`,
    title: `${name} is not runnable from this workspace`,
    condition: detail ?? `Bachata could not start "${command}" in this workspace.`,
    steps: [
      `Install the ${name} CLI on this machine.`,
      `Sign in with the ${name} CLI's own login flow. Bachata never stores provider credentials and never signs in for you.`,
      provider === "codex"
        ? `Confirm the CLI answers here: run "${command} --version" in this workspace. Bachata's own check goes further: it starts "${command} app-server" and requires the server to accept every payload a run would send. A --version answer alone does not make Codex ready.`
        : `Confirm the CLI answers here: run "${command} --version" in this workspace.`,
      `If the CLI is installed but Bachata cannot see it, set ${setting} to its absolute path. Bachata starts providers with a restricted environment and does not inherit your interactive shell profile.`,
      `Recheck ${name}. A full Doctor run is not required.`,
    ],
    actions: [
      { kind: "runInTerminal", label: `Run ${command} --version`, command, args: ["--version"] },
      { kind: "openSettings", label: `Set ${setting}`, setting },
      { kind: "openDocument", label: "Open provider setup notes", document: "docs/PROVIDERS.md" },
      ...(url ? [{ kind: "openExternal" as const, label: `Open ${name} documentation`, url }] : []),
    ],
    recheck: { kind: "provider", provider, label: `Recheck ${name}` },
  };
};

export const remediationPlan = (
  remediationId: string,
  context: RemediationContext,
): RemediationPlan => {
  const detail = context.detail;
  if (remediationId === "provider.install.zai") {
    const command = context.zaiCommand ?? "claude";
    const variable = context.zaiTokenVariable ?? "ZAI_API_KEY";
    return {
      id: remediationId,
      title: "Z.AI GLM is not runnable from this workspace",
      condition: detail ?? `Bachata could not use "${command}" against the configured Z.AI endpoint.`,
      steps: [
        "Install the Claude Code CLI on this machine. Bachata drives Z.AI GLM through Z.AI's Anthropic-compatible endpoint with that CLI.",
        `Create a Z.AI API key and export it as ${variable} in the environment VS Code starts from. Bachata reads that variable, forwards its value to the Z.AI process only, and never stores it.`,
        "Set bachata.zaiBaseUrl if you use an endpoint other than the documented default.",
        "Set bachata.zaiModel to the GLM model you want, so recorded evidence names the model.",
        `Confirm the CLI answers here: run "${command} --version" in this workspace.`,
        "Recheck Z.AI GLM. A full Doctor run is not required.",
      ],
      actions: [
        { kind: "runInTerminal", label: `Run ${command} --version`, command, args: ["--version"] },
        { kind: "openSettings", label: "Set bachata.zaiBaseUrl", setting: "bachata.zaiBaseUrl" },
        { kind: "openSettings", label: "Set bachata.zaiModel", setting: "bachata.zaiModel" },
        { kind: "openDocument", label: "Open provider setup notes", document: "docs/PROVIDERS.md" },
      ],
      recheck: { kind: "provider", provider: "zai", label: "Recheck Z.AI GLM" },
    };
  }
  if (remediationId === "verifier.bootstrap") {
    return {
      id: remediationId,
      title: "No repository check is approved for this repository",
      condition: detail
        ?? "This repository declares checks Bachata could run, and .bachata/verifiers.json approves none.",
      steps: [
        "Run Bachata: Bootstrap repository configuration. It proposes only checks this repository already declares, and writes nothing until you confirm.",
        "Choose the checks Bachata may run without asking. Browser acceptance and E2E runners are never proposed and are refused if declared.",
        "A declared descriptor still runs nothing on its own. Bachata starts it only after you approve this workspace once, from Bachata: Improve This Project. Every other run refuses every descriptor before a process starts, because Bachata cannot reason about what an arbitrary executable does.",
        "Until then Bachata verification covers integrity, syntax and types, and no repository test suite runs.",
      ],
      actions: [
        {
          kind: "runCommand",
          label: "Propose repository verifiers",
          command: "bachata.bootstrapConfiguration",
        },
        { kind: "runCommand", label: "Open the verifier registry", command: "bachata.verifiers" },
        { kind: "openDocument", label: "Open verifier notes", document: "docs/VERIFIERS.md" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "provider.enable") {
    return {
      id: remediationId,
      title: "This provider is disabled",
      condition: detail ?? "bachata.disabledProviders names a provider this workflow binds.",
      steps: [
        "Remove the provider from bachata.disabledProviders to let workflows bind it again.",
        "Or run Setup and choose a workflow backed by a provider you allow.",
        "Recheck readiness. A full Doctor run is not required.",
      ],
      actions: [
        { kind: "openSettings", label: "Edit bachata.disabledProviders", setting: "bachata.disabledProviders" },
        { kind: "runCommand", label: "Run Setup", command: "bachata.setup" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "provider.readScope") {
    return {
      id: remediationId,
      title: "Codex cannot withhold the paths Bachata excludes",
      condition: detail
        ?? "The installed Codex app-server protocol has no per-path readable-root capability.",
      steps: [
        "Bachata withholds version-control, credential and bachata-internal paths from every other provider. Codex cannot be told to withhold them, so a Codex turn reads the whole working directory.",
        "Set bachata.codexWorkspaceScope to wholeWorkingDirectory to record that you accept that, or leave it at refuseNarrowedScope and run this work on another provider.",
        "Recheck readiness. A full Doctor run is not required.",
      ],
      actions: [
        { kind: "openSettings", label: "Set bachata.codexWorkspaceScope", setting: "bachata.codexWorkspaceScope" },
        { kind: "runCommand", label: "Run Setup", command: "bachata.setup" },
        { kind: "openDocument", label: "Open provider setup notes", document: "docs/PROVIDERS.md" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "provider.install.codex") {
    return providerPlan("codex", context.codexCommand, detail);
  }
  if (remediationId === "provider.install.claude") {
    return providerPlan("claude", context.claudeCommand, detail);
  }
  if (remediationId === "git.install") {
    const url = verifiedDocumentationUrl("git");
    return {
      id: remediationId,
      title: "Git is unavailable or too old",
      condition: detail
        ?? `Bachata requires Git ${String(minimumGitMajor)}.${String(minimumGitMinor)} or newer and could not verify it here.`,
      steps: [
        `Install Git ${String(minimumGitMajor)}.${String(minimumGitMinor)} or newer.`,
        `Confirm it answers here: run "git --version" in this workspace.`,
        "If Git is installed but Bachata cannot see it, add it to the PATH of the environment VS Code was started from, then restart VS Code. Bachata runs Git with a restricted environment.",
        "Recheck Git. A full Doctor run is not required.",
      ],
      actions: [
        { kind: "runInTerminal", label: "Run git --version", command: "git", args: ["--version"] },
        ...(url ? [{ kind: "openExternal" as const, label: "Open Git downloads", url }] : []),
      ],
      recheck: { kind: "git", label: "Recheck Git" },
    };
  }
  if (remediationId === "doctor.run") {
    return {
      id: remediationId,
      title: "The repository must be clean before managed execution",
      condition: detail ?? "The workspace has uncommitted changes outside the paths this run may touch.",
      steps: [
        "Open Source Control and review every listed change.",
        "Commit, stash, or discard the changes that this run must not carry.",
        "Only the active root-scoped custom pipeline catalog may stay dirty; every other tracked, staged, untracked, copied, or renamed path blocks execution.",
        "Recheck the Git workspace state.",
      ],
      actions: [
        { kind: "runCommand", label: "Open Source Control", command: "workbench.view.scm" },
      ],
      recheck: { kind: "gitStatus", label: "Recheck workspace state" },
    };
  }
  if (remediationId === "workspace.open") {
    return {
      id: remediationId,
      title: "No workspace folder is open",
      condition: detail ?? "Bachata needs one trusted folder to define the run scope.",
      steps: [
        "Open the repository folder this run targets.",
        "In a multi-root window, select the root the run should use before sending.",
      ],
      actions: [
        { kind: "runCommand", label: "Open Folder", command: "workbench.action.files.openFolder" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "workspace.trust") {
    return {
      id: remediationId,
      title: "The workspace is not trusted",
      condition: detail ?? "Bachata refuses to run providers or checks in an untrusted workspace.",
      steps: [
        "Open workspace trust and review the folder.",
        "Grant trust only if you accept executing this repository's checks.",
      ],
      actions: [
        { kind: "runCommand", label: "Manage Workspace Trust", command: "workbench.trust.manage" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "bridge.useLocalWindow") {
    return {
      id: remediationId,
      title: "Browser providers need a local VS Code window",
      condition: detail
        ?? `Browser providers cannot reach a local browser from this Extension Host${context.remoteName ? `: ${context.remoteName}` : ""}.`,
      steps: [
        "Reopen this workspace in a local VS Code window, outside Remote SSH, WSL, and Codespaces.",
        "Or choose a workflow that runs on Codex or Claude Code, which need no browser.",
      ],
      actions: [
        { kind: "runCommand", label: "Choose another workflow", command: "bachata.setup" },
        { kind: "openDocument", label: "Open the support matrix", document: "docs/SUPPORT_MATRIX.md" },
      ],
      recheck: { kind: "none" },
    };
  }
  if (remediationId === "bridge.connect") {
    const url = verifiedDocumentationUrl("bridge");
    return {
      id: remediationId,
      title: "The Browser Bridge is not connected",
      condition: detail ?? "No paired Browser Bridge is reachable from this window.",
      steps: [
        "Install the Bachata Browser Bridge in a local Chrome or Edge profile and verify its checksum.",
        "In Bachata run settings choose Discover to start the local bridge and show its endpoint and pairing token.",
        "Open the Browser Bridge popup, paste the endpoint and token, and bachata.",
        "Open the provider conversation you want to use and refresh the popup tab list.",
        "Bind one ready conversation for each browser role in this pipeline.",
      ],
      actions: [
        { kind: "openDocument", label: "Open Bridge install guide", document: "docs/BROWSER_BRIDGE_INSTALL.md" },
        ...(url ? [{ kind: "openExternal" as const, label: "Open Bridge downloads", url }] : []),
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "bridge.selectSession") {
    return {
      id: remediationId,
      title: "No ready browser conversation is bound",
      condition: detail ?? "The pipeline has a browser role with no ready bound conversation.",
      steps: [
        "Open the provider conversation you want this run to use and sign in.",
        "Refresh the Browser Bridge popup tab list until the conversation reports ready.",
        "Bind that conversation to the browser role in Bachata run settings.",
        "For generic sites, a managed run also needs verified send, verified completion, confirmed interruption, and confirmed conversation state.",
      ],
      actions: [
        { kind: "openDocument", label: "Open managed browser notes", document: "docs/MANAGED_BROWSER_FALLBACK.md" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  if (remediationId === "pipeline.select" || remediationId === "pipeline.chooseSupported") {
    return {
      id: remediationId,
      title: remediationId === "pipeline.select"
        ? "No pipeline is selected"
        : "The selected pipeline cannot run here",
      condition: detail ?? "Setup lists the workflows that are runnable with the providers available on this machine.",
      steps: [
        "Run Setup and choose a workflow marked ready.",
        "Setup states the safety level of every offered workflow before it starts.",
      ],
      actions: [
        { kind: "runCommand", label: "Run Setup", command: "bachata.setup" },
      ],
      recheck: { kind: "readiness", label: "Recheck readiness" },
    };
  }
  return {
    id: remediationId,
    title: "Open Bachata settings",
    condition: detail ?? "This check has no direct action.",
    steps: ["Review the Bachata settings that control this check."],
    actions: [],
    recheck: { kind: "readiness", label: "Recheck readiness" },
  };
};
