export const VERIFICATION_POLICY_MARKER = "verification-policy";
export const VERIFICATION_OPERATIONS_MARKER = "verification-operations";

export const policyBlocks = ({
  controllerCommands,
  verifierCommandPrefix,
  verifierRegistryPath,
}) => {
  const controller = controllerCommands.map((command) => `\`${command}\``);
  const verifier = `\`${verifierCommandPrefix}<id>\``;
  const operations = [...controller, verifier];
  const accepted = operations.length > 1
    ? `${operations.slice(0, -1).join(", ")}, and ${operations[operations.length - 1]}`
    : operations.join("");
  return {
    [VERIFICATION_POLICY_MARKER]: [
      `Autonomous verification runs ${controller.join(" and ")} by default. A ${verifier} descriptor declared in \`${verifierRegistryPath}\` is refused before any process starts unless one workspace-level approval has been recorded and the run was started by the Improve command; every other run refuses every descriptor. That approval says a human accepted these executables, not that they are safe: a descriptor names an executable and Bachata cannot reason about what that executable does, and an ordinary script can start a browser E2E runner from inside itself. Direct E2E command forms are still classified on the executable, argument vector and the package scripts of the stated working directory, and refused, as defense in depth. That classification does not follow a manager's \`--prefix\` or \`--workspace\` into another package, and it is not a proof that arbitrary code cannot launch E2E. \`tests/humanE2ePolicy.test.cjs\` asserts these boundaries at runtime, and this generated block records the declaration only.`,
    ].join("\n"),
    [VERIFICATION_OPERATIONS_MARKER]: [
      "| Operation | Owner | Declared in |",
      "| --- | --- | --- |",
      ...controllerCommands.map((command) =>
        `| \`${command}\` | controller | built in |`),
      `| \`${verifierCommandPrefix}<id>\` | repository | \`${verifierRegistryPath}\` |`,
    ].join("\n"),
  };
};

const region = (marker) => ({
  open: `<!-- generated:${marker} -->`,
  close: `<!-- /generated:${marker} -->`,
});

export const renderGeneratedRegions = (document, blocks) =>
  Object.entries(blocks).reduce((result, [marker, body]) => {
    const { open, close } = region(marker);
    const start = result.indexOf(open);
    if (start === -1) return result;
    const end = result.indexOf(close, start);
    if (end === -1) return result;
    return `${result.slice(0, start + open.length)}\n${body}\n${result.slice(end)}`;
  }, document);

export const generatedRegionMarkers = (document) =>
  Array.from(document.matchAll(/<!-- generated:([a-z-]+) -->/gu), (match) => match[1]);
