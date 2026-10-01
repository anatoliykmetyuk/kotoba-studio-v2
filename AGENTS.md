# Kotoba Studio v2

## Authorization and protected data

The user grants standing permission to commit and push work for this project, including future implementation and fixes. Commit each significant completed fix or feature as a coherent change. Before finishing a work turn, push all accumulated commits; pushing after every individual commit is optional. Verify relevant checks and audit reachable history for credentials and private data before pushing. If a push is blocked, report the specific blocker and retain it as unfinished. Never attribute commits or commit authorship to AI.

Never modify the previous application directory (`../kotoba-studio` in the original installation), its data, the user's writing journals, or existing Ollama configuration. Preserve protected-file checksums. Test with disposable databases, media directories, and browser contexts. Never publish credentials, private corpus data, media, databases, backups, or private development history.

## Authoritative contracts

Use the relevant sections of [docs/implementation.md](docs/implementation.md) for accepted product behavior and the current implementation contract. Preserve these requirements when changing the application. No Writing functionality, journal migration, or daily target/goal/point/streak system.

Words have stable UUIDs and unique exact spellings; separate Meanings belong to the same Word. Each Word links to one self-linked canonical base, which owns the shared Learning Status. Imports use local Ichiran and the built-in dictionary without model inference. Preserve upstream segmentation and conjugation rules, original source offsets, learning status, and reading progress.

OML in `ontology/` is authoritative. Use official OML tooling and generated validation, never a competing hand-written graph schema. All writes, including agent Cypher, must pass transactional conformance checks. Use [kotoba-graph](.agents/skills/kotoba-graph/SKILL.md) for querying, changing, or maintaining corpus data.

## Development workflow and reviews

Use [kotoba-development](.agents/skills/kotoba-development/SKILL.md) for implementation, review, testing, and delivery work. Read its supporting procedures only when relevant to the current task.

Parallelize genuinely independent work through separate agents and Git worktrees. Worktrees must be under this repository's `.agents/worktrees/`, with unique descriptive names; use the `br/` branch prefix. Coordinate integration and serialize changes or tests that share mutable services or fixtures.

At important implementation checkpoints, spawn a fresh-context reviewer to evaluate correctness, architecture, query efficiency, and ontology/database practices. Reviews must consider mobile, iPad, Tailscale access, and PWA behavior. Resolve demonstrated defects and iterate with independent review until no notable recommendations remain. Keep review plus optional refactoring at or below 20% of effort; at least 80% should deliver the plan. Prioritize demonstrated defects over speculative redesign.

Continue until all requested implementation, fixes, verification, and delivery are complete. Incorporate steering and answer intermediate questions without abandoning unfinished work. Stop or pause only on an explicit user instruction. Report genuine blockers and retain blocked work as unfinished.

## Verification and browser audio

Use shared isolated fixtures. Prove domain behavior in unit/integration tests and actual service boundaries in real-stack tests. No route mocks in final acceptance. Verify mobile Chromium, phone WebKit, and iPad WebKit over the actual Tailscale origin, in portrait and landscape. Inspect screenshots as well as automated layout and interaction assertions. Test recovery, persistence, speech, schema enforcement, and agent operations. Record timings; the warmed acceptance matrix targets 20 minutes. Do not assign manual verification to the user.

Mute browser audio before running any browser tests, including additional tabs, mobile/iPad contexts, and standalone PWA windows. Keep output muted throughout testing while still verifying actual media playback.

Serve the installable PWA using Tailscale-managed trusted HTTPS on custom port 3010, never default port 443, self-signed certificates, or certificate-warning bypasses. Keep upstream HTTP bound only to loopback; do not bind Docker HTTP to the Tailscale address on the HTTPS port. Verify mobile and standalone layouts, service-worker updates, offline cached reading, queued progress recovery, and nonzero device safe-area insets. Never claim WebKit offline emulation passed when blocked by the documented Playwright service-worker issue.

## Persistent storage

All persistent application and Docker service data must live inside this repository under git-ignored `data/` or `.runtime/`. Use bind mounts beneath `data/docker/` for Neo4j data/logs, media, and the Ichiran PostgreSQL database. Never introduce named or anonymous Docker volumes, including image-declared default volumes. Production, acceptance, and development must use separate directories. Move existing storage only with stopped database writers, a verified copy, and preservation checks before removing the original volumes.
