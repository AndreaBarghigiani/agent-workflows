# Consumer lint and formatting checks

The consumer owns its tooling and required checks. These workflows support any
configured tools, including ESLint/Prettier, Biome, Oxlint/Oxfmt, and tools for
other languages. They do not prescribe a package manager, script name, working
directory, or new tool.

## Declare checks where project rules already live

Use the consumer's existing root or path-specific `AGENTS.md` and engineering
documentation to identify required lint and format validation, formatting writes,
and their execution context and scope. Reference existing task definitions and
tooling configuration rather than copying flags, file patterns, or tool settings.
If commands are already documented, link that section. No new manifest, local
tracker, or duplicated tool configuration is needed.

A declaration can say: “Required lint and read-only format validation are the
commands in our engineering guide's Checks section. Run them in the documented
context and scope using the existing task definitions and tool configuration.
Apply the documented formatter to assigned changes before validation.” The linked
section must resolve to executable commands, not just tool names. Consumers can
also explicitly state that no lint or format tool is configured for a scope.

## Discover and pass the applicable commands

Read consumer instructions, relevant project documentation, and tooling
configuration for the affected paths. Inspect existing scripts, task definitions,
config files, and locally available tool documentation as needed to resolve the
actual invocations. Include path-specific rules, exclusions, and required
whole-project checks. A configured tool is not evidence that it ran; an absent
package script is not evidence that no tool is configured.

Resolve conflicting declarations or unknown invocations rather than guessing a
pass, inventing script names, installing tools, or weakening required scope.
Coordinators pass exact commands, working directory or other execution context,
required scope, and source references to both roles. Implementation receives the
formatting command and validation commands; review receives read-only validation
commands and the revision to check. Combined lint/format commands are acceptable
when they cover the required checks without writes during review.

Implementers format assigned changes and pass configured lint/format validation
before verified handoff. Reviewers independently execute applicable validation on
the reviewed revision without autofixes, formatting writes, or installations.
Read-only here means validation must not rewrite source, configuration, or the
reviewed diff. Resolve supported check-only modes from existing tooling guidance;
if no read-only mode is available, report that limitation. Advisory analysis stays
advisory unless consumer rules make it mandatory.

## Evidence and approval

Record evidence in the existing implementation/review handoff and authorized
issue record, not a separate tracker. For each check, report:

- Exact command and execution context, checked revision (including any uncommitted
  diff), and file/workspace/project scope.
- Actual result and exit status, or skipped/unavailable status with its reason.
- Whether the check is required, and any missing verification.

Distinguish “no tool configured for this scope” (supported by inspected sources)
from “configured but not run” (with the reason, such as missing dependencies,
unavailable execution environment, or an unknown safe command). Neither is a
successful execution. If no tool is configured and none is required, report that
fact without adding one; follow documented style. If project rules require a check
whose configuration or command is missing, report a mandatory verification gap.
Failed or unperformed mandatory checks prevent verified approval, closure
readiness, and a verified issue outcome comment. Unrelated existing failures
still require disclosure and do not authorize broad cleanup or a claimed pass.

Reuse a role's valid evidence when the relevant revision, checked scope, tool
configuration, dependencies, and other verification inputs are unchanged. An
implementer's run never substitutes for the reviewer's independent run. Once
both have run, a coordinator need not repeat them just to hand off. Changes to
reviewed code or relevant verification inputs require affected checks and review
again; unchanged evidence can be retained. Follow stricter consumer rerun rules.
