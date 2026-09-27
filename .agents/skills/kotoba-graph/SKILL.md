---
name: kotoba-graph
description: Import lessons and inspect import progress, query and manage words, meanings, learning statuses, folders, and the Kotoba Studio knowledge graph through its API.
---

Run `./kotoba` from this repository. It targets production; add `--environment acceptance` only for disposable tests. `./kotoba status` checks readiness. API: `http://127.0.0.1:3010/api/v1`, also available over the app's Tailscale origin. Discover endpoints at `/api/v1/openapi.json`; discover the graph with `./kotoba schema`. Read [graph operations](../../../docs/graph-operations.md) for advanced mutations, backups, and schema changes.

## Import a lesson

Use the predefined import API. Do not construct corpus nodes yourself, run the worker directly, or use a language model during import to translate words or select meanings.

1. Write a UTF-8 JSON file with `title`, `body`, and optional `folder` and `sourceUrl`. Preserve the supplied text and line breaks.
2. Submit `./kotoba request POST /imports --file import.json`.
3. A duplicate returns `textId` immediately and attaches the requested folder. Otherwise, retain the returned `jobId` and poll `./kotoba request GET /jobs/JOB_ID` until `state` is `ready` or `failed`.
4. Report the actual `progress.stage`, `percent`, `completed`/`total` sentence counts, `elapsedSeconds`, and `estimatedRemainingSeconds`. The estimate is approximate and can be null before enough work completes. `secondsSinceProgress`, `stalled`, and `leaseExpiresAt` expose inactivity. Do not invent a percentage or ETA. `/jobs` lists recent jobs with the same details.
5. On failure, inspect `error` and `attempts`. Retry a transient failure with `POST /jobs/JOB_ID/retry`; do not keep retrying an unchanged persistent error. An expired worker lease can be recovered through this retry action. A healthy running import cannot be restarted by retry.
6. Once ready, read `result.textId`, verify `GET /texts/TEXT_ID`, and confirm its folder in `GET /texts`. Only then report that the lesson is ready.

English/Latin runs are excluded from vocabulary before dictionary lookup and again at the import API boundary; original lesson text, offsets, and phrase-selection content are preserved. Mixed Japanese spellings remain eligible.

Import performs local Ichiran tokenization and its JMdict lookup only. Ichiran uses its upstream boundaries and conjugations; do not add application grammar rules. Report cases it handles poorly. It never requests model inference, sentence translations, or pronunciation. Stages are queued, starting, dictionary, saving, validating, and ready; percentage reaches 100 only after the atomic graph write succeeds.

## Words and on-demand actions

A Word is unique by its exact spelling (`surface`), with a stable UUID. Multiple `Meaning` nodes attach through `HAS_MEANING`; dictionary alternatives are allowed and are displayed together, not treated as separate Words or claimed to be contextually selected. `BASE_FORM` links each Word to a self-linked canonical base. Reading and Listening statuses belong to that base and propagate across its forms. Meanings never split learning status. Word occurrences retain contextual readings and offsets.

- `GET /words/ID`: stored meanings, base, forms, statuses, and examples; an indexed read with no dictionary or model work. The reader opens this endpoint with the token’s `baseId`, and pronounces its base spelling via `text`.
- `POST /words/ID/meanings`: request missing meanings on demand. Existing graph meanings return immediately. Otherwise inspect the returned job through `/jobs/ID`; the worker checks the dictionary first and uses the local LLM only for a true dictionary miss. Dictionary failures are errors, not misses. Results persist as `Meaning` nodes through `HAS_MEANING`, including source provenance. Repeated requests share one job. Retry a failed job explicitly via `/jobs/ID/retry`.
- `GET /practice?textId=TEXT_ID&area=listening`: questions drawn only from that lesson, with optional `states` (all statuses by default). `POST /practice/answer` requires the same `textId`; targets outside that lesson are rejected. Practice has no global corpus mode.
- `POST /occurrences/ID/meaning` with `{"meaning":"...","reading":"...","baseForm":true}`: add a user meaning to the canonical base shown in the reader. Omit `baseForm` for a specifically requested occurrence-form meaning; identity/status stay unchanged.
- `POST /words/ID/learn`: atomically promote New to Learning in both areas, preserving Learning/Familiar/Known; returns both current statuses and revisions. This is the word-tap action.
- `PUT /words/ID/status`: area, state, and current LearningStatus revision. `/statuses/batch` handles bulk changes.
- `GET /texts/ID/completion`: preview `wordCount` (unique base families with New in either area), Text `revision`, and `fingerprint`. Explain that completion marks those families Known in both areas. Confirm through `PUT /texts/ID/status` with `{state:"completed",revision,completionFingerprint:fingerprint}`. A changed preview rejects the write; fetch a new one. Families without New stay unchanged. The same action can handle remaining New words in an already completed lesson. Setting `state:"new"` only reopens the Text and preserves word statuses.
- `POST /speech` or media URL `/speech/play?occurrenceId=...`: return cached pronunciation or lazily generate it. Sentence audio accepts `text` instead. Never pre-generate audio during imports.
- `POST /translations`: return cached sentence translation or lazily generate it on explicit request. Never pre-translate sentences during imports.
- `POST /phrase-tools/translation` with `{text,context}` or `/phrase-tools/speech` with `{text}`: fresh, temporary local inference for a user-selected phrase. Poll the returned job with `GET /jobs/ID`; results expire. Never create persistent corpus, Translation, Speech, or Job nodes for these transient tools. Native audio uses `/phrase-tools/speech/play?text=...&request=FRESH_UUID`, which supports immediate browser gesture playback. Temporary media is served with `no-store`. The reader automatically requests one translation and speech when selection finishes, with read-only output and icon replay; there are no save or regeneration controls.
- `/families/merge`: explicitly change a base-form family while retaining Words and meanings. The target family's statuses win.

Use `./kotoba query 'Cypher' --params '{...}'` for read-only graph questions, with bounded results. For changes beyond typed endpoints, prepare a parameterized transaction, run `./kotoba transaction change.json --dry-run`, inspect it, then apply. Optimistic revisions are available through `/graph/transaction`. Do not bypass API validation with a Bolt writer.

OML in [ontology/src](../../../ontology/src) is authoritative. Schema changes require compilation, a migration plan, backup, atomic schema application, and audit. Writing and daily targets are absent. Preserve v1 and its data. See the graph operations guide for migration and recovery commands.

## Remove legacy Latin vocabulary

For an authorized cleanup, run `./kotoba vocabulary-plan` and inspect counts, affected texts, and preserved families. Run `./kotoba vocabulary-apply --backup data/backups/UNIQUE_DIRECTORY --fingerprint REVIEWED_FINGERPRINT` to back up graph/schema/media before applying. The typed API is `POST /maintenance/exclude-latin-vocabulary` with `{"dryRun":true}` or `{"dryRun":false,"expectedFingerprint":"..."}`. A changed corpus rejects the plan; inspect a new plan before retrying. Verify `./kotoba audit`, unchanged lesson bodies/progress, and an empty repeat plan. No ontology change is required: this removes ineligible vocabulary and now-unowned dependencies through the validated transactional API.

## Rebuild stored tokenization

For an authorized tokenizer migration, submit `./kotoba retokenize-plan` (`POST /maintenance/retokenize/plan`). Poll the returned job and inspect `result.plan`, especially `retainedFamilies` and encounter evidence. Analysis runs outside the write transaction and makes no model calls. The plan is not an applied migration.

Apply a reviewed plan with `./kotoba retokenize-apply --job JOB_ID --fingerprint PLAN_FINGERPRINT --backup data/backups/UNIQUE_DIRECTORY`. The CLI backs up graph, schema and media before `POST /maintenance/retokenize/apply` with `{jobId,expectedFingerprint}`. A changed corpus rejects the apply; create a new plan. The validated atomic migration preserves source text, Text IDs, cursor, completion states, existing vocabulary/meanings/statuses and saved phrases. It replaces word occurrences and remaps encounter evidence without increasing encounter counts. Existing family conflicts are retained and reported rather than silently changing mastery or attaching another lemma's gloss to the retained base. Verify `/graph/audit` and a repeat plan after applying.

Persistent service data must remain under the project’s git-ignored `data/docker/` bind directories, including Neo4j data/logs, speech media and the Ichiran PostgreSQL database. Never create a Docker-managed named or anonymous volume. Database-file migration requires stopped writers and a verified copy; use `docs/graph-operations.md` for the storage map.
