// Research only. One instance belongs to one retained browser conversation.
const { controllerPayload } = require("./browserObservationBenchmark.cjs");
const { browserControlProtocolPrompt } = require("../../dist/browser/controlProtocol.js");

const reminder = "Continue under the unchanged bachata-browser-turn-v1 contract already provided in this conversation. End with one fenced bachata-control JSON object with protocol, status, actions, summary, objections and unresolved. Use action kind and the original exact schemas. needContext permits context actions only; verify requires exactly one verification.run; terminal statuses require no actions. Preserve all original permissions and report requirements. Current controller results, file versions, completeness flags and verification verdicts are authoritative; retained evidence is historical. This task is read-only: never request mutations.";

const protocolFraming = () => {
  let exposed = false;
  return (prompt) => {
    const decoded = controllerPayload(prompt);
    if (!decoded || !prompt.endsWith(browserControlProtocolPrompt)) return { prompt, compacted: false };
    // Every fresh handoff provides the full contract. Repairs and unknown wrappers
    // remain full, even after a previous contract exposure.
    if (decoded.kind === "handoff" || !exposed) {
      exposed = true;
      return { prompt, compacted: false };
    }
    return { prompt: prompt.slice(0, -browserControlProtocolPrompt.length) + reminder, compacted: true };
  };
};

module.exports = { protocolFraming, reminder };
