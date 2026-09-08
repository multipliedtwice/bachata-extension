export type TemplateValues = Record<string, string>;

type TemplateToken =
  | { type: "text"; value: string }
  | { type: "placeholder"; key: string };

const placeholderKeyPattern = /^[a-zA-Z0-9_.-]+$/;

const parseTemplate = (template: string): TemplateToken[] => {
  const tokens: TemplateToken[] = [];
  let text = "";
  let index = 0;

  const flushText = (): void => {
    if (text) {
      tokens.push({ type: "text", value: text });
      text = "";
    }
  };

  while (index < template.length) {
    if (template.startsWith("{{{{", index)) {
      text += "{{";
      index += 4;
      continue;
    }
    if (template.startsWith("}}}}", index)) {
      text += "}}";
      index += 4;
      continue;
    }
    if (template.startsWith("{{", index)) {
      const end = template.indexOf("}}", index + 2);
      if (end < 0) {
        throw new Error("Template contains a malformed placeholder");
      }
      const key = template.slice(index + 2, end).trim();
      if (!placeholderKeyPattern.test(key)) {
        throw new Error("Template contains a malformed placeholder");
      }
      flushText();
      tokens.push({ type: "placeholder", key });
      index = end + 2;
      continue;
    }
    if (template.startsWith("}}", index)) {
      throw new Error("Template contains a malformed placeholder");
    }
    text += template[index];
    index += 1;
  }

  flushText();
  return tokens;
};

export const extractTemplateKeys = (template: string): string[] => {
  const keys: string[] = [];
  const seen = new Set<string>();
  parseTemplate(template).forEach((token) => {
    if (token.type === "placeholder" && !seen.has(token.key)) {
      seen.add(token.key);
      keys.push(token.key);
    }
  });
  return keys;
};

export const renderTemplate = (
  template: string,
  values: TemplateValues,
): string =>
  parseTemplate(template)
    .map((token) => {
      if (token.type === "text") {
        return token.value;
      }
      if (!Object.prototype.hasOwnProperty.call(values, token.key)) {
        throw new Error(`Missing template value: ${token.key}`);
      }
      return values[token.key];
    })
    .join("");
