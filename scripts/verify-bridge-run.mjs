// BACHATA-AUD-01 / EX-AUD-08. Validates the Browser Bridge workflow run whose artifacts the
// paired release job is about to download.
//
// This lives in a module rather than inline shell for two reasons. It is the part with real
// logic — a run that failed can still have published artifacts before the step that failed,
// so "give me run 123" is not a safe instruction — and logic that decides whether to trust
// an artifact should be testable against the shape the API actually returns. The inline
// version compared `path` exactly against `.github/workflows/release-artifact.yml`, which no
// real response ever equals: GitHub returns the path with its ref suffix appended.
//
// Inputs arrive through the environment. A workflow input expanded into a shell script with
// `${{ }}` is substituted before bash parses the line, so a crafted input would execute.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_ID_PATTERN = /^[0-9]+$/u;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

/**
 * GitHub reports a workflow run's `path` with the ref it ran from appended, for example
 * `.github/workflows/release-artifact.yml@main`. Both that form and the bare path are
 * accepted.
 *
 * The match is anchored at the front rather than found by splitting on `@`. Splitting on the
 * last `@` was wrong twice: a ref may legally contain `@` — `git check-ref-format
 * refs/heads/feature@x` succeeds — so `…yml@feature@x` was cut at the wrong place and
 * rejected, and a malformed `…yml@` with no ref at all was accepted. Anchoring also keeps
 * the path comparison exact, so a lookalike that merely contains the expected text
 * (`evil/…/release-artifact.yml@main`, `…release-artifact.yml.bak@main`) still fails.
 */
export const workflowPathMatches = (actual, expected) => {
  if (typeof actual !== "string" || actual.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (actual === expected) return true;
  const delimited = `${expected}@`;
  // Everything after the delimiter is the ref, whatever it contains, and there has to be
  // some of it.
  return actual.startsWith(delimited) && actual.length > delimited.length;
};

/**
 * Returns every reason the run must not be trusted, so a caller can report all of them at
 * once rather than one per re-run.
 */
export const bridgeRunFindings = (run, expected) => {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return ["the workflow run response was not an object"];
  }
  const findings = [];
  if (run.status !== "completed") {
    findings.push(`run status is ${JSON.stringify(run.status)}, not "completed"`);
  }
  if (run.conclusion !== "success") {
    findings.push(
      `run conclusion is ${JSON.stringify(run.conclusion)}, not "success"; a run that did not `
        + "succeed can still have published artifacts before the step that failed",
    );
  }
  if (!workflowPathMatches(run.path, expected.workflowPath)) {
    findings.push(
      `run is ${JSON.stringify(run.path)}, not ${JSON.stringify(expected.workflowPath)}`,
    );
  }
  const headRepository = run.head_repository?.full_name;
  if (headRepository !== expected.repository) {
    findings.push(
      `run belongs to ${JSON.stringify(headRepository)}, not ${JSON.stringify(expected.repository)}`,
    );
  }
  if (expected.commit && run.head_sha !== expected.commit) findings.push("run source commit does not match the deployment checkout");
  if (expected.attempt && String(run.run_attempt) !== expected.attempt) findings.push("run attempt does not match the requested artifact attempt");
  if (expected.event && run.event !== expected.event) findings.push("run event does not match the required release trigger");
  return findings;
};

export const requestFindings = (runId, repository) => {
  const findings = [];
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    findings.push(`bridge_run_id must be a run number, got ${JSON.stringify(runId)}`);
  }
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    findings.push(`bridge_repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  return findings;
};

const fail = (findings) => {
  console.error("Refusing the requested Browser Bridge run:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
};

const main = async () => {
  const token = process.env.BRIDGE_ARTIFACT_READ_TOKEN;
  const repository = process.env.BRIDGE_REPOSITORY;
  const runId = process.env.BRIDGE_RUN_ID;
  const workflowPath = process.env.EXPECTED_WORKFLOW_PATH;

  if (!token) {
    fail(["BRIDGE_ARTIFACT_READ_TOKEN is not set"]);
    return;
  }
  if (!workflowPath) {
    fail(["EXPECTED_WORKFLOW_PATH is not set"]);
    return;
  }
  const requested = requestFindings(runId, repository);
  if (requested.length > 0) {
    fail(requested);
    return;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  if (!response.ok) {
    fail([
      `the workflow run could not be read: HTTP ${String(response.status)}. `
        + "A 404 here usually means the token has no Actions: read on that repository.",
    ]);
    return;
  }
  const run = await response.json();
  const findings = bridgeRunFindings(run, {
    repository, workflowPath,
    commit: process.env.EXPECTED_COMMIT,
    attempt: process.env.EXPECTED_RUN_ATTEMPT,
    event: process.env.EXPECTED_EVENT,
  });
  console.log(
    `run ${String(runId)}: status=${String(run.status)} conclusion=${String(run.conclusion)} `
      + `path=${String(run.path)} head=${String(run.head_repository?.full_name)}`,
  );
  if (findings.length > 0) {
    fail(findings);
    return;
  }
  console.log(`Accepted run ${String(runId)} from ${String(repository)}.`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
