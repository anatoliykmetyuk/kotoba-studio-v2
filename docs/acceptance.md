# Release acceptance

## Obsidian task fixes, 2026-10-01

Furigana covers kanji only, using conservative kana alignment without altering
source text or token offsets. Import and revision dialogs select existing
folders, including empty folders. Accepted imports file independently and retain
retry state across dialog dismissal, reload, unavailable storage and concurrent
PWA tabs. Completion records prevent stale requests from resurfacing.

The Ichiran adapter retains upstream segmentation and uses explicit conjugation
metadata to distinguish 速く→速い from 早く→早い. Production repair preserved the
original 速く UUID, source placements, meanings, encounters and reading progress.
Its newly created 速い family inherited the previous status; 早い remains separate.
The repeated repair plan contained no changes.

The compiled OML contract now assigns one Learning Status to each canonical
family. Production migrated 1,495 families to the lower legacy status and
preserved 14,759 domain entities and all non-status relationships. Installed
clients retain compatible aliases, and legacy cached readings normalize to the
lower state. Practice defaults to Learning and Familiar, without the Include
all statuses control; eligible sentence exercises retain every source token.

The integrated backend run passed 134 tests with one opt-in local-model skip in
21.90 seconds. All 60 pure TypeScript tests passed. Official OML compilation,
TypeScript checks, frontend builds, preservation checks and graph audits passed.
Independent implementation and integration reviewers found no remaining notable
recommendations.

All browser contexts mute output before native playback, including additional
tabs and standalone PWA windows. Audio assertions still require native playback
progression and completion, with non-silent generated WAV bytes. These checks do
not establish physical iOS speaker output or unmuted gesture autoplay.

Disposable acceptance data was backed up and reset through the validated restore
API before final device checks. Accumulated fixtures had delayed structural
writes beyond test assertions. Subsequent trace inspection also corrected exact
label selectors for populated textareas and armed frame-based grading feedback
observation before tapping; product timing and assertions were retained.

The affected 86-case device matrix took 11.0 minutes: 78 passed initially and
eight failed. Six failures asserted an obsolete long-press behavior; the approved
contract retains a cancellable anchor. Two exposed PWA update problems. Initial
installation now distinguishes its worker from a replacement of an active worker,
and explicit activation retains the asynchronous service-worker operation. The
cross-tab test observes the actual requested worker and records its state on
failure; the original activation failure's precise cause was not established.
All eight update configurations and all six native playback/anchor checks passed
in the corrected 20-case run (19 passed, one folder layout failure, 3.2 minutes).
The folder failure revealed native select text extending the WebKit dialog's
scrollable width. Scoped grid/control constraints fixed this; all six import/edit
checks passed in 2.2 minutes, and independent review inspected all 12 screenshots.

The broader practice run passed 45 cases, with one transient feedback assertion
failure and eight Chromium-only transport-latency skips, in 12.6 minutes. All six
corrected primary-meaning checks passed in the device matrix. The final cache and
HTTPS run passed 14 cases in 1.8 minutes, with four WebKit offline-emulation skips
for the documented Playwright service-worker limitation. Real HTTP failures and
queued-progress recovery passed on all six mobile configurations. No application
routes were mocked. Simulated phone Chromium, phone WebKit and iPad WebKit covered
portrait and landscape; the update checks also covered desktop Chromium/WebKit.
Independent review inspected 54 affected-feature screenshots as well as the
final folder screenshots. Physical iPhone/iPad execution remains unverified.

The final Chromium standalone app-window check passed in 6.5 seconds at phone and
tablet sizes in both orientations, with actual standalone display mode, trusted
HTTPS, active service-worker control and muted browser output. Production PWA
smoke checks passed all six mobile configurations in 6.6 seconds. The final
production container matches the built image; index HTML, service worker and
referenced JavaScript/CSS bytes match the files served over trusted Tailscale
HTTPS port 3010. API and worker readiness passed. Protected-file verification
confirmed all 962 previous-application files unchanged. Final generated-schema
audits validated production (18,779 nodes, 21,783 edges) and disposable acceptance
(8,623 nodes, 10,897 edges). All nine running project containers use project-local
bind mounts, and every published Docker port is bound to loopback.

## Import and folder separation, 2026-09-29

Ingestion saves unfiled lessons and source provenance. Folder renaming and filing
use the existing validated graph transaction interface, independently of import.
The real acceptance stack verified unfiled library visibility, in-place rename,
failed filing preserving the completed import, subsequent successful filing,
content deduplication and provenance preservation in 94.1 seconds. The 27 focused
API/import/migration tests passed in 9.49 seconds. No UI or ontology changes were
included. Library ordering uses creation time rather than modification time.
The production first item and folder membership were verified after deployment.
Agent workflow and graph-query examples are in the skill.

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
| Reader and language actions | Continuous text, base-form details and pronunciation, atomic New-to-Learning for the shared family status, retained Familiar/Known statuses, lazy cached sentence actions, and temporary phrase translation/audio without persistent corpus or media records. |
| Overlays and selection | Shared word/phrase overlay, mouse and touch selection, copy controls, focus retention, background scroll lock, conditional touch dismissal, unchanged desktop reader geometry and nonzero safe-area insets. |
| Persistence and practice | Stable settings saves, viewport bookmarks independent of furthest progress, no progress from open/restore/close, acknowledged offline progress recovery, completion preview/confirmation, and finite lesson-specific practice, immediate sentence controls, lazy queued audio, reordering and optional answer hints. |
| Operations and PWA | Trusted HTTPS, service-worker registration/update, cached reading, real outage recovery, backup/restore, retokenization preservation and idempotence, and isolated project-local storage. |

Browser coverage uses simulated mobile Chromium, phone WebKit and iPad WebKit in
portrait and landscape over the actual trusted Tailscale HTTPS origin. Wide
desktop checks cover overlays and keyboard interaction. Acceptance uses loopback
HTTP port 3011 with Tailscale HTTPS port 8443; production uses loopback HTTP and
custom Tailscale HTTPS port 3010. Certificate-warning bypasses are not acceptable.

## Verified results


Five-question session limit (2026-09-28, expedited at the user's request): both
exercise types sample at most five eligible questions, and sentence candidates
deduplicate by Sentence identity. Full-lesson distractors remain available.
The production build and fresh independent source review passed. An attempted
broader browser run hit cold language-job/grading waits and was stopped when the
user requested fast tracking; that run is not reported as passing. No backend,
query or ontology changes were needed for this limit.


Current UI and practice follow-up (2026-09-28): a fresh full-UI reviewer identified
unowned import completion, mutable answers during grading, and hidden query errors.
The fixes use one cancellable import observer, challenge/session identity guards,
and shared retryable error UI. Independent input and update-lifecycle reviews
also checked the global activation boundary and cross-tab service-worker updates.
The final bounded practice source review found no remaining concrete defects.

The shared activation/settings/update/selection/overlay matrix passed all 48 cases
in 8.9 minutes across phone Chromium, phone WebKit, iPad WebKit in both orientations,
and desktop Chromium/WebKit. Coverage includes native form/file actions, labels,
checkboxes, popup controls/backdrops, both phrase-selection gestures, update
failures/retries, and explicit reload after an update becomes ready.

The focused backend practice tests passed all 8 cases. Practice now uses the same
stored dictionary ranking as word details; the query starts from the selected Text
index. The isolated profile read 4 tokens and 7 meanings with 234 database hits,
avoiding the previous global 524-token scan. The 14 preparation/queue tests passed,
including ordered playback, cancellation, shared preparation consumers, bounded
waits and visibility recovery.

A read-only production diagnosis found successful jobs queued behind eager audio
preparation: 18 distinct requests (15 speech, 3 translation), with creation-to-ready
times of 20.2–46.3 seconds. Polling paused for 44.1 seconds while seven jobs finished,
consistent with the reported background/foreground transition. This was not a
stuck worker; the precise trigger of multiple preparations was not established.
The new flow renders the challenge immediately, generates only its translation on
entry, and requests speech only on actual clicks.


The focused practice/import/error run initially passed 18 cases, with five failures
and one deliberate skip. Corrected metadata assertions, frame-timed feedback
checks and spatial keyboard-target assertions resolved those failures. Six
corrected/new cases passed in 2.3 minutes (with two Chromium-only transport-latency
checks deliberately skipped in WebKit), followed by both keyboard checks in
19.2 seconds. This includes the hidden answer disclosure, stale-grading reset
protection, detached import completion, and real stopped-API error recovery.
A paused acceptance worker proved that tokens, grading and advancement remain
usable while translation and speech are pending, with no speech requested before
clicking and no playback continuing after completion.

The remaining device practice matrix passed 22 of 24 cases in 3.9 minutes.
The two phone-WebKit landscape failures were test issues: assertion backoff missed
850ms feedback, and a drag started at the viewport edge triggered normal
49px auto-scroll, invalidating fixed target coordinates. Frame-based observation
and centering the drag fixture retained the actual feedback, ordering and scroll
assertions; both reruns passed in 21.7 seconds. No app workarounds were added for
these failures. Final coverage spans all six mobile configurations and desktop
Chromium/WebKit, including sequential real audio, immediate token placement,
finite progress/completion, optional hints, wrapped-row drag, keyboard sort/cancel
and tap removal. Phone, iPad and desktop screenshots were inspected.

Popup and selection correction (2026-09-28): reproduced a suppressed pen click
after a short touch pull, then added pen activation and a body-level
overlay. The follow-up release below replaces local pen handling with one shared activation boundary. All eight expanded dismissal cases passed across the matrix and focused
landscape rerun, covering close/speech controls, clipboard writes in Chromium,
the complete outside gutter, late compatibility clicks, and drag rejection.
Eight existing overlay/settings cases also passed (3.0 minutes).

The final selection run passed all 16 cases in 3.1 minutes over trusted Tailscale
HTTPS: phone/iPad orientations and desktop, hold-release then endpoint tap,
hold-drag, mouse drag, cancellation and keyboard activation. It also verifies
that selection does not learn or pronounce individual words. A landscape failure
exposed unrelated mouse hover canceling a touch hold; input ownership now prevents
that. A fresh reviewer identified stale click suppression after cancellation,
which was fixed and covered by a regression. Follow-up review found no remaining
concrete defects. Phone, iPad and desktop screenshots were inspected.

Chromium used native pen dispatch; WebKit used DOM pen events without synthetic
clicks because Playwright has no native WebKit pen input API. This is not physical
Apple Pencil verification. Test audio output is muted while real media still
loads and plays. No backend, ontology or database queries changed in this patch.
Final iPad landscape and desktop Chromium integration checks passed in 56.3
seconds, including clipboard copying, reader geometry and reading progress.
The deployed port-3010 build passed all six mobile PWA smoke checks in 7.9
seconds; served HTML, service worker and assets match the container build.

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
and an in-memory cache for pronunciations requested by the user.

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

The current UI and practice build is deployed on custom trusted HTTPS port 3010.
Its six production PWA smoke checks passed in 7.6 seconds, and served HTML,
service worker, JavaScript and CSS were byte-verified against the running
container. API and worker readiness both passed.
Desktop Chromium and WebKit passed at widths 1024, 1440 and 1920, including
unchanged reader geometry, real clipboard copying, keyboard focus, mouse drags
and progress preservation. The final affected-browser run passed 11 cases in
3.9 minutes, with one deliberate WebKit offline-emulation skip. Phone, tablet
and desktop screenshots were inspected.

Production API/worker health, served container assets, graph validity, stored
migration progress and persistent bind mounts were verified. The old application
remains unchanged. Test environments and their temporary HTTPS endpoint can be
stopped independently of production and the shared dictionary.
