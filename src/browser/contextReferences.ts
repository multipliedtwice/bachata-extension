import { randomUUID } from "node:crypto";
import type { BrowserControlReferences } from "./controlProtocol";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Bounded per-turn references. Digests remain host-side for the existing mutation checks. */
export class BrowserContextReferences implements BrowserControlReferences {
  constructor(private readonly workspaceRoot = "") {}

  private readonly scope = randomUUID();
  private readonly objects = new Map<string, { kind: string; value: string }>();
  private readonly versions = new Map<string, { path: string; digest: string; scope: string }>();
  private readonly snippets = new Map<string, string>();
  static readonly maximumEntries = 2048;

  fileVersion(path: string, digest: string, scope = "file"): string {
    for (const [reference, entry] of this.versions) {
      if (entry.path === path && entry.digest === digest && entry.scope === scope) return reference;
    }
    if (this.versions.size >= BrowserContextReferences.maximumEntries) {
      throw new Error("Browser context file-version limit reached; start a fresh managed turn.");
    }
    const reference = `file-version-${this.scope}-${String(this.versions.size + 1)}`;
    this.versions.set(reference, { path, digest, scope });
    return reference;
  }

  objectReference(kind: string, value: string): string {
    for (const [reference, entry] of this.objects) if (entry.kind === kind && entry.value === value) return reference;
    if (this.objects.size >= BrowserContextReferences.maximumEntries) throw new Error("Browser object-reference limit reached");
    const reference = `${kind}-${this.scope}-${String(this.objects.size + 1)}`;
    this.objects.set(reference, { kind, value });
    return reference;
  }

  objectValue(kind: string, reference: string): string | undefined {
    const entry = this.objects.get(reference);
    return entry?.kind === kind ? entry.value : undefined;
  }

  knownFileDigests(): Map<string, string> {
    const result = new Map<string, string>();
    for (const entry of this.versions.values()) {
      if (entry.scope === "file") result.set(entry.path, entry.digest);
    }
    return result;
  }

  fileDigest(path: string, reference: string): string | undefined {
    const entry = this.versions.get(reference);
    return entry?.path === path && entry.scope === "file" ? entry.digest : undefined;
  }

  snippetId(reference: string): string | undefined { return this.snippets.get(reference); }

  private snippetReference(id: string): string {
    for (const [reference, original] of this.snippets) if (original === id) return reference;
    if (this.snippets.size >= BrowserContextReferences.maximumEntries) throw new Error("Browser context snippet limit reached; start a fresh managed turn.");
    const reference = `snippet-${this.scope}-${String(this.snippets.size + 1)}`;
    this.snippets.set(reference, id);
    return reference;
  }

  render(value: unknown): string {
    return JSON.stringify(value, (key: string, item: unknown): unknown => {
      if (["workspaceFingerprint", "taskHash", "repositoryBaseline", "baseHead", "head", "fingerprint"].includes(key)) return undefined;
      if (key === "worktreePath" || key === "workspaceRoot" || key === "workingDirectory") return ".";
      if ((key === "taskId" || key === "actionId" || key === "requestId") && typeof item === "string") return this.objectReference(key, item);
      if (key === "omittedSnippetIds" && Array.isArray(item)) return item.map((id) => typeof id === "string" ? this.snippetReference(id) : id);
      if (key === "id" && typeof item === "string" && [...this.snippets.values()].includes(item)) return this.snippetReference(item);
      if (typeof item === "string" && this.workspaceRoot && ["error", "stderr", "summary"].includes(key)) {
        return item.split(this.workspaceRoot).join(".");
      }
      const object = record(item);
      if (!object || typeof object.path !== "string" || typeof object.sha256 !== "string") return item;
      const { sha256, hashScope, id, fileVersion: _fileVersion, ...rest } = object;
      const scope = typeof hashScope === "string" ? hashScope : "file";
      const fileVersion = this.fileVersion(object.path, sha256, scope);
      const snippetReference = typeof id === "string" ? this.snippetReference(id) : undefined;
      return { ...rest, ...(snippetReference ? { id: snippetReference } : {}), fileVersion, versionScope: scope };
    }, 2);
  }
}
