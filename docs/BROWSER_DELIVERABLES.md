# Browser deliverables

The extension inspects returned source deliverables before allowing them to change the workspace. The browser participant remains subject to Bachata's role assignment, mutation approval, write scope, shared workspace coordination, and verification policy.

Supported inputs are UTF-8 unified patches, clearly introduced inline diff blocks, source blocks labeled with workspace-relative filenames, downloadable source files whose destination is unambiguous, and ZIP archives containing source files or unified patches. A ZIP may contain only changed files or a complete source project. A single enclosing project directory is removed only when workspace directory evidence resolves it unambiguously.

Archive files are inspected in memory. They are never extracted directly into the workspace. Unchanged files are ignored; missing files are preserved. Deletion must be explicit in a validated patch. Generated output, dependency trees, lockfiles, packaged artifacts, and archive metadata do not become workspace changes. Restricted files cause refusal. Archive executable flags never grant a new executable permission.

An existing file can change only when the extension has issued a complete-file version reference during the current browser turn and the file still has that version. The extension checks this again before publication. A missing or stale version results in a request to the browser participant to read current source and regenerate its deliverable. Internal file digests are never requested from the browser. Opaque references are scoped to one managed turn; a conversation rollover issues fresh references. Optional browser Lead reviews receive both the review verdict contract and any permitted workspace protocol. Stale or unissued candidate references cannot approve a run.

Workspaces without Git use bounded local source tracking for candidate validation. The controller refuses a baseline that exceeds its inspection budget rather than treating an uninspected workspace as unchanged. These local identities do not enter browser prompts.

All prepared file replacements become one bounded patch and pass through the existing patch executor. The executor validates every target before publishing, preserves independent edits, and rolls back earlier publications if a later publication fails. If rollback cannot be verified, orchestration stops. Successful managed mutations invalidate previous verification and advance the workspace revision.

A malformed download, unsupported archive, ambiguous root, conflicting representations, invalid filename, link, corrupt entry, or size violation produces a correction request to the browser participant. A prose completion claim cannot resolve an unapplied deliverable. At most two correction requests are permitted, within the existing action-round and turn deadlines. Exhaustion is an explicit failure, not a successful run.

Limits per response:

| Boundary | Limit |
| --- | ---: |
| Downloadable assets | 8 |
| Total downloaded bytes | 32 MiB |
| Archive entries | 4,096 |
| Expanded archive bytes | 64 MiB |
| Individual file bytes | 4 MiB |
| Changed files | 512 |
| Prepared patch bytes | 8 MiB |
| Relative path length | 512 characters |
| Download and inspection deadline | 60 seconds |

Paths must be portable relative paths. Absolute paths, traversal components, Windows device names, duplicate names, case collisions, symbolic links, special files, and encrypted ZIP entries are rejected. Supported ZIP compression methods are stored and deflate. ZIP integrity and transfer integrity are checked independently.

Binary source replacements, non-UTF-8 files, archives other than ZIP, nested archives, ambiguous standalone filenames, and arbitrary prose are not interpreted as executable writes. The participant must return a supported representation or report the unresolved requirement. Provider images and non-source documents remain ordinary captured assets with the existing Save and Reveal actions.

This implementation uses the existing Browser Bridge asset-transfer protocol. It grants the browser no filesystem access and does not change its image-only outgoing attachment schema. A link that was not captured as a downloadable asset prompts a correction request instead of being fetched through a separate URL downloader.
