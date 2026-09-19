# Optional local models: action interpreter and selector healing

Bachata can use a model running on your own machine, through Ollama or LM Studio, for two separate jobs. Both are off by default, and both are configured and checked on their own.

| Feature | What it does | Without it |
| --- | --- | --- |
| Browser action interpreter | Classifies plain-language action requests in a browser model's answer, such as "please read src/index.ts", as execute, reject or ambiguous. | Explicit `bachata-action` blocks and built-in pattern matching only. |
| Selector healing | When a saved page selector stops matching, it picks the right control from the page's own enumerated candidates. | Saved and deterministic selectors only. |

## Set up

1. Install [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), start it, and install at least one chat or instruct model.
2. In VS Code, open the Bachata view, select a pipeline, open **Agents**, and expand **Local models**.
3. Select **Turn on** for the feature you want. With no endpoint set and the backend on `auto`, Bachata looks for LM Studio on `127.0.0.1:1234` and Ollama on `127.0.0.1:11434`, lists their models, and checks one.
4. The feature's status reads **not checked** until a model passes its check, then **automatic** or **your choice**. It reads **unavailable** with the reason and the fix when no server answered, the server has no usable model, or the model you pinned is gone.
5. To pin a model, pick it from the list. **Choose automatically** clears the pin.

You can also use the settings listed below. The `*Enabled` switches are read from user or machine settings only, so a repository cannot turn them on. Model and feature changes are refused while a run holds the configuration.

## Each feature is checked on its own task

Before a model is used, Bachata sends it one bounded probe for that feature and reads the answer with that feature's own rules:

- Interpreter: five action candidates. Two direct requests must be executed, a quoted tutorial line and quoted source code must be rejected, and a vague intention must be marked ambiguous. The interpreter's own parser reads the answer.
- Selector healing: a `bachata-dom-heal-v1` page with a chat textarea, a conversation region, a send button, a reply, and three decoys (a search box, a link, a settings button). The answer must be the closed dom-heal JSON shape and must pick the chat controls, not the decoys.

A pass for one feature does not count for the other. When the answer names a different model from the one asked for, the check fails. A request that fails, for example because the model will not load, records no verdict, and the model is tried again on the next pass.

The startup check is a gate, not proof of quality on your own pages. See [Stable release gate](STABLE_RELEASE_GATE.md#local-interpreter-gate).

## Action interpreter

The interpreter classifies execution actions only. It cannot validate software reasoning, disposition model findings, or correct product direction. See [Product doctrine](PRODUCT_DOCTRINE.md).

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

Discovery and the startup compatibility check are made under the same policy as interpretation
itself: the same reach, the same bearer token from
`bachata.browserSemanticInterpreterApiKeyEnvironment`, and the deadline from
`bachata.browserSemanticInterpreterTimeoutMs`. A remote endpoint is therefore discovered and
checked only where the opt-in is set, and it is never discovered anonymously or on selector
healing's deadline. Selector healing keeps its own deadline
(`bachata.browserSelectorHealingTimeoutMs`), sends no credential and stays loopback-only.

Two consumers configured identically share one discovery. Each still gets its own compatibility
verdict, because each is checked on its own task. Two that differ in endpoint, authentication,
remote policy or deadline share nothing: neither reads the other's answer. No credential value is persisted, logged, rendered or used in any identity or cache key —
only the name of the environment variable it came from.

Changing `bachata.browserSemanticInterpreterAllowRemote`,
`bachata.browserSemanticInterpreterApiKeyEnvironment`,
`bachata.browserSemanticInterpreterTimeoutMs` or `bachata.browserSelectorHealingTimeoutMs`
cancels work in flight, drops the affected verdict and runs the check again.

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

Selector healing is disabled by default and should be enabled for unattended use only after the exact backend, endpoint, and model pass the compatibility fixtures in the stable-release gate. The Browser Bridge's side of the contract is described in the Bridge's `docs/GENERIC_BROWSER_PROVIDER.md` (Auto-heal contract). Selector-healing endpoints remain HTTP(S) loopback-only. `bachata.browserSemanticInterpreterAllowRemote` applies only to semantic interpretation and never forwards a remote semantic endpoint to the browser selector healer. Changes to selector-healing settings are pushed to an already-connected Browser Bridge without requiring reconnect.

## Interpreter settings

```text
bachata.browserSemanticInterpreterEnabled
bachata.browserSemanticInterpreterBackend
bachata.browserSemanticInterpreterEndpoint
bachata.browserSemanticInterpreterModel
bachata.browserSemanticInterpreterTimeoutMs
bachata.browserSemanticInterpreterMaxInputBytes
bachata.browserSemanticInterpreterAllowRemote
bachata.browserSemanticInterpreterApiKeyEnvironment
```
