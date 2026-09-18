# Branding

One product name: **Bachata**.

Opening: **Build your own AI workflow for software work.**

Core value: configurable roles, instructions, sequence, handoffs and revision loops.
Explain AI assistants before technical terms. Define pipeline through an example.
Internal positioning: Human-directed agentic pipelines for software refinement.

## Forms

| Surface | Form | Example |
| --- | --- | --- |
| Display name | `Bachata` | `"displayName": "Bachata"` |
| Command title | category `Bachata` plus a bare `<Action>` title, which the Command Palette renders as `Bachata: <Action>` | `"category": "Bachata"`, `"title": "Run TODO.md"` |
| Setting key | `bachata.<camelCase>` | `bachata.codexCommand` |
| Extension id | `<publisher>.bachata-vscode` | package `bachata-vscode` |
| Controller operation | `bachata:<kebab-case>` | `bachata:workspace-integrity` |
| Repository directory | `.bachata/` | `.bachata/pipelines` |
| Environment variable | `BACHATA_<UPPER_SNAKE>` | `BACHATA_PROCESS_SCOPE_TOKEN` |
| Companion display name | `Bachata Browser Bridge` | UI and prose |
| Companion package | `bachata-browser-bridge` | package and ZIP |
| Filename prefix | `bachata-` | `bachata-vscode-0.7.0.vsix` |

## Rules

- Write `Bachata` in prose and UI.
- Write technical namespaces lowercase.
- Reserve `BACHATA_` for environment variables.
- Keep ordinary English `pair`, `paired`, and `pairing` unchanged.
- Give every contributed command `"category": "Bachata"` and a bare title. The palette then reads `Bachata: <Action>`, while editor, Explorer, SCM, and Problems menus show the action alone.

## Claims

Lead with configurable workflows. Show who does what, in what order, with which feedback loop. Review, planning and coding are tasks the pipeline coordinates. Human owns direction and acceptance. Current product focuses on software work in VS Code.

Never claim one pipeline, model agreement, agent count, arbitration, passing checks, or review saturation proves correctness. Never sell execution restrictions as product value.

## Assets

`media/readme-header.png` is a concept illustration generated with built-in imagegen. It is not a
product screenshot and must never be presented as one. Alt text lives in README.

`media/readme-demo.gif` = real webview (`dist/webview.js`, `dist/webview.css`), Dark Modern theme vars
from `tests/fixtures/webview-layout/theme-colors.json`, pipeline list and role slots from real
`presets/` via `pipelineSummary` and `assignmentSlots`. Host replies and every transcript message =
sample data, not provider output. Not a release screenshot; `media/screenshots/` rules unchanged.
README caption must keep saying messages are sample data. UI change in picker, Agents popover or
transcript → recapture.

Generation prompt:

> Use case: ads-marketing. Asset type: wide README header illustration for Bachata. Core product: people configure how AI assistants work together by assigning roles and instructions, arranging a sequence of steps, passing results between steps, and adding review/revision loops. Generate a polished editorial paper-sculpture illustration, 1536x768 landscape. Dark charcoal background, warm terracotta orange and ivory layered paper, soft studio shadows. Show four distinct modular task cards in a clear left-to-right sequence, connected by fine paper ribbons: planning document, code document, review notes, revised document. Orange and ivory small participant symbols on the cards suggest different assistants assigned to different steps. A graceful return ribbon runs from review back to the coding step to clearly show revision. One small detached task card above the sequence suggests configurability and rearrangement. The configurable connected workflow is the main subject, not a standalone assistant. Spacious composition and generous margins, readable at 720px wide. No words, letters, logos, robots, mascots, badges, watermark or actual product UI. Abstract short marks for code and notes. Match Bachata Browser Bridge's orange/ivory/charcoal paper-sculpture aesthetic.
