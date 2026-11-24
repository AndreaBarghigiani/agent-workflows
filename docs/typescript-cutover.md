# TypeScript cutover migration

The v0.6.0 release switches the shipped toolkit from Python scripts to a single TypeScript entry
point. This note covers what changes for consumers and how to roll back.

## What changes

**Node.js 22.18+ is now required.** The toolkit no longer runs under
`python3`; every helper runs under Node 22.18 or newer (the floor set by the
erasable-TypeScript support the entry point uses). Consumers already have
Node through Claude Code, Codex, or OpenCode.

**One entry point replaces the scripts.** Each former script is now a
subcommand of `bin/agent-workflows.ts` inside the pinned library:

| Before | After |
| --- | --- |
| `python3 .agent-workflows/scripts/install.py --project .` | `node .agent-workflows/bin/agent-workflows.ts install --project .` |
| `python3 .agent-workflows/scripts/setup_memory.py --project .` | `node .agent-workflows/bin/agent-workflows.ts setup_memory --project .` |
| `python3 .agent-workflows/scripts/setup_memory_connections.py --project .` | `node .agent-workflows/bin/agent-workflows.ts setup_memory_connections --project .` |
| `python3 .agent-workflows/scripts/memory_preflight.py --project .` | `node .agent-workflows/bin/agent-workflows.ts memory_preflight --project .` |
| `python3 .agent-workflows/scripts/adopt_skills.py --project .` | `node .agent-workflows/bin/agent-workflows.ts adopt_skills --project .` |
| `python3 .agent-workflows/scripts/mcp_configure.py ...` | `node .agent-workflows/bin/agent-workflows.ts mcp_configure ...` |
| `python3 .agent-workflows/scripts/t3_readiness.py --project .` | `node .agent-workflows/bin/agent-workflows.ts t3_readiness --project .` |
| `python3 .agent-workflows/scripts/t3_bootstrap.py ...` | `node .agent-workflows/bin/agent-workflows.ts t3_bootstrap ...` |

Options and output are unchanged apart from the program name in help text.
Repair hints printed by `--check` diagnostics now name this entry point
(`node <library>/bin/agent-workflows.ts <subcommand>`) instead of the old
`python3 <library>/scripts/<script>.py` form. Every subcommand also accepts
`--json`, which wraps the same run's output in a machine-readable
`{"ok", "exit", "stdout", "stderr"}` document.

## T3 bootstrap rename and action update

The generated consumer bootstrap changes name:

- **Generated file:** `.agent-workflows-t3.py` becomes
  `.agent-workflows-t3.mjs`.
- **Action command:** `python3 .agent-workflows-t3.py` becomes
  `node .agent-workflows-t3.mjs`.

Regenerate both by running the pinned readiness helper after updating the
pin:

```sh
node .agent-workflows/bin/agent-workflows.ts t3_readiness --project . --configure-action
```

The explicit migration error is what `t3_readiness --check` (and
`--prepare`) prints: a checkout that still carries the old
`.agent-workflows-t3.py` launcher fails with `Generated bootstrap
.agent-workflows-t3.py needs migration to .agent-workflows-t3.mjs`, and a
pin that ships only `t3_readiness.py` / `t3_bootstrap.py` fails with
`Pinned <name>.py needs migration`. The old launcher is not executed, and
the library never deletes Python-era files — removing the stale
`.agent-workflows-t3.py` stays the owner's call.

## Rolling back

If the cutover breaks a consumer, pin the library back to the last commit
that still ships Python tooling:

```text
4e345fc5730e76096424f7e436092cf53a675a97
```

After re-pinning, restore the previous invocation form
(`python3 .agent-workflows/scripts/<script>.py ...`) and regenerate the T3
bootstrap with that pin's `t3_readiness.py` so the consumer returns to
`.agent-workflows-t3.py`.
