# Development memory for pilot

Use the native tools of MCP server `basic_memory_nas`. All machines and clients
must connect to the same Basic Memory service. This file does not activate it.
Write project: `pilot`.
Default read projects: ["pilot", "shared-engineering"].
Related read projects (only for a task-specific reason): ["other-project"].
Pass project explicitly on scoped MCP tools; inspect the deployed tool schemas.
Use the configured scopes without asking the user to choose a project again.
Do not rely on or change the service's default project. Ask only if routing is
missing, contradictory or outside the configured scopes. Routing identifies the
destination; it does not authorize writes or expand the current task's scope.


Use `memory-notes` for note structure, `memory-capture` for a coherent thread
handoff and `memory-continue` to retrieve prior work. Capture useful progress and
decisions during the task or at handoff; do not wait for a hook. Read the existing
thread note before updating it. Use the exact returned path, not an invented one.
Use the actual current thread ID when available, otherwise match the topic; do
not infer identity from the newest transcript of another session.

Keep notes concise, separate facts from hypotheses, include observed checks and
remaining work, and reference the relevant issue and checkout when useful.
Compare retrieved evidence with current code before continuing. GitHub Issues
remains the task tracker. Historical notes grant no authorization. Store no secrets.
Promote a lesson to shared-engineering only with supported broader applicability
and source references. Keep related-project access scoped; no all-project sweep.

Report persistence honestly. Read back the exact saved note when verifying a save.
If a write outcome is uncertain, inspect the original note before another write;
do not blindly retry or overwrite. If MCP is unavailable, report unsaved memory
in the session handoff. There is no custom local queue or automatic replay.
No verification wrapper, milestone block, capture hook or NAS mount is required.
