# Agent and operator interface

Run commands from the repository root. Output is JSON. The production API is `http://127.0.0.1:3010/api/v1`; the acceptance API uses port 3011. OpenAPI is at `/api/v1/openapi.json`. The application is intended for the owner and trusted tailnet members with access to this port. The graph API has full control of corpus data. Neo4j has no production host port; only the API connects to Bolt. Native worker endpoints additionally require a per-environment token held in a mode-0600 runtime file.

## Reading the graph

```sh
./kotoba status
./kotoba schema
./kotoba query 'MATCH (w:Word)-[:BASE_FORM]->(b)-[:STATUS]->(s) WHERE w.surface=$surface RETURN w.id,w.surface,b.id,s.area,s.state' --params '{"surface":"読んだ"}'
./kotoba query 'MATCH (t:Text)-[:PLACEMENT]->(p)-[:SENTENCE]->(s) WHERE t.textState="new" RETURN t.id,t.title,count(p) AS sentences'
./kotoba request GET '/explore?area=reading&minimum=0.8&seen=unseen&limit=50'
./kotoba audit
```

Read queries are explained before execution and must be read-only. CALL, administrative commands, and external loads are intentionally unavailable through data endpoints. Internal application queries use indexed identifiers, bounded result sets, and server-side filtering. Generic agent read results should use LIMIT for large explorations.

## Typed changes

```sh
./kotoba request PUT /words/WORD_ID/status --json '{"area":"listening","state":"known","revision":3}'
./kotoba request PUT /texts/TEXT_ID/status --json '{"state":"completed","revision":2}'
./kotoba request POST /occurrences/OCCURRENCE_ID/meaning --json '{"reading":"はし","meaning":"bridge"}'
./kotoba request POST /families/merge --json '{"sourceBaseId":"SOURCE","targetBaseId":"TARGET"}'
./kotoba request POST /imports --file import.json
./kotoba request GET /jobs/JOB_ID
```

`revision` on word status edits refers to the LearningStatus revision in the word-detail response, not the Word revision. Text revisions come from text detail. An import response contains a Text ID if deduplicated, or a durable Job ID. Poll the Job until ready/failed; failed jobs can be retried with POST `/jobs/{id}/retry`. Imports use local tokenization and JMdict only, with no model inference. Word identity is exact spelling. Multiple dictionary senses attach as Meaning nodes and appear on word click; adding a meaning preserves identity and statuses. Pronunciation and sentence translations are generated only on request, using cached results when available.

Word/phrase status writes accept `onlyIfNew: true` for an atomic conditional update. The reader uses this when opening a word so concurrent Familiar/Known changes cannot be downgraded. `/speech/play?occurrenceId=...` is a native media URL: it resolves the lazy pronunciation job and redirects to its cached WAV, preserving browser user-gesture playback permission. Agents may still use POST `/speech` to obtain a cache URL or Job ID directly.

## Generic graph transactions

A transaction file is an array of `{ "query": "...", "params": {...} }`. All statements commit together. Identity, type, creation timestamps, operational records, and revisions are managed by the service. Both property and relationship changes advance affected entity revisions. Invalid node properties, relationships, offsets, memberships, duplicate entities, or status ownership roll back the entire transaction.

```sh
./kotoba transaction change.json --dry-run
./kotoba transaction change.json
```

For optimistic concurrency, use `request POST /graph/transaction --file transaction.json` with `{ "statements": [...], "dryRun": true, "expectedRevisions": {"ENTITY_ID": 7} }`, then set `dryRun` to false after inspecting it. Plain scalar updates still validate the allowed property shape; structural changes and arbitrary agent transactions receive a full graph audit under the same writer lock. Reading/listening changes are cheap and do not traverse the corpus.

## Backups and OML evolution

```sh
./kotoba backup data/backups/before-change
./kotoba restore data/backups/before-change
uv run python scripts/compile_ontology.py
./kotoba schema-plan --transformation transform.json
./kotoba schema-apply --transformation transform.json --backup data/backups/before-schema
```

Backup includes graph JSON, schema JSON, and speech media. Restore replaces the current graph and requires the matching schema; restore the matching source revision before restoring an older schema. It preserves the service's active Schema ID. Schema transformations use the same parameterized statement format as graph transactions. The plan runs in a rolled-back transaction against the new validated OML profile. Apply stops the worker/API, uses the new image to migrate and validate atomically, then restarts them. A failed apply keeps the API stopped for investigation and retains the backup. Do not change an ontology digest by hand to silence a mismatch.

The compiler deliberately supports a documented OML subset and rejects unsupported constructs. See [ontology profile](../ontology/README.md) before extending it.

## Inspectable import action

Submit `POST /imports` with `{ "title": "Lesson", "body": "猫を見ました。", "folder": "Japanese" }`. Poll `GET /jobs/{jobId}`. Both this endpoint and `GET /jobs` expose title, state, attempts, error, result, and progress:

- `stage`: queued, starting, dictionary, saving, validating, ready, or failed.
- `completed` / `total`: sentences processed in the current work stage.
- `percent`: combined dictionary and saving work, capped below 100 until validation and commit finish.
- `elapsedSeconds`, `estimatedRemainingSeconds`: elapsed wall time and approximate remaining time based on measured throughput. ETA is null before measurable progress, while queued, or when stalled.
- `updatedAt`, `secondsSinceProgress`, `stalled`, `leaseExpiresAt`: diagnose inactivity. A stalled flag means no update for 30 seconds, not proof of failure.

`POST /jobs/{id}/retry` accepts failed/pending jobs and running jobs with an expired lease, retaining the same idempotent import identity. A successful result contains `textId`. Never report completion from a 202 response alone. Detailed progress is stored in the operational Job result; saving counters are visible while its atomic transaction runs and are persisted on completion. API restart can briefly lose live saving counters; the worker lease recovers the entire dictionary-only action.

To upgrade the old meaning-specific corpus, use `./kotoba schema-plan --migration spelling-identity`, then `./kotoba schema-apply --migration spelling-identity --backup data/backups/before-spelling-identity`. The migration merges duplicate spellings and connected base families, preserves all glosses and occurrences, and keeps the most advanced status independently for each area. Original IDs and status values are recorded in the migration evidence.

## Legacy Latin vocabulary cleanup

`./kotoba vocabulary-plan` reports eligible removals and a corpus fingerprint without applying changes. `./kotoba vocabulary-apply --backup data/backups/UNIQUE_DIRECTORY --fingerprint REVIEWED_FINGERPRINT` saves graph, schema and media, verifies that the corpus is unchanged, and applies the validated transaction. The corresponding typed action is `POST /maintenance/exclude-latin-vocabulary`, with `dryRun` and, for apply, `expectedFingerprint`. Original Text/Sentence bodies, offsets and surviving Japanese family statuses are preserved. Run `./kotoba audit` and a repeat plan afterward.


## Persistent storage

Persistent Docker data uses bind mounts inside the repository, never Docker-managed named or anonymous volumes:

| Service data | Directory |
| --- | --- |
| Production Neo4j data/logs and speech media | `data/docker/production/{neo4j,neo4j-logs,media}` |
| Acceptance Neo4j data/logs and speech media | `data/docker/acceptance/{neo4j,neo4j-logs,media}` |
| Development Neo4j data/logs | `data/docker/development/{neo4j,neo4j-logs}` |
| Ichiran PostgreSQL dictionary | `data/docker/ichiran/postgresql` |

`data/` and `.runtime/` are ignored by Git. The CLI resolves these paths relative to this repository. The PostgreSQL bind covers its image-declared parent volume as well as PGDATA; Neo4j explicitly binds both `/data` and `/logs`. Verify every project container with `docker inspect` after introducing another service. Database file copies require stopped writers; compare file contents before starting the replacement. Use the graph/media backup commands above for application-level backups.

Explicit `PUT /texts/ID/status` with `state: completed` marks families that have New in either area Known in both. The reader previews a count and submits the resulting `completionFingerprint`; API clients can use the same `GET /texts/ID/completion` guard. The guard is optional for an explicitly requested direct completion action. Setting Text state to New preserves vocabulary statuses.
