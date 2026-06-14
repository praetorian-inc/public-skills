# @praetorian/capability-gateway

A **harness-agnostic MCP capability gateway**. It serves a catalog of *skills*
(prose guidance) and *tools* (executable wrappers) to any MCP client over stdio,
exposing a small, fixed surface so a client can discover and invoke capabilities
at runtime without bundling them. No Claude-specific primitives — any MCP host
works (Cursor, Codex CLI, Gemini CLI, Goose, Claude Code, …).

The published package **bundles the Praetorian catalog**, so `npx
@praetorian/capability-gateway` works out of the box with no configuration.

## The 5 meta-tools

| Tool                  | Input                  | Returns                                                                          |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `search_capabilities` | `{query, k?=10}`       | Tiny rows `{id, kind, name, description}` (k capped at 25)                        |
| `get_schema`          | `{id}`                 | skill → `{description, references}`; tool → `{inputSchema, outputSchema, auth}`   |
| `resolve_skill`       | `{id}`                 | `{markdown, references}` — the full `SKILL.md` body                              |
| `execute`             | `{id, args}`           | The tool's validated output                                                      |
| `run_code`            | `{source}`             | Runs model code in an `isolated-vm` sandbox, composing capability calls via a frozen `caps.<service>.<tool>(args)` bridge with deny-by-default egress |

## Discovery → invocation loop

```
search_capabilities("yagni")        → find the adhering-to-yagni skill
  ├─ get_schema(id)                 → its description + reference list
  └─ resolve_skill(id)              → the full SKILL.md to read

search_capabilities("linear")       → find the linear.list_issues tool
  ├─ get_schema(id)                 → its input/output JSON Schema + auth
  └─ execute(id, {...})             → run it → validated output

run_code("(() => caps.linear.list_issues({ first: 5 }))()")
                                    → compose tool calls in a sandbox
```

`get_schema` and the index read only static files (`SKILL.md` frontmatter,
`manifest.json`) — **only `execute`/`run_code` lazily import the one wrapper
module they need**, so startup and discovery stay fast. A startup drift guard
refuses to boot if a manifest's stored schema hash disagrees with its live
wrapper Zod.

## Install / run

```bash
# Works out of the box — serves the bundled Praetorian catalog, no config needed:
npx -y @praetorian/capability-gateway

# Or, after `npm install` + `npm run build`:
node dist/index.js                          # bundled catalog (no config file)
node dist/index.js path/to/gateway.config.yaml   # your own catalog
```

When you give **no** config path and there is **no** `./gateway.config.yaml` in
the working directory, the gateway falls back to the catalog bundled inside the
package (resolved relative to the package, not the working directory). Provide a
config file (or a `GATEWAY_CONFIG` env var / first CLI arg) to point it at your
own catalog instead.

### Pointing at a custom catalog

```yaml
# gateway.config.yaml
catalog:
  root: ./.agentsmesh   # expects skills/ and tools/ under here
search:
  ranker: keyword       # keyword | semantic | hybrid
secrets:
  provider: env         # env | 1password
```

A catalog is a directory with `skills/<name>/SKILL.md` and
`tools/<service>/manifest.json` (generated from a `wrapper.ts` via
`npm run generate-manifest <service-dir>`). All logs go to **stderr**; stdout is
reserved for MCP framing.

## MCP host wiring

Every host runs the gateway as a **stdio MCP server** with the same command:
`npx -y @praetorian/capability-gateway`. With no extra argument it serves the
bundled catalog; append a path to `gateway.config.yaml` to serve your own.
(Config file names/keys below were verified against each host's current docs —
see the links.)

### Claude Code

Add a stdio server to `.mcp.json` (project) or `~/.claude.json` (user):

```json
{
  "mcpServers": {
    "capability-gateway": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@praetorian/capability-gateway"]
    }
  }
}
```

Or via the CLI:

```bash
claude mcp add --transport stdio capability-gateway -- npx -y @praetorian/capability-gateway
```

Docs: <https://code.claude.com/docs/en/mcp>

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "capability-gateway": {
      "command": "npx",
      "args": ["-y", "@praetorian/capability-gateway"]
    }
  }
}
```

Docs: <https://cursor.com/docs/context/mcp>

### Codex CLI

Add a `[mcp_servers.<name>]` table to `~/.codex/config.toml` (or a
project-scoped `.codex/config.toml`):

```toml
[mcp_servers.capability-gateway]
command = "npx"
args = ["-y", "@praetorian/capability-gateway"]
```

Or via the CLI:

```bash
codex mcp add capability-gateway -- npx -y @praetorian/capability-gateway
```

Docs: <https://developers.openai.com/codex/mcp>

### Gemini CLI

Add to `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project):

```json
{
  "mcpServers": {
    "capability-gateway": {
      "command": "npx",
      "args": ["-y", "@praetorian/capability-gateway"]
    }
  }
}
```

Docs: <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>

### Goose

Add a stdio extension to `~/.config/goose/config.yaml` (then restart Goose):

```yaml
extensions:
  capability-gateway:
    type: stdio
    cmd: npx
    args: ["-y", "@praetorian/capability-gateway"]
    enabled: true
    envs: {}
    timeout: 300
```

You can also run `goose configure` → *Add Extension* → *Command-line Extension*
and enter `npx -y @praetorian/capability-gateway`.

Docs: <https://block.github.io/goose/docs/guides/config-file/>

## Native dependency (`isolated-vm`) and the `--no-node-snapshot` re-exec

`run_code` runs model-generated code inside an [`isolated-vm`][ivm] V8 isolate.
That is the **only** feature that needs the native module — `search_capabilities`,
`get_schema`, `resolve_skill`, and `execute` work without it.

### Optional native build, graceful degradation

`isolated-vm` is declared as an **`optionalDependency`** and is **lazy-imported**
only on the first `run_code` call. This means:

- On a supported platform, `npm install` fetches a **prebuilt binary** (no
  compiler needed) — fast, no toolchain.
- If no prebuilt matches your platform/Node ABI, npm falls back to building from
  source via **`node-gyp`**, which needs **Python 3 + a C/C++ toolchain** (e.g.
  Xcode CLT on macOS, `build-essential` on Debian/Ubuntu, MSVC Build Tools on
  Windows).
- If the optional build **fails or is skipped**, `npm install` still succeeds and
  the gateway still boots: the other four meta-tools work normally, and only
  `run_code` returns a clean coded error (`config_invalid` / `sandbox_*`) when
  invoked.

If you never call `run_code`, you can ignore the native dependency entirely.

### `--no-node-snapshot` self-re-exec

`isolated-vm` requires the Node process to be launched with `--no-node-snapshot`
(Node ≥ 20). The published `bin` is invoked as plain `node dist/index.js`, so it
**re-execs itself once** with that flag the first time it starts (`stdio:
"inherit"`, so the MCP stdio framing is unaffected and the re-exec is invisible
to the host). You do not need to pass any flag.

- Escape hatch: set `GATEWAY_NO_REEXEC=1` to disable the re-exec (e.g. when you
  already pass `--no-node-snapshot` yourself via `NODE_OPTIONS`).
- The `dev`/`test` scripts already pass the flag, so they skip the re-exec.

This behaviour is proven end-to-end by `test/js-wrapper-stdio.integration.test.ts`,
which boots the compiled bin **without** the flag and confirms `run_code` works.

### `@xenova/transformers` (also optional)

A second optional dependency, `@xenova/transformers`, is used **only** when
`search.embedding.backend: local` is configured (offline embeddings for the
`semantic`/`hybrid` rankers). The default `keyword`/`api` paths never load it.

## Catalog & licence

- **Bundled catalog:** the published package ships the Praetorian skills + tools
  catalog under `dist/bundled-catalog/` (compiled `.js` wrappers only — bare Node
  serves them with no TypeScript loader). Point at your own catalog with a config
  file to override.
- **Licence:** Apache-2.0 (see `LICENSE`).

[ivm]: https://github.com/laverdet/isolated-vm
