import { redactText } from "./redact";
import { boundedAgentOutput } from "../state/boundedAgentOutput";

export const STREAM_REDACTION_CARRY_UNITS = 8 * 1024;
export const STREAM_REDACTION_ELISION = "[oversized output record withheld]\n";

const awaitingValue = /(?:\b(?:authorization|proxy-authorization|x-api-key|api[_ -]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie|[A-Z0-9_]*(?:TOKEN|SECRET|PRIVATE_KEY|CREDENTIALS?))["']?\s*[:=]\s*(?:(?:Bearer|Basic|Digest)\s*)?|\bBearer\s*|--?(?:api[-_]?key|token|secret|password|passwd|authorization)\s*)$/iu;
const armorHeader = /-----BEGIN ([A-Z0-9 ]{1,64})-----$/u;

export const createStreamRedactor = () => {
  let carry = "";
  let quote = "";
  let escaped = false;
  let armorEnd = "";
  let tail = "";
  let dropping = false;
  let pendingValue = false;
  let previous = "";

  const clear = (): void => {
    carry = "";
    quote = "";
    escaped = false;
    armorEnd = "";
    tail = "";
    dropping = false;
    pendingValue = false;
    previous = "";
  };

  const push = (text: string): string => {
    let output = "";
    for (const character of text) {
      tail = (tail + character).slice(-256);
      if (!dropping) carry += character;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if ((character === '"' || character === "'") && (!previous || /[\s:=([{,]/u.test(previous))) {
        quote = character;
      }
      previous = character;
      if (character === "-") {
        const header = armorHeader.exec(tail);
        const label = header?.[1];
        if (!armorEnd && label && (label.endsWith("PRIVATE KEY") || label === "PGP PRIVATE KEY BLOCK")) {
          armorEnd = `-----END ${label}-----`;
        } else if (armorEnd && tail.endsWith(armorEnd)) {
          armorEnd = "";
        }
      }
      if (!dropping && carry.length > STREAM_REDACTION_CARRY_UNITS) {
        dropping = true;
        pendingValue = awaitingValue.test(carry);
        carry = "";
        output = boundedAgentOutput(output + STREAM_REDACTION_ELISION);
      }
      if (dropping && pendingValue && !/\s/u.test(character)) pendingValue = false;
      if (character !== "\n" || quote || armorEnd) continue;
      if (awaitingValue.test(tail)) {
        pendingValue = true;
        continue;
      }
      if (pendingValue) continue;
      if (!dropping) output = boundedAgentOutput(output + redactText(carry));
      clear();
    }
    return output;
  };

  const finish = (): string => {
    const output = dropping ? "" : quote ? "[incomplete quoted output withheld]" : redactText(carry);
    clear();
    return output;
  };

  return { push, finish, reset: clear, retainedUnits: (): number => carry.length + tail.length + armorEnd.length };
};

export const redactedAgentOutput = (text: string): string => {
  const redactor = createStreamRedactor();
  return boundedAgentOutput(redactor.push(text) + redactor.finish());
};
