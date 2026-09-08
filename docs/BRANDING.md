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
