# Harness-owned workspaces and fresh checkout readiness

The harness owns workspace selection, worktree paths, creation, relocation and
cleanup. Follow the current session's workspace binding and preserve existing
work. Do not create a second checkout to correct a path or move a checkout behind
an active session. Consumer instructions still govern task scope, branch choices
and authorization.

## Fresh checkout readiness

These are separate steps with separate purposes:

1. Initialize the revisions already pinned by the consumer, including nested
   submodules when needed:

   ```bash
   git submodule update --init --recursive
   ```

   This checks out the consumer's recorded library revision; it does not upgrade
   the library pin.
2. Install the consumer's derived toolkit and optional profiles from its
   reviewed library revision using `scripts/install.ts`. Record the Basic
   Memory choice with `--memory enabled` or `--memory declined`. Use `--check`
   to inspect links and migration state without writing. The helper verifies
   a registered library submodule stays detached at the recorded pin and
   detaches a clean attached checkout in place; dirty or diverged submodule
   state stops the install for review.
3. Configure optional local routing separately when the consumer has enabled
   Basic Memory. Skill links do not create routing, and routing does not prove
   client discovery or service access.

Each checkout has its own links and local routing. A clean clone can initialize
the pin and repeat the consumer's selected setup; it should not copy credentials
or client-local configuration from another checkout.

The installer removes only the exact recognized legacy worktree policy block
from older versions. Customized, malformed or duplicate blocks require a
reviewed edit. Updating a submodule pin alone leaves an already embedded block
in the consumer's `AGENTS.md`; run the selected installation refresh to migrate
it. See [update-agent-workflows](../.agents/skills/update-agent-workflows/SKILL.md).
