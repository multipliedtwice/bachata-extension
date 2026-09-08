export const VALIDATION_TARGETS = [
  "todo", "pipelines", "verifiers", "contracts", "exportPolicy", "repositoryPolicy",
];

const finding = (target, file, message) => ({ target, file, message });

export const validateTodo = ({ path: filePath, source, parseTodoDocument, defaults }) => {
  if (source === undefined) return [];
  try {
    const document = parseTodoDocument(filePath, source, defaults);
    return document.tasks
      .filter((task) => !task.completed && (task.paths ?? []).length === 0)
      .map((task) => finding("todo", filePath, `${task.id} declares no Paths, so it cannot run autonomously`));
  } catch (error) {
    return [finding("todo", filePath, error instanceof Error ? error.message : String(error))];
  }
};

export const validateJsonDocument = ({ target, path: filePath, source, parse, required = false }) => {
  if (source === undefined) return required ? [finding(target, filePath, "is missing")] : [];
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return [finding(target, filePath, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)];
  }
  return parse(value).map((message) => finding(target, filePath, message));
};

export const validatePipeline = ({ path: filePath, source, validatePipelineDefinition }) =>
  validateJsonDocument({
    target: "pipelines",
    path: filePath,
    source,
    required: true,
    parse: (value) => {
      const result = validatePipelineDefinition(value);
      return result.success ? [] : (result.errors ?? ["failed validation"]);
    },
  });

export const validateVerifiers = ({ path: filePath, source, parseVerifierRegistry }) =>
  validateJsonDocument({
    target: "verifiers",
    path: filePath,
    source,
    parse: (value) => parseVerifierRegistry(value).errors,
  });

export const validateExportPolicy = ({ path: filePath, source, parseExportPolicy }) =>
  validateJsonDocument({
    target: "exportPolicy",
    path: filePath,
    source,
    parse: (value) => parseExportPolicy(value).errors,
  });

export const validateRepositoryPolicy = ({ path: filePath, source, parseRepositoryPolicy }) =>
  validateJsonDocument({
    target: "repositoryPolicy",
    path: filePath,
    source,
    parse: (value) => parseRepositoryPolicy(value).errors,
  });

export const validateContract = ({
  pipeline,
  filePath,
  buildExecutionContract,
  isDeclarableVerificationCommand,
  workingDirectory,
  repositoryPolicy,
}) => {
  let contract;
  try {
    contract = buildExecutionContract({
      pipeline,
      maxIterations: 10,
      iterations: 1,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(repositoryPolicy === undefined ? {} : { repositoryPolicy }),
    });
  } catch (error) {
    return [finding("contracts", filePath, `contract could not be resolved: ${error instanceof Error ? error.message : String(error)}`)];
  }
  const findings = (contract.policyRefusals ?? []).map((refusal) =>
    finding("contracts", filePath, refusal));
  contract.verification
    .filter((command) => !isDeclarableVerificationCommand(command))
    .forEach((command) => findings.push(
      finding("contracts", filePath, `declares verification "${command}" that autonomous execution refuses`),
    ));
  if (contract.safetyLevel !== "review" && contract.scope.writeScope === "readOnly") {
    findings.push(finding("contracts", filePath, "resolves to a writing safety level with a read-only write scope"));
  }
  if (contract.commitPolicy === "allow" && contract.verification.length === 0) {
    findings.push(finding("contracts", filePath, "grants commit authority with no controller verification"));
  }
  if (contract.scope.writeScope === "configured" && contract.scope.writablePaths.length === 0) {
    findings.push(finding("contracts", filePath, 'declares writeScope "configured" but no writable paths'));
  }
  return findings;
};

export const formatFindings = (findings) => findings.length === 0
  ? "Local Bachata configuration is valid."
  : `Local Bachata configuration has ${String(findings.length)} finding(s):\n${findings
      .map((item) => `- [${item.target}] ${item.file}: ${item.message}`)
      .join("\n")}`;
