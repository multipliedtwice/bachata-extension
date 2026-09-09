const approvedRelease = {
  schemaVersion: 1,
  authorizedOn: "2026-09-09",
  ownerStatement: "well, we can lift no-ship",
  explicitApproval: "publish the existing Bachata 0.7.0 VSIX to VS Code only, deferring manual acceptance, compatibility/terms reviews and screenshots for this release.",
  target: "vscode",
  vsix: { version: "0.7.0", sha256: "b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03" },
  bridge: { version: "0.6.7", sha256: "d531ebb5f4988b99a78fd00c06e82f7e2c8cfbb10bf3b7b3a2f5f4f904af7fc5" },
};

const matches = (value, expected) => {
  if (typeof expected !== "object") return value === expected;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => matches(value[key], item));
};

export const readOwnerPublicationApproval = (document = "") => {
  const headings = [...document.matchAll(/^## Owner publication authorization[ \t]*$/gmu)];
  if (headings.length === 0) return undefined;
  const section = /(?:^|\n)## Owner publication authorization[ \t]*\n([\s\S]*?)(?=\n## |$)/u.exec(document)?.[1]?.trim();
  const block = /^```json\n([\s\S]*?)\n```$/u.exec(section ?? "");
  if (headings.length !== 1 || !block) throw new Error("Invalid owner publication authorization record.");
  let approval;
  try {
    approval = JSON.parse(block[1]);
  } catch {
    throw new Error("Invalid owner publication authorization JSON.");
  }
  if (!matches(approval, approvedRelease)) {
    throw new Error("Owner publication authorization does not match the approved one-release scope.");
  }
  return approval;
};

export const ownerPublicationApproved = (document, artifacts, target = "both") => {
  const approval = readOwnerPublicationApproval(document);
  if (!approval) return false;
  if (target !== approval.target) throw new Error("Owner publication authorization permits VS Code only.");
  for (const kind of ["vsix", "bridge"]) {
    if (artifacts[kind]?.version !== approval[kind].version
      || artifacts[kind]?.sha256 !== approval[kind].sha256) {
      throw new Error(`Owner publication authorization does not cover the staged ${kind} artifact.`);
    }
  }
  return true;
};
