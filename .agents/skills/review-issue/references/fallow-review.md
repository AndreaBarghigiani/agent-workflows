# Advisory Fallow review

Use the consumer's configured/pinned Fallow command first, or an already installed local CLI. Do not download a latest version during review. If no installation exists, state that Fallow was unavailable and continue the ordinary review.

Inspect the installed version and relevant `--help` output before selecting flags. Prefer changed files/workspaces or the relevant issue scope. Choose the analysis that resolves the risk: unused exports/dependencies, duplication, complexity, or configured boundaries. JSON output can help inspect results if the installed version supports it.

Capture stdout, stderr, and the actual exit status separately. Interpret statuses using that version's documentation. Findings and runtime failures are different; never append blanket `|| true` or discard stderr to make a failed invocation appear successful.

Confirm candidate findings against consumers, export maps, framework entrypoints, generated inputs, and dynamic loading. Report actionable findings with paths, reasoning, and any uncertainty. Do not use `fix`, change thresholds, alter suppressions, or delete code in a review-only assignment.

