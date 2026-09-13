const createL10nStub = (messages = {}) => ({
  t: (source, ...values) => {
    const message = typeof source === "string" ? source : source.message;
    const substitutions = typeof source === "string"
      ? values.length === 1 && values[0] !== null && typeof values[0] === "object"
        ? values[0]
        : values
      : source.args ?? {};
    return (messages[message] ?? message).replace(/\{\{|\}\}|\{([^{}]+)\}/gu, (match, key) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      return Object.hasOwn(substitutions, key) ? String(substitutions[key]) : match;
    });
  },
});

module.exports = { createL10nStub };
