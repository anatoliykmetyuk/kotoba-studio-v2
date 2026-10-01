---
name: kotoba-development
description: Implement, review, test, and deliver Kotoba Studio features and fixes. Use for repository changes, code reviews, verification, and deployment.
---

# Kotoba development

Work from the repository root. Follow [AGENTS.md](../../../AGENTS.md) for
permissions, protected data, required reviews, platforms, and storage boundaries.
Use the relevant sections of [the implementation contract](../../../docs/implementation.md)
for behavior affected by the request. Direct user instructions take precedence;
this skill does not grant additional permissions or expand the task.

When work is sourced from the project's Obsidian task note, read
[task-note procedures](references/tasks.md) before interpreting tasks or changing
their completion state. Do not load this procedure for unrelated requests.

## Implementation and parallel work

Inspect the current Git state and affected code before choosing a starting ref.
Preserve existing uncommitted work. Define the behavior to change and how it will
be verified; a documentation-only change needs document and instruction checks,
without starting an unrelated application acceptance run.

Delegate genuinely independent changes to separate implementer agents in unique
worktrees under `.agents/worktrees/`, using descriptive `br/` branches. Give each
agent its exact checkout, scope, dependencies, and relevant contracts. Worktrees
do not isolate Docker services or browser fixtures: serialize operations sharing
mutable environments, especially outage tests, worker pauses, schema changes,
and service-worker replacement. Keep dependent changes sequential.

Integrate completed changes into the delivery checkout without losing local
work, then verify their combined behavior. Retain recoverable work until
integration is complete; remove only clean temporary worktrees afterward.
For corpus queries or mutations, use the existing
[kotoba-graph skill](../kotoba-graph/SKILL.md).

## Independent review

At important checkpoints, spawn a reviewer with fresh context, separate from the
implementer. Supply the original request, applicable contracts, concrete diff,
and available evidence. Scope its permissions explicitly; a review-only agent
must not change files, services, or corpus data.

Apply the review dimensions and effort budget in AGENTS.md. Review affected
behavior across mobile Chromium, phone WebKit, iPad WebKit, Tailscale, and PWA
contexts, including portrait and landscape. Return demonstrated defects to the
implementer, rerun affected checks, and obtain an independent follow-up review.
Continue until no notable recommendations remain. Avoid speculative redesign
and repeated testing without a new change, failure, or unresolved concern.

## Verification and delivery

Read [verification procedures](references/verification.md) when choosing or
running checks, including device, playback, PWA, and recovery checks. Match the
checks to the affected behavior and integrate their results before delivery.

Read [delivery procedures](references/delivery.md) when preparing a deployment,
publication, or final handoff. Preserve unfinished tasks across checkpoints and
steering, and report specific blockers without claiming completion.
