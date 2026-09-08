# Adapter API

Adapter adds provider access only. Provider count does not prove quality, resolve shared blindness, or own product direction. See [Product doctrine](PRODUCT_DOCTRINE.md).

Another VS Code extension may register a new adapter type through the Bachata activation API.

Built-in adapter IDs cannot be replaced. Registration lasts for the current extension host.

```ts
api.registerAdapter(adapterType, {
  create,
  validateDefinition,
  validateOptions
});
```

## Send request

An adapter receives:

- optional provider session id, session name, and browser binding;
- prompt, working directory, and attachment paths;
- optional model;
- optional permission mode;
- optional approval policy;
- optional workspace policy with read/write/protected paths and commit, shell, network,
  and automation boundaries;
- abort signal as the second `send` argument.

## Events

An adapter may emit:

- status;
- confirmed session id;
- appended text;
- replacement text;
- captured browser response;
- completion with `completed` or `interrupted` status;
- error.

## Rules

- Abort must stop the active turn.
- Reject unsafe concurrent turns.
- Return a session ID only after provider confirmation.
- Use structured callbacks for questions and permissions when the provider supports them.
- Claude Code uses `PreToolUse` for `AskUserQuestion` and stdio control requests for permissions.
- Provider naming is best effort. Recovery uses stored provider identity.
- Never grant a permission outside deterministic policy.
- Never send telemetry or remote logs.
