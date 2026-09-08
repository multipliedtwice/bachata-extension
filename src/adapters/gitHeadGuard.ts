import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { gitProcessEnvironment } from "../process/safeEnvironment";

const execFileAsync = promisify(execFile);

export type GitHeadSnapshot = {
  head: string;
  symbolicHead?: string;
};

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  unavailable: boolean;
};

const gitResult = async (cwd: string, args: string[]): Promise<GitResult> => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_048_576,
      windowsHide: true,
      env: gitProcessEnvironment(cwd),
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, unavailable: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, stdout: "", stderr: "", unavailable: true };
    }
    const exitCode = (error as { code?: unknown }).code;
    if (typeof exitCode === "number") {
      return {
        ok: false,
        stdout: String((error as { stdout?: unknown }).stdout ?? ""),
        stderr: String((error as { stderr?: unknown }).stderr ?? ""),
        unavailable: false,
      };
    }
    throw error;
  }
};

export const captureGitHeadSnapshot = async (cwd: string): Promise<GitHeadSnapshot | undefined> => {
  const probe = await gitResult(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.unavailable || !probe.ok || probe.stdout.trim() !== "true") return undefined;
  const headResult = await gitResult(cwd, ["rev-parse", "--verify", "HEAD"]);
  const symbolicResult = await gitResult(cwd, ["symbolic-ref", "-q", "HEAD"]);
  const symbolicHead = symbolicResult.ok ? symbolicResult.stdout.trim() || undefined : undefined;
  return {
    head: headResult.ok ? headResult.stdout.trim() : "",
    ...(symbolicHead === undefined ? {} : { symbolicHead }),
  };
};

export const assertGitHeadUnchanged = async (
  cwd: string,
  baseline: GitHeadSnapshot | undefined,
): Promise<void> => {
  if (!baseline) return;
  const current = await captureGitHeadSnapshot(cwd);
  if (!current) {
    throw new Error("Git repository state became unavailable during a commitMode=never turn");
  }
  if (current.head !== baseline.head || current.symbolicHead !== baseline.symbolicHead) {
    throw new Error(
      `Git HEAD changed during a commitMode=never turn (${baseline.symbolicHead ?? "detached"}@${baseline.head || "unborn"} -> ${current.symbolicHead ?? "detached"}@${current.head || "unborn"})`,
    );
  }
};
