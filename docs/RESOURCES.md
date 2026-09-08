# Repository resource registry

`.bachata/resources.json` states which external resources this repository actually provides.
A pipeline declares what it needs; this file declares what exists; Bachata compares the two
before a run starts.

Bachata never asks a provider what it has installed. A provider reporting a name is not proof
that the named thing is the one a workflow declared, and a resource that cannot be pinned
cannot be reproduced. The registry is human-owned for the same reason `.bachata/verifiers.json`
is: the repository, not a model, states what may be relied on.

## Shape

```json
{
  "version": 1,
  "resources": [
    {
      "id": "docs",
      "kind": "mcpServer",
      "name": "docs-server",
      "version": "2.0.0",
      "configurationDigest": "sha256-…",
      "note": "internal docs MCP server"
    }
  ]
}
```

`id` matches the `id` of a pipeline's declared dependency, and `kind` and `name` must match
that dependency too: an id alone is not identity, because a pipeline could keep the id and
change what it is asking for. `version` and `configurationDigest` are optional; when a
pipeline declares either one, the registry must supply a matching value or the run is refused.

A registry this file cannot parse is not the same as an absent one. A repository that tried
to declare its resources and got it wrong refuses every run that declares a dependency,
required or optional, rather than behaving as though it had declared nothing.

No secret ever belongs here. Credentials stay with the provider and its environment.

## What a run does with it

Before any provider starts, Bachata reads this file and compares it to the pipeline's
`resourceDependencies`:

- a **required** dependency that is not declared here refuses the run;
- a **required** dependency whose declared version or configuration does not match refuses;
- a **required** dependency declaring an exact version or configuration that the registry
  does not state refuses, because Bachata cannot confirm the resource that answered;
- an **optional** dependency reports the gap and does not refuse;
- a required dependency bound to roles that never run in the workflow refuses;
- a registry that cannot be parsed refuses, whatever the dependency's requiredness.

What answered is recorded with the run as `resourceDependencies.observed`, marking each
dependency reproducible or not. A resource that is present but unpinned is usable and is
never recorded as reproducible.

A pipeline that declares no dependencies is unaffected, and provider-native resources a
model happens to inherit keep working. They are simply not declared, and Bachata never reports
them as reproducible.
