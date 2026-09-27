# Release acceptance

Release checks and production verification completed on 2026-09-28. The implementation contract is in
[implementation.md](implementation.md); setup and test commands are in
[the README](../README.md).

## Scope and evidence

Use isolated acceptance and development data, real service boundaries, and
synthetic fixtures wherever possible. Production is never a mutable test fixture.
Final browser acceptance must not use mocked application routes. Retain local
logs, traces and screenshots, inspect screenshots as well as assertions, and
record elapsed time and every skip reason. The warmed matrix targets 20 minutes.

| Area | Required checks |
| --- | --- |
| Corpus and ontology | Exact-spelling identity, canonical families, separate meanings, deduplication, source offsets, generated OML constraints, invalid-write rollback and guarded agent mutations. |
| Imports and Ichiran | Real job progress and recovery; unchanged upstream segmentation and conjugation analysis; dictionary-only import without model inference; Latin text preserved without standalone vocabulary. |
| Reader and language actions | Continuous text, base-form details and pronunciation, atomic New-to-Learning in both areas, retained Familiar/Known statuses, lazy cached sentence actions, and temporary phrase translation/audio without persistent corpus or media records. |
| Overlays and selection | Shared word/phrase overlay, mouse and touch selection, copy controls, focus retention, background scroll lock, conditional touch dismissal, unchanged desktop reader geometry and nonzero safe-area insets. |
| Persistence and practice | Stable settings saves, viewport bookmarks independent of furthest progress, no progress from open/restore/close, acknowledged offline progress recovery, completion preview/confirmation, and lesson-specific practice with prepared audio. |
| Operations and PWA | Trusted HTTPS, service-worker registration/update, cached reading, real outage recovery, backup/restore, retokenization preservation and idempotence, and isolated project-local storage. |

Browser coverage uses simulated mobile Chromium, phone WebKit and iPad WebKit in
portrait and landscape over the actual trusted Tailscale HTTPS origin. Wide
desktop checks cover overlays and keyboard interaction. Acceptance uses loopback
HTTP port 3011 with Tailscale HTTPS port 8443; production uses loopback HTTP and
custom Tailscale HTTPS port 3010. Certificate-warning bypasses are not acceptable.

## Verified results

| Check | Result |
| --- | --- |
| Backend suite | 85 passed, 1 opt-in live-model test skipped in the normal run (18.34 seconds). The live dictionary/model round trip passed separately (5.17 seconds); the final progress regression passed in a focused 5-test run. |
| Core browser scenarios | All 59 executable scenarios passed across the initial matrix and corrective reruns. Nine deliberate skips: four WebKit offline-emulation cases and five duplicate executions of a shared status assertion tested in phone Chromium. |
| Service-worker update | All 6 mobile configurations passed after waiting for full activation before reload (12.1 seconds). |
| Settings outage recovery | Phone Chromium and phone WebKit passed against a stopped/restarted acceptance API (24.8 seconds). Failed changes and newer slider values survived retry and reload. |
| Production PWA smoke | All 6 mobile configurations passed trusted HTTPS, manifest, service-worker control and read-cache checks (7.3 seconds). No certificate bypass. |
| Retokenization | Production and acceptance plans applied with backups. Original source text, identities, learning statuses, meanings, completion and reading progress passed preservation checks. Repeat plans reported no changes; graph audits passed. |
| Persistent storage | Production, acceptance, development and Ichiran use only project-local bind mounts. Stopped-writer copies passed content/hash verification before obsolete project volumes were removed. Unrelated Docker storage was untouched. |
| Protected original application | All 962 recorded file checksums remain unchanged. |

The initial 68-case matrix took 24.1 minutes, exceeding the warmed 20-minute
objective while exposing failures. Corrective runs verified WebKit focus
retention, multiline clipboard copying, modal backdrop versus mouse drag,
service-worker activation and settings outage recovery. Reading-position checks
allow one pixel of browser rounding while still requiring unchanged progress.
Desktop setup waits for its deliberate scroll write to finish before measuring
popup behavior. Failed cases are retained as evidence, not counted as passes.

Phrase audio completed in all six final mobile configurations; the remaining
phone landscape practice playback rerun also passed. Earlier playback stalls did
not reproduce after disconnecting an automatically reconnected Bluetooth headset.
That sequence alone does not prove their cause or establish physical speaker
output. The final assertions check actual media progression and completion.

Final production read timings over Tailscale, five requests per endpoint:
library median 22.58 ms, reader 54.88 ms, and word details 33.67 ms. The maximum
word-details sample was 267.95 ms. These describe one local corpus, not a load
limit. The settings scalar-write path avoids a graph-wide scan; earlier focused
measurements gave a 4.41 ms median. Cached pronunciation uses indexed read paths
and prepared in-memory audio for requested practice challenges.

Raw logs, traces, screenshots and migration receipts stay in git-ignored
`.runtime/`, `test-results/` and `playwright-report/`. Backups remain in
`data/backups/`. Public source includes AGENTS.md, the database-management skill,
OpenAPI, OML and setup documentation. Publication uses a clean initial history;
private development history remains only in ignored local backups. Audit all
reachable Git objects before pushing, including checks for runtime credentials,
private corpus text, database/audio files and backup paths.

## Verification limits

- No physical iPhone or iPad testing has been performed. Browser emulation does
  not establish hardware speaker output, silent-switch behavior or airplane-mode
  recovery.
- Audio acceptance requires advancing playback time, completion and a non-silent
  payload. Successful synthesis or download alone is insufficient.
- Four WebKit offline tests are skipped because of the known Playwright
  service-worker offline-emulation limitation. They must remain reported as
  skipped. Real upstream-outage checks provide separate recovery evidence and
  do not remove that limitation.
- WebKit mobile gesture checks use DOM touch events where Playwright lacks native
  touch dispatch. Nonzero safe-area checks require explicit inset emulation;
  device presets alone do not establish safe-area correctness.
- Local timings describe the tested machine and fixture only. They are not
  load-test guarantees or measurements on physical mobile hardware.

## Deployment and publication

The final shared-modal build is deployed on custom trusted HTTPS port 3010.
Desktop Chromium and WebKit passed at widths 1024, 1440 and 1920, including
unchanged reader geometry, real clipboard copying, keyboard focus, mouse drags
and progress preservation. The final affected-browser run passed 11 cases in
3.9 minutes, with one deliberate WebKit offline-emulation skip. Phone, tablet
and desktop screenshots were inspected.

Production API/worker health, served container assets, graph validity, stored
migration progress and persistent bind mounts were verified. The old application
remains unchanged. Test environments and their temporary HTTPS endpoint can be
stopped independently of production and the shared dictionary.
