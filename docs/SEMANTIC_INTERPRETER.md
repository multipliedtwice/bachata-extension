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

## Laya: compatibility seam only, not an available backend

There is no shipped Laya runtime or user-facing Laya switch. This source includes an
optional, controller-injected typed-decision adapter for the action interpreter only.
It is not a Qwen replacement and not a selector-healing backend. Activation never
constructs it. Existing settings, discovery, startup checks, broker transports and
Browser Bridge contracts are unchanged.

### Upstream evidence and stopping boundary

Inspected on 2026-09-21, using upstream `main` (a mutable reference, not a pinned release):

- [`Agent.system_one`](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py)
  takes `state` and a `questions` dictionary. Choice answers contain `type`, `choice`,
  `probabilities`, `confidence`, and `action.act_probability`; the return dictionary
  contains `model: "laya-rl-agent"`, `answers`, and `usage`. `predict` is an alias.
- [`pyproject.toml`](https://github.com/NandhaKishorM/laya/blob/main/pyproject.toml)
  declares Python and Torch, Transformers, Safetensors, Hugging Face Hub and NumPy.
  `Agent` can download missing checkpoints. None of these dependencies or behaviours
  is installed, started or reproduced by this extension.
- The official HTTP-service request [issue 32](https://github.com/NandhaKishorM/laya/issues/32)
  and proposed implementations [PR 31](https://github.com/NandhaKishorM/laya/pull/31)
  and [PR 3](https://github.com/NandhaKishorM/laya/pull/3) were open when inspected.
  They are not an adopted service contract. Community Node/ONNX ports are not evidence
  of compatibility with the official Python SDK.
- [`common.build_sequence`](https://github.com/NandhaKishorM/laya/blob/main/laya/common.py)
  truncates tokenized state to its remaining context budget and replaces mask-token
  text. The SDK response does not attest that the full state survived tokenization.
  Its confidence is normalized entropy, not the selected label's probability.
- The upstream [README limitations](https://github.com/NandhaKishorM/laya#honest-limits)
  warn about language-specific failures, high-confidence wrong answers, calibration
  and weak zero-shot typed decisions. No Bachata accuracy or speed result follows
  from the upstream benchmarks.

A real runtime would need a separately reviewed local execution/transport contract,
explicit installation authority, verified checkpoint identity and language support,
and tokenizer-aware input-completeness checks. Those are not present here. Work stops
at the injected seam and fixtures; production compatibility is **not claimed**.

### Internal adapter contract

`createLayaDecisionAdapter(systemOne)` in `src/browser/layaDecision.ts` takes a
host-supplied callback. Its request object contains the two SDK argument names,
`state` and `questions`; this is not an HTTP request definition. The callback's
second argument is a controller cancellation signal, not a third Python argument.
It returns a decoded SDK dictionary, never generated text. No endpoint, process
launcher, Python runtime, model download, native ONNX dependency or remote capability
is supplied. The callback is trusted extension-host code, not a sandbox for arbitrary
plugins, and is responsible for its own resource cleanup.

The callback may be injected through `SemanticInterpreterOptions.decisionAdapter`
or the fourth argument of `interpretLocalCandidates`. Normal callers supply neither.
The existing nonempty, confirmed local-model check still runs first. This seam does
not mark Laya ready or reuse a Qwen compatibility verdict as evidence about Laya.

Each question is keyed by an existing controller candidate ID and has exactly three
fixed choices: `execute`, `reject`, `ambiguous`. Requests contain frozen copies of ID,
read-only kind and exact candidate evidence, not mutable arguments, action objects,
source records, credentials, permissions or provider routes. The parser still owns
candidate creation; the action mapper still uses original controller arguments and
all existing execution validation. Structured actions bypass the optional gate.
Captured GPT responses and file/action payloads are never rewritten by this adapter.

Only a complete, decisive batch can avoid the existing Qwen/local-model call. Unknown,
omitted, duplicate or malformed answers, extra fields, low confidence, ambiguous
choices and transport failures delegate the whole batch without merging partial
answers. Both SDK confidence and selected probability must be at least `0.9`;
probabilities must be finite, normalized within `0.0002` for four-decimal rounding,
and agree with the unique selected outcome. Confidence must match the published
normalized-entropy formula within `0.002`, allowing for probability rounding. These
are conservative fixture acceptance rules, not calibrated guarantees. `action.act_probability` is validated as data and
never interpreted as execution authority. SDK `score`, `noul`, and Router metadata
are intentionally unsupported.

Only decoded, closed, own-data-property dictionaries are accepted. JSON strings are
rejected outright, including strings containing duplicate keys; no repair is attempted.
A Python dictionary cannot retain duplicate keys. Any future serialization wrapper
must reject duplicates before decoding instead of silently collapsing them. The
outer typed-decision gate independently rejects duplicated or incomplete candidate-ID
classifications returned by any injected adapter.

### Bounds, failures and verification

The gate accepts at most 16 distinct controller IDs, 2,048 UTF-8 bytes per evidence
string and 8,192 bytes for the serialized candidate projection. The SDK-argument
object is capped at 16,384 bytes. Inputs are refused, not sliced, normalized or
translated. Invalid Unicode scalar sequences are refused. Thai, Russian, Chinese,
Latin combining marks and emoji are exercised as exact-data fixtures, not evidence
of model language competence. Byte bounds are resource limits, **not token bounds**;
upstream truncation remains a reason not to activate a real runtime.

One attempt has a maximum 250 ms budget. Timeout aborts the callback signal and
returns to the existing model path even when a callback ignores cancellation. Late
results are discarded; late failures are handled. An adapter whose earlier callback
is still pending is not dispatched again; there is no retry queue. Synchronous host
code cannot be preempted, but a result completed after the deadline is not accepted.
Caller cancellation propagates rather than falling back or reporting success.
Qwen transport failures continue through the existing deterministic fallback.

`tests/fixtures/laya/system-one-choice.json` freezes the observed SDK shape with
**synthetic**, not measured, probabilities and usage. `tests/layaDecision.test.cjs`
checks that exact fixture, strict answers, authority exclusion, Unicode/size limits,
timeout and cancellation. `tests/layaSemanticInterpreter.test.cjs` checks the real
interpreter entry points with injected Laya and Qwen transports, including exact
fallback requests, deterministic results and unchanged file content. Neither test
loads an upstream checkpoint. These fixtures do not establish plug-and-play Python
package support, runtime compatibility, model accuracy, latency or token savings.
