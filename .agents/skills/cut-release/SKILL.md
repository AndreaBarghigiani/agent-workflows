---
name: cut-release
description: Classify merged changes against the project's versioning convention, propose a release version, date its changelog entry, and prepare an annotated tag and readable GitHub Release notes, and publish after explicit approval. Use when asked to cut, publish, or tag a release, version this release, date a changelog entry, or create a tag for a version number.
---

# Cut a release

Prepare a versioned release for a reviewed commit: an annotated Git tag and,
for GitHub-hosted projects, a GitHub Release with readable change notes. Default
to preparing both unless the owner requests tag-only delivery or project release
machinery specifies another destination. A tag annotation alone does not provide
the same GitHub presentation as published release notes. The owner chooses the
version and authorizes tagging; GitHub Release publication needs explicit
authorization for the concrete release. “Cut-release” authorizes preparation,
not a tag, push, or publication. Read the project root `AGENTS.md` and relevant
release docs first; they govern versioning, remotes, tag naming, and approval.

## 1. Discover the release path

- Read project instructions, contributing/engineering docs, changelog, and
  existing tags (`git tag --list --sort=-v:refname`, `git describe --tags`).
  This library's convention is
  [release versioning](../../../docs/skill-distribution.md#release-versioning).
- Inspect release PR tooling, GitHub Release workflows, CI pipelines, and other
  release automation before proposing commands. Follow documented machinery;
  if it owns the release path or may publish automatically, stop and resolve
  the path with the owner. Never silently bypass or trigger automation.
- If no release convention exists, propose semver and a Keep-a-Changelog
  changelog and stop for the owner's choice.

## 2. Establish and prepare the release

- Confirm a clean tree, intended release branch, reviewed merged candidate,
  and version convention. Record the candidate SHA and derive the user-visible
  changes from the verified range. Select and record the preceding release tag
  on the intended release line and its peeled commit as the exclusive start;
  verify it is an ancestor of the candidate, the inclusive end. Resolve missing
  or ambiguous boundaries with the owner before classification or annotation.
  Propose the version together with a descriptive release heading and draft
  user-visible highlights, grounded in that range, so the owner can review
  the version and release text together. Include relevant merged PR URLs.
  The owner confirms the version; refine the draft into the complete annotation
  below once the release metadata and final tip are known.
- Classify against the documented convention. Under semver, use MAJOR for
  breaking changes, MINOR for features, and PATCH for fixes and documentation;
  follow project-specific rules when they differ.
- For a first release, propose an initial `0.x` version and a seeded changelog.
  Summarize prior history only after owner confirmation.
- Draft and commit the dated changelog entry before tagging, following project
  branch and commit rules. Prefer including release metadata in the existing
  in-scope PR; do not create another PR solely to separate the changelog from
  related reviewed changes. If no PR is active, use one release-preparation PR
  when project rules require it. Record the reviewed candidate and final release
  tip. If the PR includes substantive changes, include them in the release range
  and require review and checks for the complete merged tip before tagging;
  otherwise verify the tip adds only release metadata to the reviewed candidate.
- Build an annotated tag message with a version heading, concise user-visible
  highlights, relevant merged PR URLs, and a changelog reference that resolves
  at the tag. Identify release-metadata PRs separately from the changes they
  describe; do not present metadata work as a user-visible change. Use only
  evidence from the verified release range. See
  [tag and publication details](references/publication.md).

## 3. Review and create the tag

- Present the complete multiline annotation and exact message-file, tag, and
  push commands for review. Run them only after explicit tag/push approval in
  the current run, then recheck the approved release tip, candidate ancestry,
  clean tree, remote, and tag absence immediately before creation.
- Never replace or force-update an existing tag. If the tag already exists,
  verify its target and annotation; use it for publication only if it is a
  verified tag and publication is separately requested and authorized.
- After push, verify the remote tag target and annotation as well as the local
  tag target. Report tag completion independently from any publication result.

## 4. Publish the GitHub Release

- For the default GitHub release path, discover the previous *published GitHub
  Release* boundary explicitly during preparation; it may differ from the previous Git tag.
  Prepare notes over that boundary through the requested verified tag, and
  explain the included range. This supports first publication and multiple
  intermediate tags.
- Check whether a release already exists for the tag. Report its state; never
  edit or duplicate it silently. Follow the project's release machinery and
  options, including prerelease/draft settings when applicable.
- Prepare publication together with the tag proposal when possible so the owner
  can approve the concrete tag/push and publication actions at one checkpoint;
  version confirmation alone does not authorize either. If the tag does not yet
  exist, prepare its notes but verify the pushed tag before publication.
- Before asking for approval, present the exact target tag and commit, title,
  full notes, release options, and intended publishing method. Preserve prior
  explicit authorization only when it covers this same concrete release.
- Verify the published release's tag, target, notes, and URL. If tag creation
  succeeded but publication failed, report that partial completion and the
  precise failure; do not imply that publication succeeded.
- For explicit tag-only delivery, skip publication and report that outcome as
  tag-only, with no GitHub Release. If publication was planned but lacks approval
  or fails, report the release as prepared or partially complete, not published.
- Package registry publishing and deployment are outside this skill.

## 5. Report

Report the proposed/confirmed version, candidate and release-tip SHAs, changelog
reference, annotation, tag verification, and publication status/URL if applicable.
Keep existing tags unchanged; richer annotations apply to future tags only.
