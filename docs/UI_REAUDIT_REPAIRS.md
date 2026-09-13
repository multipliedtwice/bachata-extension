# UI and recovery repairs — Archive 9

This update uses the supplied Archive(9).zip as its baseline.

## Interface

- A compact logo replaces the text Home tab. Workspace Direction is reached through Runs.
- The conversation minimap uses a narrow line rail with tighter pointer spacing, keyboard navigation, and larger touch targets. It follows the visible message; Latest returns to the end.
- JSON is indented and highlighted whether fenced, standalone, embedded in prose, or still streaming. Long JSON strings wrap. Copy preserves original text and numeric literals.
- Composer footer accordions and duplicate mutation messages are removed. Actionable requirements are reached from run status or blocked Send, with current reasons, remedies, and keyboard focus restoration.
- Provider and model choices are direct selectors. Opening Agents loads unknown model catalogs; Refresh asks the provider again. Providers without catalogs expose a model ID or alias field. A saved run retains its original assignments; use New run to change them.
- Typography and gutters are tighter. Secondary disclosures are flat, use consistent chevrons, and have hover, focus, and pressed states. Empty workspace Direction and Runs search results retain their own bounded scrolling areas.
- Pending participant conclusions survive checkpoint persistence within the existing redaction and size limits. Missing saved previews say so and link to the matching participant message when available.

## Continue an interrupted pipeline

Use Resume in the stopped run. Completed steps are retained; the interrupted step may execute again.

If an existing run reports unconfirmed provider cleanup, first verify that its previous agents/processes have stopped. In the VS Code Command Palette, run **Bachata: Clear Resource Quarantine**, select the affected resources, and confirm. Return to the run and use Resume. Clearing quarantine itself does not terminate processes.

For future stops, a quarantine created by this window can clear when cleanup of the same original execution later succeeds. Quarantines belonging to another execution, a previous session, or uncertain cleanup stay blocked. Provider shutdown now propagates failed process termination rather than reporting success.

## Choose a model

Start a new run, open Agents, select the provider, then select a reported model or enter an exact model ID. Current documented examples are `gpt-5.6-sol` and `gpt-6-astra` for Codex, and `opus` or `fable` for Claude. Availability depends on the installed provider and account; the extension does not invent availability.

References: [Codex models](https://learn.chatgpt.com/docs/models) and [Claude model configuration](https://code.claude.com/docs/en/model-config).

## Typography and spacing follow-up

- Shared typography now gives panel titles, section headings, body text, and captions consistent sizes and weights. Default sizes are 17, 15, 13, and 12 pixels respectively; larger VS Code font preferences still scale them. JSON display and editors share the configured editor font size.
- Chat, composer, Execution, and the run header share a 20-pixel outer gutter. The compact minimap fits inside it without shifting the transcript. Touch input uses a 32-pixel gutter to preserve larger minimap targets.
- Runs, Inspector, Agents, settings, and editor panels use consistent internal padding: 16 pixels, reduced to 12 in narrow windows. Cards and fields use a 12-pixel spacing unit, and major sections use 16 pixels.
- Removed stacked padding on pipeline rows and closed Direction sections, extra gaps between agent assignments, and an override that removed the pipeline editor notice's side margins. Dialog fields are separated and action rows wrap; Inspector rows and editor fieldsets can shrink safely.
- Step numbers and unread badges grow with the configured font instead of retaining fixed heights.

This follow-up was audited against source and the earlier screenshots. TypeScript checks, build emission in an isolated source copy, the existing interaction-policy checks, stylesheet structural checks, and layout-script syntax checks passed. Live rendering remains unverified because local preview access was blocked in this environment.

## Verification

Implementation was checked against the supplied screenshots, source, compiled behavior, and controlled runtime fixtures. Live VS Code appearance, the user's installed provider processes, and account-specific model availability could not be verified in this environment.

The full build passed. Focused provider, assignment, JSON, result persistence, navigation, and safe recovery checks passed. A broader adapter run was inconclusive here: child process status was unavailable through this environment’s `/proc` view, and older fixture cleanup then caused subsequent failures. Termination verification remains strict; the implementation does not clear quarantine on uncertain cleanup.

## Localization support

The interface now uses shared translation catalogs and VS Code's display language, with English fallback and locale-aware date and number formatting. Command and settings copy uses the native manifest catalog. See [LOCALIZATION.md](LOCALIZATION.md) for current coverage and adding translations. This update ships English catalogs only.
