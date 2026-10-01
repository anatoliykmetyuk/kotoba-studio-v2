# Verification procedures

Run commands from the repository root. Setup commands and opt-in environment
flags are maintained in [README.md](../../../../README.md#development-and-verification);
required coverage and release evidence are in
[docs/acceptance.md](../../../../docs/acceptance.md#scope-and-evidence).
Use the accepted behavior in the relevant implementation-contract sections to
choose assertions. Preserve original content and progress in migration checks.

## Choose the checks

- Prove changed domain behavior in the applicable Python unit/integration suites
  under `tests/`, with actual service-boundary checks in the isolated stack.
  Database integration tests require `KOTOBA_TEST_DATABASE=disposable` and the
  owned development database on loopback Bolt port 17687; they reset its data.
- Run applicable pure TypeScript tests with `node --test tests/*.test.mjs` and
  frontend type/build checks with `npm run build` when frontend code changes.
- Compile ontology changes using `scripts/compile_ontology.py` with Java 21 and
  official OML tooling. Schema and corpus changes also require the guarded
  backup/migration/audit workflow in the graph skill.
- For documentation and skill changes, validate frontmatter, local links,
  preserved requirements, and command accuracy. Use the skill-creator validator
  when available. Do not run application or language-model tests solely because
  prose changed.

Use shared isolated fixtures, synthetic source material, disposable media, and
fresh browser contexts. Production is never a mutable test fixture. Preserve the
existing protected-file checksum baseline; use `scripts/protect_v1.py` to verify
it when available, without creating a new baseline over modified files.

## Browser setup and silence

Use the real acceptance stack, upstream loopback HTTP port 3011, and its trusted
Tailscale HTTPS origin on acceptance port 8443. Set `KOTOBA_TEST_BASE_URL` and
`KOTOBA_ACCEPTANCE_ORIGIN` to that same actual HTTPS origin. Production remains
on trusted HTTPS port 3010. A localhost fallback or certificate bypass does not
satisfy mobile/Tailscale acceptance.

Import browser tests from `tests/browser/fixtures.ts`. Its context-wide adapter
mutes every page, including additional tabs, before native media playback.
Separate browser contexts and standalone windows must install
`muteBrowserContext` before navigation, or `muteTestOutput` on their initial page
before navigation if that window uses only one page. Chromium also uses
`--mute-audio`. Keep volume zero and output muted throughout the run; an
application playback handler must not undo test silence.

Do not replace native playback with a stub. For speech changes, verify decoded
media, advancing playback time, completion/ended events, and a non-silent signal
in generated audio. A successful download alone is insufficient. Muted browser
playback does not prove physical speaker output or unmuted iOS autoplay.

Final acceptance uses actual services, without mocked application routes. Check
the selected spec's opt-in flags before running it. Outage, import-lifecycle,
folder-selector, and update tests may pause workers, restart services, or replace
the acceptance service worker. Require exclusive access to those resources and
verify the exact acceptance target before any mutation. Restore services, worker
state, and replaced files in cleanup, including after failures or interruption.

## Device and interaction coverage

Use the six mobile projects in `playwright.config.ts`: phone Chromium, phone
WebKit, and iPad WebKit, each in portrait and landscape. Cover desktop overlays
and keyboard behavior when affected. Inspect screenshots as well as automated
layout and interaction assertions.

For reader, popup, input, or settings changes, verify mouse, finger, pen/Apple
Pencil, and keyboard activation where applicable, touch scrolling and dismissal,
focus and backdrop behavior, and unchanged reading position. Shared activation
changes require dialogs, navigation, forms, labels, and reader/practice actions
to be checked together. Use nonzero safe-area insets; device presets alone report
zero and cannot establish notch, rotated side-cutout, or safe-viewport behavior.

For PWA, cache, or persistence changes, verify mobile and actual standalone
layouts, service-worker installation and updates, explicit update/reload
controls, cached offline reading, queued progress recovery, and real service
outage/reconnection behavior. Preserve the reading session until an explicit
reload. Add recovery, persistence, speech, schema enforcement, and agent-operation
checks where the changed behavior crosses those boundaries.

WebKit offline emulation is blocked by the documented Playwright service-worker
issue linked in `pwa.spec.ts` and `reading-position.spec.ts`. Record that skip
accurately; use real upstream outages to check recovery on WebKit without
claiming the skipped offline-emulation test passed. Distinguish browser emulation
from physical-device execution in results.

## Evidence and iteration

Retain logs, traces, screenshots, backup receipts, and preservation comparisons
under git-ignored `data/` or `.runtime/`. Record elapsed timings, failures, reruns,
and each skip reason; the warmed acceptance matrix targets 20 minutes.

Inspect failures before widening the run. Correct product defects or assertions
that contradict the accepted contract, then rerun affected checks. Do not remove
an assertion or raise a timeout merely to obtain a pass. Once relevant checks
pass, repeat or broaden them only for a new change or unresolved concern.
Never assign required manual verification to the user.
