import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { prismComponents } from "./assets";

const nonce = (): string => randomBytes(24).toString("base64");


export const getWebviewHtml = (
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string => {
  const assetUri = (...segments: string[]): string =>
    webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...segments))
      .toString();
  const behaviorScriptUri = assetUri("webview-behavior.js");
  const scriptUri = assetUri("webview.js");
  const styleUri = assetUri("webview.css");
  const codiconStyleUri = assetUri("vendor", "codicons", "codicon.css");
  const scriptNonce = nonce();
  const prismScripts = [
    assetUri("vendor", "prism", "prism.js"),
    ...prismComponents.map((component) =>
      assetUri("vendor", "prism", "components", `prism-${component}.js`),
    ),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';">
  <link rel="stylesheet" href="${codiconStyleUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Bachata</title>
</head>
<body>
  <div id="bachata-live-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  <div id="root"></div>
  ${prismScripts.map((uri) => `<script nonce="${scriptNonce}" src="${uri}"></script>`).join("\n  ")}
  <script nonce="${scriptNonce}" src="${behaviorScriptUri}"></script>
  <script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
};
