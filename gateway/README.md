# @praetorian/capability-gateway

A **harness-agnostic MCP capability gateway**. It serves a catalog of *skills*
(prose guidance) and *tools* (executable wrappers) to any MCP client over stdio,
exposing a small, fixed surface so a client can discover and invoke capabilities
at runtime without bundling them. No Claude-specific primitives — any MCP host
works.

## The 4 tools

| Tool                  | Input            | Returns                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `search_capabilities` | `{query, k?=10}` | Tiny rows `{id, kind, name, description}` (k capped at 25)               |
| `get_schema`          | `{id}`           | skill → `{description, references}`; tool → `{inputSchema, outputSchema, auth}` |
| `resolve_skill`       | `{id}`           | `{markdown, references}` — the full `SKILL.md` body                     |
| `execute`             | `{id, args}`     | The tool's validated output                                             |

## Discovery → invocation loop

```
search_capabilities("yagni")        → find the adhering-to-yagni skill
  ├─ get_schema(id)                 → its description + reference list
  └─ resolve_skill(id)              → the full SKILL.md to read

search_capabilities("echo")         → find the echo tool
  ├─ get_schema(id)                 → its input/output JSON Schema + auth
  └─ execute(id, {text:"hi"})       → run it → {text:"hi"}
```

`get_schema` and the index read only static files (`SKILL.md` frontmatter,
`manifest.json`) — **only `execute` lazily imports the one wrapper module it
needs**, so startup and discovery stay fast. A startup drift guard refuses to
boot if a manifest's stored schema hash disagrees with its live wrapper Zod.

## Install / run

```bash
npx @praetorian/capability-gateway              # uses ./gateway.config.yaml
# or, after `npm run build`:
node dist/index.js [path/to/gateway.config.yaml]
```

Point it at a catalog via `gateway.config.yaml`:

```yaml
catalog:
  root: ./.agentsmesh   # expects skills/ and tools/ under here
search:
  ranker: keyword       # keyword (P0) | semantic | hybrid (P1)
secrets:
  provider: env         # env (P0) | 1password (P1)
```

A catalog is a directory with `skills/<name>/SKILL.md` and
`tools/<service>/manifest.json` (generated from a `wrapper.ts` via
`npm run generate-manifest <service-dir>`). All logs go to **stderr**; stdout is
reserved for MCP framing.

## P1 next

P0 ships the universal core with no sandbox. P1 adds: a `run_code` tool running
wrapper handlers inside an `isolated-vm` sandbox with deny-by-default egress, a
1Password `SecretProvider` alongside the env one, and semantic + hybrid ranker
modes (the same Orama engine that backs keyword today).
