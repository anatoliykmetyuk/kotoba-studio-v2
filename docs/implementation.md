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
and Reading statuses by taking the lower of New, Learning, Familiar and Known.
Display the Word's meanings together on click; never create separate Words for
different meanings of the same spelling. Learning Status has one control and no
area filters. Sentence text deduplicates; per-Text placements and token
occurrences retain original offsets.
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

There is no Writing functionality or journal migration. Daily targets, goals,
points, streaks, their UI and schema fields, and migrated goal-system records
are excluded. Ordinary reading progress and learning status remain.

## Imports and language actions

Agents import through `POST /api/v1/imports` and inspect
`GET /api/v1/jobs/{id}`. Report actual stage counts, percentage, elapsed time,
ETA when measurable, heartbeat age, and stalled/error information.
Imports use local Ichiran and dictionary lookup only, without model inference,
sentence translation or speech generation. English/Latin runs remain in source
text and phrase selection but never become standalone vocabulary.

Use unchanged upstream Ichiran boundaries, candidates and conjugation metadata.
Do not add custom splitting, merging or grammar rules. The approved fallback
retains upstream grouping when no suitable configuration exists and displays its
canonical base in the popup. Grouping ても is not a requirement. Preserve whole
inflected forms and exact source offsets, linked to their canonical bases.
Report observed upstream limitations.

Word details read stored Meaning nodes. Missing meanings consult the dictionary
first and use the local model only when no entry exists; save that fallback in
the graph. Never use a model to choose among dictionary alternatives. Sentence
translations and ordinary pronunciation are requested lazily and cached. A
selected phrase instead generates fresh temporary local translation and speech,
with no persistent corpus or media entry.

## Reading and interaction

The reader should feel like an e-book, with continuous paragraphs, modest default
type, compact paragraph spacing, and no per-sentence toolbars or “read to here”
controls. Font size and line spacing are configurable under reader options and
persist across devices. Reading progress saves automatically. Put sentence
meaning and audio in the selected-word context panel. Opening, restoring or
closing a lesson must not advance progress. A device-local viewport bookmark is independent of
monotonic furthest-read progress. Restore server-only progress at the same
viewport line used when saving it. Popup scroll locks, layout changes, and stale
query responses must not create reading activity. Explicit offline progress
queues until the server acknowledges it.

A word tap opens its canonical base, meanings, and family details, automatically
pronounces the base, and atomically promotes New to Learning without downgrading
Familiar or Known. Show the first three dictionary meanings with an explicit
expansion control. New, Learning and Familiar have distinct background highlights;
Known and Latin text are unhighlighted. Latin text has no ordinary click action.

Word and selected-phrase popups share the same `ReadingDetails` component,
heading/playback/copy controls, scroll container, and responsive overlay shell.
Word details are overlays at every viewport size. Wide-screen overlays open from
the right without changing reader width, token positions, or reading progress;
never restore a layout column for the panel. Lock background scrolling, retain
modal keyboard focus, and restore the original reading position on close.

Popup dismissal gestures accept touch input only. Hide the drag handle with a
fine mouse pointer. A downward touch swipe anywhere on a popup dismisses it only if the
gesture starts at the topmost scroll position. When it begins in scrolled content,
the entire gesture scrolls without dismissal, even if it reaches the top.
Sliders retain their own drag gestures. Popup scrolling must never scroll the
underlying lesson. Mouse dragging never dismisses a popup.
Text areas retain their own scrolling and selection gestures.
In import forms, swipes inside the text area scroll its contents; swipes on
labels or gaps outside it scroll the dialog, regardless of text-area focus or
scroll position. Only the popup's main scroll surface proxies header gestures.

Every popup button, including close, copy, and pronunciation, accepts mouse,
finger, Apple Pencil, and keyboard input, including after touch scrolling or a
canceled swipe. Clicking or tapping the backdrop dismisses word and phrase
popups on desktop and iPad without activating content behind them; dragging
does not dismiss them. Use one application-wide activation abstraction for
mouse, finger, pen, and keyboard equivalence. Components use semantic controls
and ordinary click/change handlers, without component-specific Pencil workarounds.
The shared adapter covers native actions; scrolling, text input, range dragging,
and token selection retain their native or dedicated gesture ownership.

Sticky reader controls remain below the top device safe area after scrolling.
Reserve side cutouts after rotation and keep popup controls in the safe viewport.
Verify nonzero safe-area insets, because browser presets alone report zero.
Reader settings sliders have 44px targets and stable values while holding and
releasing. Serialized saves must not roll back newer local edits and allow retry.

Mouse drag or finger/Pencil long-press drag selects contiguous tokens across
lines and sentences as a phrase. Holding a single token and releasing also keeps
its anchor selected for a later endpoint tap.
Support both gestures without a Select phrase toolbar button. Disable native OS
selection and callouts only in the reader. Phrase selection must not promote
learning status or pronounce individual tokens. Opening the selected phrase
automatically generates one read-only translation and starts speech in the
selection gesture. The popup contains only the selected text, translation/loading/
error text, close control, and the same speaker icon used for word pronunciation.
Never add editable translation fields, Save phrase, or Translate again controls.
Icon-only copy actions copy the source word/phrase and the word's contextual
sentence, without ruby annotations. Example navigation targets the exact
placement and briefly highlights it yellow, then fades.
Every visible label is strictly factual and functional. No marketing language,
slogans, punchlines, motivational copy, decorative taglines, or congratulatory
flourishes. Use direct labels, factual feedback, and only instructions needed to
operate a feature; let the layout and controls explain themselves.

## Completion and lesson practice

Completion previews the count of unique base families with New learning status.
The UI confirms against a graph-state fingerprint, marking those families Known
in the same transaction as lesson completion. Families without New
remain unchanged. Reopening is status-neutral. Already completed lessons can
explicitly mark remaining New words Known; deployment never does so implicitly.

Practice is entered within a lesson, with questions and distractors from that
Text only, and provides a return to the lesson. Answer APIs validate membership.
Practice includes Learning and Familiar words by default. New and Known words
are excluded from its questions; there is no Include all statuses control.
Sentence reconstruction retains every token in an eligible sentence. Use the
same deterministic stored dictionary ordering as word details for matching
answers, never graph relationship traversal order. Matching freshly shuffles
choices and distractors every challenge. Correct feedback is short and advances
automatically, showing the next sentence challenge immediately. Sentence
reconstruction displays its tokens and controls immediately, with a placeholder
while its English translation generates, then replaces the placeholder in place.
Never show a full preparation screen. Translation preparation reports elapsed
time, supports cancellation and bounded retry, and rechecks pending jobs when
the app returns to the foreground. Never prepare audio before showing the
challenge or block tokens and controls on translation. Audio is lazy on click;
token placement and reordering never wait for it. Generate or reuse cached sentence
and token speech only when clicked. Token pronunciations play sequentially in a
separate queue in click order and stop when advancing. Placed tokens support
drag-to-reorder through a shared component and ordinary tap activation.
Cached speech requests are read-only indexed lookups without a graph-wide audit.
Each run randomly selects at most five word questions and five sentence questions,
without repeating questions within either sample.
It shows the question number and capped total, then offers Practice again to draw
a fresh random sample. Smaller lessons use only their available questions.
Incorrect attempts stay on the current question. After the last correct answer,
show completion and an explicit Practice again action.
Incorrect sentence answers offer an optional Show correct sentence disclosure;
the correct sentence stays hidden until explicitly opened. Reset its visibility
for every attempt and challenge. No global Practice menu or corpus-wide question pool.

Settings provides Check for updates with explicit checking, current, and failure
results. Show a separate Reload to update action only when an update is ready.
The existing banner shares this state, and failed checks remain retryable.
Never reload automatically while the user is reading. Checks and updates preserve
the open session until the user chooses to reload.

## Agents and operations

`AGENTS.md`, the `kotoba-development` and `kotoba-graph` skills, OpenAPI, the JSON
CLI and OML are shipped project features. Agents import, inspect jobs, query the graph, edit
statuses and folders, correct families, and perform validated transactions through
the API. Generic mutations support dry runs and revisions. Schema administration,
backup/restore and maintenance operations are documented in `kotoba-graph`.

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

Permanent workflow requirements are in [AGENTS.md](../AGENTS.md). Implementation,
independent review, verification, and delivery procedures are in
[kotoba-development](../.agents/skills/kotoba-development/SKILL.md).
See [acceptance evidence](acceptance.md) for recorded release results and
[README.md](../README.md) for setup and system requirements.
