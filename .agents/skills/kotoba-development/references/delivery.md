# Delivery procedures

Follow the permissions in [AGENTS.md](../../../../AGENTS.md) and the user's
current request. Development authorization does not grant permission to change
unrelated systems or send messages to other people.

## Running services and migrations

Use [README.md](../../../../README.md#storage-and-operations) for setup and
environment commands. Corpus, schema, backup/restore, and retokenization procedures
belong to the [kotoba-graph skill](../../kotoba-graph/SKILL.md) and
[graph operations](../../../../docs/graph-operations.md). Preserve the protected
application, source content, learning status, and reading progress. Validate
preservation and a repeat plan after an applied migration.

Keep production, acceptance, and development storage separate under project-local
bind mounts. Stop database writers before raw storage copies, verify the copy,
and preserve originals until preservation checks pass. Do not introduce Docker
named or anonymous volumes, including image-declared default storage paths.

When deployment is part of the request, deploy the reviewed and verified build
through the existing project tooling. Check production readiness, the served
build, trusted Tailscale HTTPS port 3010, and loopback-only upstream HTTP. Run
appropriate read-only production smoke checks without creating mutable corpus
fixtures. Installed PWAs must retain explicit update/reload behavior.

## Git publication

Review the staged diff and current Git state. Commit significant completed fixes
or features coherently, using the existing project authorization. Preserve the
user's unrelated work. Never include AI attribution in messages or authorship.

Before pushing, inspect all reachable Git history and the outgoing files for
credentials and private data, not only the final diff. Check runtime credentials
without printing their values, and exclude private corpus text, media, databases,
backups, environment files, and development history. Retain audit results in
ignored runtime storage. If the audit finds a problem, resolve it within the
authorized scope before publication; do not silently publish or discard history.

Push all accumulated commits before finishing. Verify the remote branch and
local state afterward. If publication is blocked, state the exact blocker and
retain it as unfinished work.

## Completion

Update the relevant contract or acceptance evidence when behavior changes.
Remove only clean temporary worktrees once their work is integrated and
recoverable. Report what changed, why, relevant verification and timings, and
material limitations. Preserve skip reasons and distinguish simulated mobile
checks from physical-device testing. Do not claim completion while requested
implementation, fixes, verification, or delivery remain unfinished.
