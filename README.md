# public-skills

Curated, portable [agentskills.io](https://agentskills.io) skills that Praetorian's AI
PR reviewers (Claude, Codex, Gemini) load during review. One canonical source,
materialized into each runtime's native skill directory by [agentmesh](https://www.npmjs.com/package/agentsmesh).

## Layout

```
.agentsmesh/skills/        ◀── CANONICAL SOURCE. Edit skills ONLY here.
  <skill-name>/SKILL.md
  <skill-name>/references/…

.claude/skills/            ── GENERATED, committed. Read by the Claude reviewer.
.gemini/skills/            ── GENERATED, committed. Read by the Gemini reviewer.
.agents/skills/            ── GENERATED, committed. Auto-scanned by `codex exec`.

agentsmesh.yaml            ── target + feature config
.github/workflows/ci.yml   ── drift gate: `agentsmesh generate --check`
```

The three `*/skills/` directories are **derived artifacts**. Never hand-edit them.
They are committed so consumers (the reviewer workflows) can `actions/checkout` this
repo at a pinned SHA and read the directory they need with **no build step** — agentmesh
never runs inside the hardened reviewer runner.

## Curated skills (review-relevant)

| Skill | Lens it applies during review |
|-------|-------------------------------|
| `analyzing-with-adversarial-pov`    | Adversarial review across 7 dimensions |
| `enforcing-evidence-based-analysis` | No claims without file:line evidence |
| `analyzing-cyclomatic-complexity`   | Complexity thresholds + refactoring patterns |
| `adhering-to-dry`                   | Duplication detection |
| `adhering-to-yagni`                 | Scope-creep / speculative-generality detection |
| `preferring-simple-solutions`       | Simplicity bias |

Source of truth for the skill bodies is `praetorian-inc/praetorian-core`
(`skills/<name>/`); the `metadata.source` / `metadata.source_sha` frontmatter in each
canonical SKILL.md records the upstream commit they were migrated from.

## Editing a skill

```bash
# 1. edit the canonical copy
$EDITOR .agentsmesh/skills/<name>/SKILL.md

# 2. regenerate the committed mirrors
npx -y agentsmesh@0.22.0 generate

# 3. confirm in sync, commit everything (canonical + generated)
npx -y agentsmesh@0.22.0 generate --check
git add -A && git commit
```

CI re-runs `generate --check` on every PR and **fails if the mirrors are stale or were
hand-edited**, so the canonical dir stays the single source of truth.

## How agentmesh transforms skills (expected, deterministic)

`generate` normalizes each skill to the target's native shape. Relative to canonical it:
- drops `allowed-tools` and the `metadata:` block from frontmatter (the reviewer's tool
  surface is governed by the workflow allowlist, not skill frontmatter — no functional loss);
- injects an empty `## Purpose` heading after the H1;
- rebases relative links `references/x.md` → `./references/x.md`;
- strips the trailing newline.

These are stable and link-safe (verified: zero broken links across all generated skills).
The drift gate guarantees they're reproducible.

## Consumers

Reviewer workflows in `praetorian-inc/public-workflows` check this repo out at a pinned
SHA into the runtime's skill path. Because we use plain repo-local skills (not
`plugins:`/`plugin_marketplaces:`), the consuming workflows get real SHA pinning and avoid
the claude-code-action plugin bugs (#1145 / #1087 / #1229) entirely.
