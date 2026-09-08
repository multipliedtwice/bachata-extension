# Provider terms review

Every advertised provider needs a recorded integration mode and a completed usage-terms review before a stable release claims support for it.


Artifacts under test: Bachata VSIX not staged, Browser Bridge ZIP not staged.

Every record in this file is void unless it names one of those hashes. A record produced from a rebuild is void.

The integration mode below is read from this source tree and is a statement of fact about the code. The review status is a statement about legal review only. `Not reviewed` blocks the release metadata gate.

## Integration modes

| Provider | Adapter | Integration mode | Credentials | Automation surface |
| --- | --- | --- | --- | --- |
| Codex | `codex-app-server` | Local CLI process, app-server protocol over stdio | Whatever the local `codex` install already holds | No website, no browser |
| Claude Code | `claude-code` | Local CLI process | Whatever the local `claude` install already holds | No website, no browser |
| Z.AI GLM | `zai-glm` | Local Claude Code CLI process pointed at Z.AI's Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) | A Z.AI API key read from a user-named environment variable at spawn time, forwarded to this process only, never stored | No website, no browser |
| ChatGPT | `chatgpt-browser` | Browser Bridge drives an already-open, already-signed-in conversation tab | The browser profile's own session; Bachata never reads or stores credentials | DOM automation of the provider website |
| Claude | `claude-browser` | Browser Bridge drives an already-open, already-signed-in conversation tab | The browser profile's own session; Bachata never reads or stores credentials | DOM automation of the provider website |
| Generic browser target | `generic-browser` | Browser Bridge drives a user-configured site with verified send, completion, interruption, and conversation-state capabilities | The browser profile's own session | DOM automation of a user-chosen website |
| Local model endpoint | semantic interpreter / selector healing | Loopback HTTP(S); semantic interpreter may use an explicitly opted-in remote endpoint | Optional semantic API key from a user-named environment variable; healer uses none | User-configured model service; selector healing stays local |

## Source notes for human review

Retrieved 2026-09-08. Preparation only; no legal verdict or artifact acceptance.
Recheck applicable account terms and document versions against the release candidate.

| Mode | Official source evidence | Question still open |
| --- | --- | --- |
| Codex CLI | [App-server documentation](https://learn.chatgpt.com/docs/app-server) describes client initialization and local stdio integration. [Authentication documentation](https://learn.chatgpt.com/docs/auth) describes cached CLI authentication and managed login restrictions. | Confirm applicable account terms, supported CLI version and any organization restrictions. Documented transport does not establish release approval. |
| Claude Code CLI | [Legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) describes third-party hosting under Commercial Terms: unmodified binary, intact authentication, each user's own credentials and direct billing. It permits user sign-in to the hosted unmodified CLI under those conditions. | Confirm applicable terms, distribution model, authentication and naming conditions. This CLI provision does not establish permission for Claude website automation. |
| Z.AI GLM through Claude Code | [Claude Code setup](https://docs.z.ai/devpack/tool/claude) documents the Anthropic-compatible endpoint and API-key configuration. [Coding Plan FAQ](https://docs.z.ai/devpack/faq) limits plan use to supported tools and products. | Confirm whether Bachata's exact use and entitlement qualify. Endpoint compatibility alone does not establish Coding Plan coverage. |
| ChatGPT website | [ROW Terms](https://openai.com/policies/row-terms-of-use/) and [regional Terms](https://openai.com/policies/terms-of-use/) restrict automated output extraction and bypassing protective limits. | Determine applicable regional/account terms and permission for DOM submission and capture. Do not assume a user-owned browser session creates an exception. |
| Claude website | [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) restrict scraping and automated access, subject to the stated API-key or explicit-permission exception. | Establish permission covering website DOM automation. Claude Code hosting provisions do not answer this question. |
| Generic website / model endpoint | Target and service are user-configured. No single provider contract applies to every configuration. | Name each advertised target, account entitlement and applicable service/model terms before recording an outcome. |

## Review status

Local providers are reviewed against the extension alone. Browser providers are reviewed against the extension and the exact Browser Bridge build that drives the provider website, so they are recorded separately and every row must name both artifacts.

| Provider | VSIX SHA-256 | Terms reviewed | Reviewer | Date | Outcome |
| --- | --- | --- | --- | --- | --- |
| Codex | — | Not reviewed | — | — | — |
| Claude Code | — | Not reviewed | — | — | — |
| Z.AI GLM | — | Not reviewed | — | — | — |
| Local model endpoint | — | Not reviewed | — | — | — |

| Provider | VSIX SHA-256 | Bridge SHA-256 | Terms reviewed | Reviewer | Date | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| ChatGPT | — | — | Not reviewed | — | — | — |
| Claude | — | — | Not reviewed | — | — | — |
| Generic browser target | — | — | Not reviewed | — | — | — |

## What the review must answer

For each browser provider:

- whether the provider's terms permit automated interaction with the web interface from a user-controlled browser extension;
- whether the terms distinguish a user driving their own signed-in session from server-side automation;
- whether any rate, volume, or account-sharing clause applies;
- whether the provider name and marks may appear in extension metadata, and under what attribution.

For each local CLI provider:

- whether the CLI's own terms permit programmatic invocation by a third-party tool;
- whether the CLI's authentication may be reused by a process it did not start interactively.

For Z.AI GLM specifically:

- whether Z.AI's current terms permit driving its Anthropic-compatible endpoint through the Claude Code CLI from a third-party extension;
- whether that use is covered by an API-key entitlement, a GLM Coding Plan entitlement, or neither. Bachata documents the technical configuration only and claims no Coding Plan entitlement until this row records an outcome.

Record the outcome per provider with the reviewed document version and date. A provider with no completed review is not advertised as supported.
