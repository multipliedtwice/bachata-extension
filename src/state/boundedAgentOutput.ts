/**
 * The live provider stream, bounded.
 *
 * `AgentPanelState.output` is raw provider output accumulated one delta at a time, in the extension
 * host and again in the webview. Nothing capped it: a run that streamed for long enough grew a
 * string without limit in both, and `state.snapshot` carried the whole of it on every refresh. It is
 * the same defect class as an unbounded event payload or transcript entry, on the one path that is
 * live rather than replayed.
 *
 * The newest output is what a reader watching a stream wants, so the cut is at the front and says
 * so. The result is at or below the cap, which makes bounding an already bounded stream a no-op —
 * the host and the panel accumulate at different chunk boundaries, and neither may drift upwards.
 */
export const AGENT_OUTPUT_UNITS = 256 * 1024;

export const AGENT_OUTPUT_ELISION = "[earlier output not shown]\n";

export const boundedAgentOutput = (text: string): string => {
  if (text.length <= AGENT_OUTPUT_UNITS) return text;
  const from = text.length - AGENT_OUTPUT_UNITS + AGENT_OUTPUT_ELISION.length;
  const code = text.charCodeAt(from);
  const start = code >= 0xdc00 && code <= 0xdfff ? from + 1 : from;
  return `${AGENT_OUTPUT_ELISION}${text.slice(start)}`;
};
