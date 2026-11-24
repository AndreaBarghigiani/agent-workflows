# Tag annotations and GitHub Release publication

Use this reference for evidence collection and publication cases. Project-owned
release instructions and automation take precedence. This procedure never
authorizes a remote mutation by itself.

## Build an evidence-based tag annotation

1. Establish the exact candidate and release tip, then inspect commits and
   merged PRs in the verified range. Use the repository's configured GitHub
   integration and explicit repository where needed. Include links only for
   merged PRs supported by that range; do not infer PR links from unrelated
   history or include unmerged work.
2. Distinguish user-visible changes from release-metadata PRs (for example,
   the PR that only dates the changelog or bumps a version). Summarize the
   changes described by metadata separately, without counting the metadata PR
   as a product highlight.
3. Confirm the changelog entry/reference exists at the exact tagged release tip.
   Identify its path and version heading in the annotation.
4. Present a complete message, for example:

   ```text
   Release vX.Y.Z

   Highlights
   - User-visible change. (https://github.com/OWNER/REPO/pull/123)

   Release metadata
   - Changelog entry prepared in https://github.com/OWNER/REPO/pull/124

   Changelog: CHANGELOG.md, [X.Y.Z] at <release-tip-sha>
   ```

   Adapt labels and omit unavailable details rather than inventing them. A
   first release still requires the owner's confirmation before summarizing
   earlier history.

## Exact message-file commands and verification

After the annotation and commands have been reviewed and explicit tag/push
authorization is given, write the approved multiline text to a temporary
message file, then create and push the annotated tag. Preserve exact text and
avoid `-m` because multiline shell quoting is error-prone. Substitute the
project's tag name and remote when its instructions require different values.

```bash
cat > /tmp/release-tag-message.txt <<'EOF'
Release vX.Y.Z

Highlights
- User-visible change. (https://github.com/OWNER/REPO/pull/123)

Release metadata
- Changelog entry prepared in https://github.com/OWNER/REPO/pull/124

Changelog: CHANGELOG.md, [X.Y.Z] at RELEASE_TIP_SHA
EOF
git tag -a vX.Y.Z -F /tmp/release-tag-message.txt RELEASE_TIP_SHA
git push origin refs/tags/vX.Y.Z
```

Before creating the tag, recheck clean status, `git rev-parse HEAD`, release-tip
identity, candidate ancestry, and that neither local nor remote tag already
exists. Do not force-push or replace any existing tag. After push, verify both
target and annotation locally (`git cat-file -p refs/tags/vX.Y.Z`) and remotely:
fetch the tag into a temporary namespace, inspect its tag object and peeled
commit, and confirm the remote advertised target. Remove only the temporary
local fetch ref after verification. Report exact observed results.

## GitHub CLI publication

Use configured `gh` with an explicit repository; check installed command help
when flags differ. These are templates for the approved release, not permission
to publish. Do not use release creation to implicitly create or push a tag.

```bash
gh release list --repo OWNER/REPO --exclude-drafts --limit 100 \
  --json tagName,publishedAt,isPrerelease
gh release view vX.Y.Z --repo OWNER/REPO \
  --json tagName,name,body,isDraft,isPrerelease,url,targetCommitish
# After tag verification and explicit approval of notes, title and options:
gh release create vX.Y.Z --repo OWNER/REPO --verify-tag \
  --title "vX.Y.Z — Descriptive release heading" \
  --notes-file /tmp/release-notes.md
gh release view vX.Y.Z --repo OWNER/REPO \
  --json tagName,name,body,isDraft,isPrerelease,url,targetCommitish
```

Follow pagination when identifying older publication boundaries. Distinguish an
absent release from authentication, access or network errors. Verify the fetched
tag target separately: `targetCommitish` is not proof of the peeled tag SHA.
Use `--draft`, `--prerelease`, or `--latest=false` only when those concrete
options were approved. Otherwise the example publishes a regular release with
GitHub’s automatic latest selection; disclose that in the proposal.

Prefer an approved Markdown notes file for the full reader-facing description.
`--notes-from-tag` can reuse an annotation only when its exact text and history
range match the approved publication notes. Never substitute `--generate-notes`
for reviewed notes at execution time.

## Find the correct publication boundary

Tag history and publication history are separate. For a new GitHub Release:

- List or inspect the repository's existing GitHub Releases and find the most
  recent applicable *published* release preceding the requested target on its
  release line, rather than the globally newest publication. Verify both peeled
  commits and their ancestry/order: the boundary must be a strict ancestor of
  the target. For older tags or maintenance branches, exclude newer or unrelated
  releases; resolve ambiguous release-line selection with the owner. Do not use
  the immediately preceding tag as a substitute; intermediate tags may not have
  been published.
- State the previous published release tag (or “none; first GitHub Release”)
  and the new tag explicitly. Derive notes from commits after that boundary
  through the verified new tag. If a prior release tag is missing or cannot be
  mapped unambiguously to history, stop and resolve the range rather than
  guessing.
- For a first GitHub Release, summarize from the confirmed project starting
  point or owner-approved range. Prior tag existence alone does not establish
  a published-release boundary.

Inspect project docs and workflows for release automation before preparing a
publication. If tagging triggers automation, report it and follow that path;
do not create a duplicate release through another mechanism. Package registry
publication is out of scope.

## Existing tag, authorization, and publication failure

- For a request to publish an existing tag, verify that the tag is annotated,
  points to the expected commit, and has a readable annotation. Do not modify
  it. Verify that the tag exists on the intended remote: fetch into a temporary
  local namespace and compare its peeled commit and complete annotation with
  the approved tag, using the remote verification procedure above. A local-only
  tag or any mismatch blocks publication until resolved; never silently create
  a remote tag through release publication. Prepare publication from that exact
  remotely verified tag only after identifying the
  previous published boundary and confirming that no release already exists.
- If a GitHub Release already exists for the target tag, report its URL and
  observed tag, target, notes, and state. Do not edit, replace, or duplicate it
  unless the owner explicitly requests a specific edit and that edit is in
  scope for the project workflow.
- Before publication, show the owner the target repository/tag and commit,
  title, full notes, draft/prerelease/other applicable options, and exact
  method/command. Request explicit approval for that concrete release. Prior
  authorization applies only if it clearly names the same target, title,
  notes, and options; otherwise request fresh approval. Missing authorization
  means stop after preparation.
- Once authorized and published, read the release back and verify its tag,
  target commit, notes, and URL. If publication fails after a successful tag
  push, state that the tag is complete and verified while publication remains
  incomplete; include the safe failure detail and stop. Do not silently retry
  through another path or claim a full release.

## Scenario review

- **Explicit tag-only request:** prepare evidence-based annotation and message-file tag/push
  commands; after explicit approval, verify remote target and annotation. Do
  not require or create a GitHub Release.
- **First GitHub Release:** explicitly establish “no prior published release,”
  get owner-confirmed history boundary if needed, present complete publication
  details, then publish only with concrete approval. Existing tags do not
  preclude the first GitHub Release.
- **Existing verified tag:** preserve it, confirm exact target and annotation,
  check for an existing release, prepare target/title/notes/options, and publish
  only with approval.
- **Several intermediate tags:** use the previous published release as the
  notes boundary, not the immediately previous tag; include all verified
  changes through the target tag.
- **Existing automation:** inspect workflows/docs first; if automation owns or
  triggers publication, follow it and prevent duplicate manual publication.
- **Default GitHub release:** prepare the annotated tag and publication notes
  together; request concrete approval for both, verify the pushed tag, publish
  with `--verify-tag`, then read back the full release.
- **Missing authorization:** finish preparation, show the concrete proposal,
  and stop before tag/push or release mutation.
- **Publication failure after tag push:** report the verified tag as complete
  and publication as failed/incomplete, with no implication of success.
