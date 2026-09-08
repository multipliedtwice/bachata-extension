# Browser Bridge install

The Browser Bridge is a separate browser extension. Browser providers (ChatGPT, Claude, Generic) do not work without it. Codex app server and Claude Code do not need it.

## Requirements

- A local VS Code window. Remote SSH, WSL, and Codespaces cannot reach a local browser.
- Chrome or Edge, Manifest V3, current stable channel.
- The Bridge build whose protocol version matches this extension. See `docs/COMPATIBILITY_MATRIX.md`.

## Acquisition

Official releases: https://github.com/multipliedtwice/bachata-browser-bridge/releases

Install only a published release with its ZIP and checksum. An empty release page means
no official download is available yet.

The download is a ZIP containing the unpacked extension. Packaging does not put a checksum
file inside that ZIP. Compute its SHA-256 and compare it with the checksum published beside
the official release before loading it:

```text
shasum -a 256 bachata-browser-bridge-<version>.zip
```

Do not install a Bridge build from any other source. The Bridge holds a pairing token for a local WebSocket endpoint that can drive provider conversations.

## Install

1. Unzip the verified archive to a stable local directory. Chrome loads unpacked extensions from disk on every start.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped directory.
5. Confirm the extension version and the protocol version in the popup.

## Pair

1. In Bachata run settings choose **Discover**. The local bridge starts and shows an endpoint and a pairing token.
2. Open the Bridge popup, paste the endpoint and token, and pair.
3. Open the provider conversation you want to use and sign in.
4. Refresh the popup tab list until the conversation reports ready.
5. Bind one ready conversation per browser role.

## Compatibility

The Bridge and the extension agree on one browser protocol version. A mismatch is refused, not degraded. Upgrade both together.

Provider websites change without notice. A working Bridge build is evidence for the exact provider build tested on the date recorded in `docs/COMPATIBILITY_MATRIX.md`, and for nothing else.
