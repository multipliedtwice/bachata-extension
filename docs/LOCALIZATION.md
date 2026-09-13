# Localization

Bachata follows the VS Code display language. The extension host uses `vscode.env.language` and `vscode.l10n`; the webview receives the same locale and translation bundle. There is no separate language setting. English remains the fallback when a translated message is unavailable.

This source distribution contains English catalogs only. Enabling localization does not add translations into other languages.

## Catalogs

| File | Content |
| --- | --- |
| `package.nls.json` | English command titles, settings text, welcome content, and walkthrough text contributed through `package.json` |
| `package.nls.<locale>.json` | Translations for those manifest keys |
| `l10n/bundle.l10n.json` | English messages extracted from extension and webview localization calls |
| `l10n/bundle.l10n.<locale>.json` | Translations for runtime messages, keyed by the original English message |

The manifest declares `"l10n": "./l10n"`. Both sets of catalogs are included by the publish allowlist and the maintained source exporter.

## Add a language

1. Run `npm run l10n:extract` to refresh the English runtime catalog.
2. Copy `package.nls.json` to `package.nls.<locale>.json` and `l10n/bundle.l10n.json` to `l10n/bundle.l10n.<locale>.json`. Use the VS Code locale, such as `th` or `pt-br`.
3. Translate values while preserving keys. Keep numbered placeholders such as `{0}` and `{1}` intact; their order may change to suit the language. Preserve Markdown link destinations, command identifiers, code syntax, and product names.
4. Run `npm run l10n:check`. It checks catalog consistency and placeholder preservation.
5. Review the extension with that VS Code display language, including keyboard navigation, long labels, narrow panels, and right-to-left layout when applicable.

Missing entries fall back to English. Catalog changes take effect when VS Code reloads the extension.

## Write localizable UI text

Use `vscode.l10n.t` for extension-host messages and the webview's shared `localize` function for webview labels. Pass a literal English message with numbered placeholders and separate substitution arguments. Translate complete sentences rather than concatenating translated fragments. Reuse an existing message when its meaning is identical.

Static manifest text uses `%key%` references with matching entries in `package.nls.json`. Keep setting names, enum values, command identifiers, pipeline identifiers, and other machine-readable data unchanged.

Localization applies to interface text. It does not translate user prompts, agent output, custom pipeline content, model identifiers, source code, or diagnostics supplied by external tools. Date formatting follows the interface locale; localization does not change the existing hover-only presentation of timestamps.

Walkthrough Markdown documents remain English source content. Their manifest titles and descriptions are localizable through `package.nls.json`.

## Scope and verification

The catalogs cover the primary webview screens, editor, run recovery controls, accessibility labels, and native commands and settings. Domain-generated workflow descriptions, report prose, and diagnostics that are not marked at their source remain English. Built-in pipeline instructions and walkthrough Markdown are also unchanged.

Validation covers English fallback, reordered placeholders, malformed catalogs, safely embedded translation data, translated controls with stable action dispatch, and locale-specific dates and numbers. A synthetic translated bundle is used for these checks; it is not a shipped language pack. Live VS Code layout with longer translations and right-to-left languages remains unverified.

References: [VS Code localization tooling](https://github.com/microsoft/vscode-l10n) and [VS Code localization API](https://code.visualstudio.com/api/references/vscode-api#l10n).
