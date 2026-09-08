import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultWorktreeLockPath, recoverWorktreeLock } from "./lib/worktreeLock.mjs";

const args = process.argv.slice(2);
const confirmUnreadable = args.includes("--unreadable");
const [token] = args.filter((value) => value !== "--unreadable");
const lockPath = defaultWorktreeLockPath();
const relative = path.relative(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  lockPath,
);

if (!token && !confirmUnreadable) {
  console.error(
    [
      "Usage: npm run worktree:unlock -- LOCK_TOKEN, replacing LOCK_TOKEN with the token itself.",
      "",
      `The token is the "token" field of ${relative}. Read it, confirm that nothing the run that`,
      "wrote it started is still working in this worktree — its compilers, test runners and any",
      "other descendants — and then pass it here.",
      "",
      `If ${relative} cannot be read at all — it is truncated, empty, or not JSON — there is no`,
      "token to quote back. Confirm the same thing about the run that wrote it, then run:",
      "",
      "  npm run worktree:unlock -- --unreadable",
      "",
      "Bachata never clears this lock on its own: a dead wrapper process is no proof that the work",
      "it started has stopped.",
    ].join("\n"),
  );
  process.exit(1);
}

const outcome = await recoverWorktreeLock({
  lockPath,
  ...(token === undefined ? {} : { expectedToken: token }),
  confirmUnreadable,
});
if (!outcome.removed) {
  console.error(`The worktree lock was not removed: ${outcome.reason}.`);
  process.exit(1);
}
console.log(`Removed ${relative}. This worktree is free for the next run.`);
