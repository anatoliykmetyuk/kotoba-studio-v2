# Implementation contract

Kotoba Studio is a local Japanese corpus reader built with React, TypeScript,
Vite, TanStack Query, FastAPI and Neo4j Community. A native Apple Silicon worker
runs local translation and speech. The shared Ichiran service supplies stock
segmentation, conjugation analysis and dictionary meanings. Production uses
loopback HTTP and trusted Tailscale HTTPS on custom port 3010.

## Corpus and ontology

OML in `ontology/src` is authoritative. Official openCAESAR tooling compiles and
validates it; the generated contract drives database constraints and transactional
validation. Structural and generic agent mutations validate the complete graph.
Bounded scalar changes validate affected entities without scanning the corpus.

A Word has a stable UUID and unique exact spelling. Meanings are separate nodes
with source provenance, including multiple dictionary alternatives. Every Word
links to a canonical base Word, which links to itself. One Learning Status
belongs to that base and is shared by all its forms. Migrate existing Listening
and Reading statuses by taking the lower of New, Learning, Familiar and Known. Sentence text
deduplicates; per-Text placements and token occurrences retain original offsets.
Identical content and identities deduplicate. Texts independently track New or
Completed and their furthest reading position.

Folder names are unique and editable in place through graph queries. Lesson
ingestion does not create folders or assign membership. Imports save
unfiled in All texts; agents and the UI folder selector attach them afterward
in a separate graph transaction. Folder selection lists existing folders only,
including empty folders.
Pending filing survives dialog dismissal and reload. Independent browser storage
entries prevent tabs from overwriting accepted requests; terminal records prevent
completed or dismissed requests from resurfacing after stale writes or legacy
queue recovery.
Filing failure must not undo the imported lesson. Duplicate folder names fail
import preflight before any lesson work. The broader ontology refactor is deferred.
Library order is creation time, newest first; reading and organization edits do
not move older lessons ahead of newer imports.

There is no Writing functionality, journal migration, daily target, point,
streak or related goal-system record.

## Imports and language actions

All imports use the predefined API and inspectable jobs. Report actual stage,
counts, percentage, elapsed time, ETA when measurable, heartbeat age and errors.
Imports use local Ichiran and dictionary lookup only, without model inference,
sentence translation or speech generation. English/Latin runs remain in source
text and phrase selection but never become standalone vocabulary.

Use unchanged upstream Ichiran boundaries, candidates and conjugation metadata.
Do not add custom splitting, merging or grammar rules. The approved fallback
retains upstream grouping when no suitable configuration exists and displays its
canonical base in the popup. Report observed upstream limitations.

Word details read stored Meaning nodes. Missing meanings consult the dictionary
first and use the local model only when no entry exists; save that fallback in
the graph. Never use a model to choose among dictionary alternatives. Sentence
translations and ordinary pronunciation are requested lazily and cached. A
selected phrase instead generates fresh temporary translation and speech, with
no persistent corpus or media entry.

## Reading and interaction

The reader uses continuous paragraphs, modest configurable type and line
spacing, and automatic position saving. Opening, restoring or closing a lesson
must not advance progress. A device-local viewport bookmark is independent of
monotonic furthest-read progress. Explicit offline progress queues until the
server acknowledges it.

A word tap opens its canonical base, automatically pronounces it, and promotes
New to Learning without downgrading Familiar or Known. Show the first three dictionary meanings with an expansion
control. New, Learning and Familiar have distinct highlights; Known and Latin
text are unhighlighted. Latin text has no ordinary click action.

Word and phrase popups share one responsive overlay component. Desktop overlays
must preserve reader geometry. Mobile dismissal accepts a downward touch gesture
only when it starts at the scroll top; otherwise the complete gesture scrolls.
Mouse dragging never dismisses a popup. Close controls accept mouse, touch, pen
and keyboard input; a completed touch gesture must not block a subsequent pen tap.
Clicking or tapping the backdrop dismisses the overlay without activating lesson
content behind it. Lock background scrolling, retain keyboard focus and preserve
safe areas. Settings sliders have 44px targets and stable
hold/release behavior; serialized saves preserve newer edits and allow retry.

Mouse drag or finger/Pencil long-press drag selects a phrase. Holding a single
token and releasing also keeps its anchor selected for a later endpoint tap.
Support both gestures without a toolbar mode button or native OS text selection. Phrase output is read-only, with automatic translation,
autoplay and the ordinary speaker icon. No Save or Translate again control.
Icon-only copy actions copy the source word/phrase and the word's contextual
sentence. Example navigation highlights its destination briefly, then fades.
Every visible label is factual and functional.

## Completion and lesson practice

Completion previews the count of unique base families with New learning status.
The UI confirms against a graph-state fingerprint, marking those families Known
in the same transaction as lesson completion. Families without New
remain unchanged. Reopening is status-neutral. Already completed lessons can
explicitly mark remaining New words Known; deployment never does so implicitly.

Practice is entered within a lesson, with questions and distractors from that
Text only. Answer APIs validate membership. Practice includes Learning and Familiar words by default. New and Known words
are excluded from its questions; there is no Include all statuses control.
Sentence reconstruction retains every token in an eligible sentence. Matching shuffles answers and
alternatives every challenge. Correct feedback advances automatically. Sentence
reconstruction displays its tokens and controls immediately, with a placeholder
while its English translation generates. Audio is lazy on click, and token
placement never waits for it. Token pronunciations queue
in click order and stop when advancing. Placed tokens can be reordered by drag.
Each run randomly selects at most five word questions and five sentence questions.
It shows the question number and capped total, then offers Practice again to draw
a fresh random sample. Smaller lessons use only their available questions.
Incorrect sentence answers offer an optional Show correct sentence disclosure;
the correct sentence stays hidden until explicitly opened. No global Practice menu.

Settings exposes manual app-update checks with explicit results and a separate
Reload to update action for a ready update. The banner shares this state. Checks
and updates preserve the open session until the user chooses to reload.

## Agents and operations

`AGENTS.md`, `.agents/skills/kotoba-graph/SKILL.md`, OpenAPI, the JSON CLI and OML
are shipped project features. Agents import, inspect jobs, query the graph, edit
statuses and folders, correct families, and perform validated transactions through
the API. Generic mutations support dry runs and revisions. Schema administration,
backup/restore and maintenance operations are documented in the skill.

Existing-corpus retokenization is a reviewable job followed by a fingerprint-
guarded atomic apply with a backup. Preserve Text IDs, original content, cursors,
completion states, existing Words, meanings and learning statuses. Remap encounter
evidence without increasing counts. Retain and report conflicting saved families
instead of silently changing their mastery.
Explicit family-repair inputs may redirect a stored noncanonical form when all
upstream occurrences agree. Preserve its UUID and source placements. A new base
copies the previous family status; an existing canonical base keeps its status.
Reject canonical-root moves and conflicting analysis or inherited statuses.

All project-owned persistent data lives in git-ignored `data/` or `.runtime/`.
Neo4j authentication is disabled for the local installation. Production Browser
and Bolt use persistent loopback-only ports 17474 and 17688, respectively.
Docker services use project-local bind directories, including image-declared
storage paths. Production, acceptance and development are separate. Move database
files only with stopped writers and verified copies. Keep the old application
and its data read-only. Never publish credentials, corpus, audio, databases,
backups or private development history.

## Verification and delivery

Use isolated real services and synthetic fixtures. Test mobile Chromium, phone
WebKit and iPad WebKit in both orientations over trusted Tailscale HTTPS, plus
wide desktop overlays. Verify actual media progression, gestures, persistence,
nonzero safe-area insets, service-worker updates and real outage recovery. Inspect
screenshots. State browser-emulation and physical-device limitations accurately.
Browser acceptance runs silently, including additional tabs and standalone app
windows. Tests retain native decoding, playback progression and ended events and
verify that generated audio contains a signal.

Fresh-context reviewers examine correctness, architecture, ontology/database
practice and query efficiency at important checkpoints. Keep review and optional
refactoring within 20% of effort. Continue until requested implementation,
verification and deployment are complete. See `docs/acceptance.md` for recorded
release evidence and `README.md` for setup and system requirements.
