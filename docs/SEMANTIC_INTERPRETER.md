# Optional semantic browser-action interpreter

Interpreter classifies execution actions only. It cannot validate software reasoning, disposition model findings, or correct product direction. See [Product doctrine](PRODUCT_DOCTRINE.md).

Default: off.

Purpose: classify natural-language action candidates from browser model output.

It never gains execution authority.

Deterministic code still owns:

- action schema;
- path containment;
- permission policy;
- destructive-operation rules;
- command execution;
- output limits;
- result reinjection.

Default endpoint: empty. When no endpoint is configured, Bachata auto-discovers local backends in this order:

```text
LM Studio: http://127.0.0.1:1234  (requests under /v1)
Ollama:    http://127.0.0.1:11434 (requests under /api)
```

Remote endpoints require `bachata.browserSemanticInterpreterAllowRemote`. Opt-in sends bounded
action-candidate evidence from captured responses to the configured endpoint. It grants no
execution authority. All model transports reject redirects, including redirects back to the
same host. Optional API key comes from the configured environment variable. Selector healing
stays loopback-only.

Explicit `bachata-action` blocks remain the preferred deterministic format. During programmatic browser turns, the protocol prompt supplies a fresh `turnToken`; structured action blocks must echo that exact token or they are ignored as stale/unbound input.

## Selector healing is separate

Browser DOM selector healing has independent settings:

```text
bachata.browserSelectorHealingEnabled
bachata.browserSelectorHealingBackend
bachata.browserSelectorHealingEndpoint
bachata.browserSelectorHealingModel
bachata.browserSelectorHealingTimeoutMs
```

Selector healing is disabled by default and should be enabled for unattended use only after the exact backend, endpoint, and model pass the compatibility fixtures in the stable-release gate. Selector-healing endpoints remain HTTP(S) loopback-only. `bachata.browserSemanticInterpreterAllowRemote` applies only to semantic interpretation and never forwards a remote semantic endpoint to the browser selector healer. Changes to selector-healing settings are pushed to an already-connected Browser Bridge without requiring reconnect.
