export const minimumGitMajor = 2;
export const minimumGitMinor = 32;

export type GitVersionSupport = {
  supported: boolean;
  parsable: boolean;
  reported: string;
  requirementText: string;
};

export const evaluateGitVersionSupport = (reported: string): GitVersionSupport => {
  const parts = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:\.windows\.\d+)?(?:\s.*)?$/u.exec(reported.trim());
  if (!parts) {
    return {
      supported: false,
      parsable: false,
      reported,
      requirementText: `Bachata could not verify Git ${String(minimumGitMajor)}.${String(minimumGitMinor)} or newer from: ${reported}`,
    };
  }
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  const supported =
    major > minimumGitMajor || (major === minimumGitMajor && minor >= minimumGitMinor);
  return {
    supported,
    parsable: true,
    reported,
    requirementText: supported
      ? ""
      : `Bachata requires Git ${String(minimumGitMajor)}.${String(minimumGitMinor)} or newer for deterministic worktree orchestration; found ${reported}`,
  };
};
