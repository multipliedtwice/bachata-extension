import { readFile } from "node:fs/promises";
import * as path from "node:path";

/*
 * Defense in depth over a command line, not a guarantee about a process. `@` and `:` join
 * the leading class so a scoped package and a symbolic prefix cannot hide a runner, and the
 * package-script patterns skip manager flags that take a value (`--prefix DIR`,
 * `--workspace PKG`) rather than stopping at the first non-flag token, so the script NAME is
 * still recovered. The directory those flags select is not followed: scripts resolve against
 * the stated working directory only, and a script that lives in another package is not read.
 *
 * This can never be complete: `node scripts/check.js` may start any of these from inside
 * itself. Autonomous execution therefore refuses repository-declared executables outright,
 * in verificationPolicy.ts; these patterns only catch the direct forms.
 */
const explicitE2ePattern = /(?:^|[\s;&|()"'`@\/_:-])(?:e2e|end[-_ ]to[-_ ]end)(?:$|[\s;&|()"'`:\/._-])/iu;
const browserE2eRunnerPattern = /(?:^|[\s;&|()"'`@\/_:-])(?:cypress|webdriverio|wdio|nightwatch|testcafe|playwright-core)(?:\.cmd|\.exe)?(?:$|[\s;&|()"'`:\/._-])/iu;
const playwrightTestPattern = /(?:^|[\s;&|()"'`@\/_:-])playwright(?:\.cmd|\.exe)?(?:\s+|\/(?:test\/)?cli\.js\s+|[\/\\][^\s;&|]*\s+)test(?:$|[\s;&|()"'`:\/._-])/iu;
const playwrightPackagePattern = /@playwright\/test/iu;
const packageScriptPatterns = [
  /\b(?:npm|pnpm|yarn|bun)(?:\s+[^\s;&|]+)*?\s+run(?:-script)?\s+(?:-{1,2}[^\s;&|]+\s+)*([^\s;&|]+)/giu,
  /\b(?:pnpm|yarn|bun)(?:\s+-{1,2}[^\s;&|]+)*\s+([^\s;&|]+)/giu,
];
const packageTestPatterns = [
  /\b(?:npm|pnpm|yarn)(?:\s+-{1,2}[^\s;&|]+)*\s+test(?:\s|$|[;&|])/iu,
];

const stripScriptToken = (value: string): string => value.replace(/^['"]|['"]$/gu, "").trim();

export const commandLooksLikeHumanOnlyE2e = (command: string): boolean => {
  const normalized = command.trim();
  return explicitE2ePattern.test(normalized)
    || browserE2eRunnerPattern.test(normalized)
    || playwrightTestPattern.test(normalized)
    || playwrightPackagePattern.test(normalized);
};

const invokedPackageScripts = (command: string): string[] => {
  const scripts: string[] = [];
  for (const pattern of packageScriptPatterns) {
    pattern.lastIndex = 0;
    for (const match of command.matchAll(pattern)) {
      const script = stripScriptToken(match[1] ?? "");
      if (script) scripts.push(script);
    }
  }
  if (packageTestPatterns.some((pattern) => pattern.test(command))) scripts.push("test");
  return [...new Set(scripts)];
};

const readPackageScripts = async (cwd: string): Promise<Record<string, string>> => {
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
};

const scriptResolvesToHumanOnlyE2e = (
  scriptName: string,
  scripts: Record<string, string>,
  visited: Set<string>,
): boolean => {
  if (visited.has(scriptName)) return false;
  visited.add(scriptName);
  if (commandLooksLikeHumanOnlyE2e(scriptName)) return true;
  const lifecycleNames = [`pre${scriptName}`, scriptName, `post${scriptName}`];
  for (const lifecycleName of lifecycleNames) {
    if (lifecycleName !== scriptName && visited.has(lifecycleName)) continue;
    if (lifecycleName !== scriptName) visited.add(lifecycleName);
    if (commandLooksLikeHumanOnlyE2e(lifecycleName)) return true;
    const body = scripts[lifecycleName];
    if (!body) continue;
    if (commandLooksLikeHumanOnlyE2e(body)) return true;
    if (invokedPackageScripts(body).some((nested) => scriptResolvesToHumanOnlyE2e(nested, scripts, visited))) return true;
  }
  return false;
};

export type HumanOnlyE2ePlan = {
  executable: string;
  args: readonly string[];
  cwd: string;
};

// The classifier reads a command line, so a resolved execution plan is rendered into one.
// Rendering the whole vector, rather than testing the executable alone, is what catches
// `npx cypress run` and `playwright test`, where no single token is decisive.
export const planCommandLine = (executable: string, args: readonly string[]): string =>
  [executable, ...args].join(" ");

export const planLooksLikeHumanOnlyE2e = (
  executable: string,
  args: readonly string[],
): boolean => commandLooksLikeHumanOnlyE2e(planCommandLine(executable, args));

export const humanOnlyE2eRefusal = async (
  command: string,
  cwd: string,
): Promise<string | undefined> => {
  if (commandLooksLikeHumanOnlyE2e(command)) {
    return "E2E verification is human-only and was not executed automatically.";
  }
  const invoked = invokedPackageScripts(command);
  if (invoked.length === 0) return undefined;
  const scripts = await readPackageScripts(cwd);
  if (invoked.some((script) => scriptResolvesToHumanOnlyE2e(script, scripts, new Set<string>()))) {
    return "E2E verification is human-only and the selected package script resolves to E2E, so it was not executed automatically.";
  }
  return undefined;
};

// The plan form resolves package scripts against the directory the process will actually
// run in, so a nested workingDirectory reads its own package.json rather than the
// repository root's.
export const humanOnlyE2ePlanRefusal = async (
  plan: HumanOnlyE2ePlan,
): Promise<string | undefined> =>
  humanOnlyE2eRefusal(planCommandLine(plan.executable, plan.args), plan.cwd);
