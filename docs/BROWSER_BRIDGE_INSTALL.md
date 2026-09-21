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

1. In Bachata run settings choose **Discover**. The local bridge starts and shows a pairing code.
2. Copy the code. Open the Bridge popup. Choose **Paste & connect**. Port routes automatically; no URL paste.
3. Open the provider conversation you want to use and sign in.
4. Refresh the popup tab list until the conversation reports ready.
5. Bind one ready conversation per browser role.

## Compatibility

The Bridge and the extension agree on one browser protocol version. A mismatch is refused, not degraded. Upgrade both together.

Provider websites change without notice. A working Bridge build is evidence for the exact provider build tested on the date recorded in `docs/COMPATIBILITY_MATRIX.md`, and for nothing else.

## Recovering a created chat

For ChatGPT and Claude tabs that Bachata creates, the Bridge remembers the stable conversation URL as soon as the submitted request passes its initial navigation checks. It keeps at most 50 such records. Closing the tab or timing out before the final reply does not remove an already saved record. A selected or discovered tab does not enter this catalogue.

Controllers can list these records and reopen an explicitly selected record ID with `listRecoverableConversations()` and `reopenConversation(registryId, provider)`. This uses a matching inactive tab or creates a new inactive tab and verifies the conversation. The recovery API does not send a prompt. The VS Code runtime also persists an active agent's promoted exact binding before the final response, so existing binding-based reopening can use it after restart. These APIs are available on the direct server, recovery wrapper, and shared controller transport; there is no new chat-picker UI in this change.

Recovery requires matching Bridge and extension builds, a valid retained URL, and a signed-in, ready provider page. It does not restore the previous window layout or recover a missing response into Bachata, and it does not confirm that a timed-out request stopped. A restart before the trusted route transition cannot recover an unpromoted tab.
