---
name: kotoba-graph
description: Import lessons and inspect import progress, query and manage words, meanings, learning statuses, folders, and the Kotoba Studio knowledge graph through its API.
---

Run `./kotoba` from this repository. It targets production; add `--environment acceptance` only for disposable tests. `./kotoba status` checks readiness. API: `http://127.0.0.1:3010/api/v1`, also available over the app's Tailscale origin. Discover endpoints at `/api/v1/openapi.json`; discover the graph with `./kotoba schema`. Read [graph operations](../../../docs/graph-operations.md) for advanced mutations, backups, and schema changes.

## Import a lesson

Use the predefined import API. Do not construct corpus nodes yourself, run the worker directly, or use a language model during import to translate words or select meanings.

1. Write a UTF-8 JSON file with `title`, `body`, and optional `sourceUrl`. Preserve the supplied text and line breaks. Do not pass a folder name or folder ID. The deprecated `folder` field is accepted from old clients but ignored; import never assigns membership. Import checks for duplicate folder names before queuing any lesson work.
2. Submit `./kotoba request POST /imports --file import.json`.
3. A duplicate returns `textId` immediately without changing memberships. Otherwise, retain the returned `jobId` and poll `./kotoba request GET /jobs/JOB_ID` until `state` is `ready` or `failed`.
4. Report the actual `progress.stage`, `percent`, `completed`/`total` sentence counts, `elapsedSeconds`, and `estimatedRemainingSeconds`. The estimate is approximate and can be null before enough work completes. `secondsSinceProgress`, `stalled`, and `leaseExpiresAt` expose inactivity. Do not invent a percentage or ETA. `/jobs` lists recent jobs with the same details.
5. On failure, inspect `error` and `attempts`. Retry a transient failure with `POST /jobs/JOB_ID/retry`; do not keep retrying an unchanged persistent error. An expired worker lease can be recovered through this retry action. A healthy running import cannot be restarted by retry.
6. Once ready, read `result.textId` and verify `GET /texts/TEXT_ID` and `GET /texts`. A newly imported lesson has no folder and is visible in the home Library under All texts. Verify source provenance when supplied.
7. If the user requested a folder, attach the saved Text yourself with a separate graph transaction, as below. Verify membership afterward. If filing fails, retain the imported lesson and correct only the filing operation; never roll back, delete, or reimport the lesson because folder assignment failed.

English/Latin runs are excluded from vocabulary before dictionary lookup and again at the import API boundary; original lesson text, offsets, and phrase-selection content are preserved. Mixed Japanese spellings remain eligible.

Import performs local Ichiran tokenization and its JMdict lookup only. Ichiran uses its upstream boundaries and conjugations; do not add application grammar rules. Report cases it handles poorly. It never requests model inference, sentence translations, or pronunciation. Stages are queued, starting, dictionary, saving, validating, and ready; percentage reaches 100 only after the atomic graph write succeeds.

## Agent graph operations

Rule of thumb: if an API exists for the requested action, use that API. If no
API exists for it, execute queries directly against the graph database through
the existing query/transaction interface.

Use graph queries directly for ordinary data management authorized by the user
when no standardized API covers that action.
Do not create a new typed endpoint, UI control, or script for each trivial graph
operation. Standardized APIs encode standardized workflows such as lesson
ingestion, learning transitions, translation and pronunciation. They are not a
requirement to encode every possible graph edit.

Use `./kotoba query` for reads and `./kotoba transaction` for parameterized Cypher
writes. These execute graph queries with the existing transactional conformance
checks. Inspect the exact targets, dry-run, then apply. Do not ask the user again
for permission for ordinary queries/edits already covered by their request.
An unsupported typed endpoint is not a blocker: use the graph transaction.

Folder names are unique, ignoring surrounding whitespace and case. Identify the
folder by its current name. Never derive or look up an `identityKey` from that
name. The current schema still carries legacy IDs; preserve those during an
in-place edit until the separately planned ontology refactor.

Rename the same folder node:
```cypher
MATCH (f:Folder {name:$oldName})
SET f.name=$newName
RETURN f.name
```

Attach an already imported lesson independently:
```cypher
MATCH (f:Folder {name:$folderName}), (t:Text {id:$textId})
MERGE (f)-[:CONTAINS]->(t)
RETURN f.name, t.id
```

Require exactly one target folder before filing. Zero matches means the requested
folder is missing; multiple matches are a data error, never permission to pick
one. Inspect returned rows and verify the saved membership. Creating a folder,
when requested, is also a graph operation and must satisfy the current schema.
Never replace a folder or move its lessons merely to rename it. A conflicting
name must fail atomically. Graph edits leave Text bodies and reading progress alone.

## Words and on-demand actions

A Word is unique by its exact spelling (`surface`), with a stable UUID. Multiple `Meaning` nodes attach through `HAS_MEANING`; dictionary alternatives are allowed and are displayed together, not treated as separate Words or claimed to be contextually selected. `BASE_FORM` links each Word to a self-linked canonical base. One Learning Status belongs to that base and propagates across its forms. Existing Reading and Listening values migrate to the lower state in New, Learning, Familiar, Known order. Meanings never split learning status. Word occurrences retain contextual readings and offsets.

- `GET /words/ID`: stored meanings, base, forms, single `status`, and examples; an indexed read with no dictionary or model work. The reader opens this endpoint with the token’s `baseId`, and pronounces its base spelling via `text`.
- `POST /words/ID/meanings`: request missing meanings on demand. Existing graph meanings return immediately. Otherwise inspect the returned job through `/jobs/ID`; the worker checks the dictionary first and uses the local LLM only for a true dictionary miss. Dictionary failures are errors, not misses. Results persist as `Meaning` nodes through `HAS_MEANING`, including source provenance. Repeated requests share one job. Retry a failed job explicitly via `/jobs/ID/retry`.
- `GET /practice?textId=TEXT_ID`: questions drawn only from that lesson, with optional `states` (Learning and Familiar by default). `POST /practice/answer` requires the same `textId`; targets outside that lesson are rejected. Practice has no global corpus mode.
- `POST /occurrences/ID/meaning` with `{"meaning":"...","reading":"...","baseForm":true}`: add a user meaning to the canonical base shown in the reader. Omit `baseForm` for a specifically requested occurrence-form meaning; identity/status stay unchanged.
- `POST /words/ID/learn`: atomically promote New to Learning, preserving Learning/Familiar/Known; returns the single status and revision. This is the word-tap action.
- `PUT /words/ID/status`: state and current LearningStatus revision. Deprecated area request fields are accepted for installed clients but address the same single status. `/statuses/batch` handles bulk changes.
- `GET /texts/ID/completion`: preview `wordCount` (unique base families with New learning status), Text `revision`, and `fingerprint`. Explain that completion marks those families Known. Confirm through `PUT /texts/ID/status` with `{state:"completed",revision,completionFingerprint:fingerprint}`. A changed preview rejects the write; fetch a new one. Families without New stay unchanged. The same action can handle remaining New words in an already completed lesson. Setting `state:"new"` only reopens the Text and preserves word statuses.
- `POST /speech` or media URL `/speech/play?occurrenceId=...`: return cached pronunciation or lazily generate it. Sentence audio accepts `text` instead. Never pre-generate audio during imports.
- `POST /translations`: return cached sentence translation or lazily generate it on explicit request. Never pre-translate sentences during imports.
- `POST /phrase-tools/translation` with `{text,context}` or `/phrase-tools/speech` with `{text}`: fresh, temporary local inference for a user-selected phrase. Poll the returned job with `GET /jobs/ID`; results expire. Never create persistent corpus, Translation, Speech, or Job nodes for these transient tools. Native audio uses `/phrase-tools/speech/play?text=...&request=FRESH_UUID`, which supports immediate browser gesture playback. Temporary media is served with `no-store`. The reader automatically requests one translation and speech when selection finishes, with read-only output and icon replay; there are no save or regeneration controls.
- `./kotoba schema-plan --migration learning-status` previews the compiled ontology migration. Apply it with `schema-apply --migration learning-status --backup data/backups/UNIQUE_DIRECTORY`; the source fingerprint is checked under the writer lock. The migration preserves word/lesson IDs, source text, reading progress and encounters, retains one status UUID, takes the lower state and advances its revision past both legacy revisions.
- `/families/merge`: explicitly change a base-form family while retaining Words and meanings. The target family's statuses win.

Use `./kotoba query 'Cypher' --params '{...}'` for read-only graph questions, with bounded results. For changes beyond typed endpoints, prepare a parameterized transaction, run `./kotoba transaction change.json --dry-run`, inspect it, then apply. Optimistic revisions are available through `/graph/transaction`. Do not bypass API validation with a Bolt writer.

OML in [ontology/src](../../../ontology/src) is authoritative. Schema changes require compilation, a migration plan, backup, atomic schema application, and audit. Writing and daily targets are absent. Preserve v1 and its data. See the graph operations guide for migration and recovery commands.

## Remove legacy Latin vocabulary

For an authorized cleanup, run `./kotoba vocabulary-plan` and inspect counts, affected texts, and preserved families. Run `./kotoba vocabulary-apply --backup data/backups/UNIQUE_DIRECTORY --fingerprint REVIEWED_FINGERPRINT` to back up graph/schema/media before applying. The typed API is `POST /maintenance/exclude-latin-vocabulary` with `{"dryRun":true}` or `{"dryRun":false,"expectedFingerprint":"..."}`. A changed corpus rejects the plan; inspect a new plan before retrying. Verify `./kotoba audit`, unchanged lesson bodies/progress, and an empty repeat plan. No ontology change is required: this removes ineligible vocabulary and now-unowned dependencies through the validated transactional API.

## Rebuild stored tokenization

For an authorized tokenizer migration, submit `./kotoba retokenize-plan` (`POST /maintenance/retokenize/plan`). Poll the returned job and inspect `result.plan`, especially `retainedFamilies` and encounter evidence. Analysis runs outside the write transaction and makes no model calls. The plan is not an applied migration.

To repair an explicitly identified stored form's family, add repeatable `--repair-family SPELLING` arguments, or submit `{"familyRepairs":["SPELLING"]}` to the plan API. Inspect `repairedFamilies` and its status policy. Each form must have one consistent upstream root across its stored occurrences. A new root copies the previous family's status; an existing canonical target retains its own status. Canonical-root moves, inconsistent analysis and conflicting status values for a shared new root are rejected. Other family conflicts remain reported and unchanged.

Apply a reviewed plan with `./kotoba retokenize-apply --job JOB_ID --fingerprint PLAN_FINGERPRINT --backup data/backups/UNIQUE_DIRECTORY`. The CLI backs up graph, schema and media before `POST /maintenance/retokenize/apply` with `{jobId,expectedFingerprint}`. A changed corpus rejects the apply; create a new plan. The validated atomic migration preserves source text, Text IDs, cursor, completion states, existing vocabulary/meanings/statuses and saved phrases. It replaces word occurrences and remaps encounter evidence without increasing encounter counts. Existing family conflicts are retained and reported rather than silently changing mastery or attaching another lemma's gloss to the retained base. Verify `/graph/audit` and a repeat plan after applying.

Persistent service data must remain under the project’s git-ignored `data/docker/` bind directories, including Neo4j data/logs, speech media and the Ichiran PostgreSQL database. Never create a Docker-managed named or anonymous volume. Database-file migration requires stopped writers and a verified copy; use `docs/graph-operations.md` for the storage map.
