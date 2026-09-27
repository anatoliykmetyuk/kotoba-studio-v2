# Kotoba Studio

A local Japanese reading application with an OML ontology and a Neo4j knowledge graph. Import a lesson, tap words to see their base forms and meanings, select phrases by dragging, and practice the content of that lesson. Listening and Reading statuses are shared across a word's forms.

Ichiran supplies tokenization and dictionary meanings without custom segmentation rules. Imports make no language-model calls. Sentence translation and pronunciation are generated on demand; a local language model supplies a saved word meaning only when the dictionary has no entry. The reader supports adjustable type and spacing, mobile touch controls, and installation as a PWA. Writing journals, daily targets, points, and streaks are absent.

## System requirements

- **Apple Silicon Mac running macOS.** The speech worker uses MLX/Metal; Windows, Linux, and Intel Mac speech execution are not implemented or validated.
- **Memory:** 24 GB or more recommended for the default 9B language model, speech worker, Docker services, and macOS together. This is a planning recommendation, not a measured minimum. Allow Docker roughly 6 GB of memory.
- **Storage:** allow at least 25 GB free for model downloads, dictionary data, Docker images, and database growth. Backups need additional space.
- **Python 3.11**, [uv](https://docs.astral.sh/uv/), **Node.js 24** and npm, Git, and a running **Docker Desktop** with Docker Compose supporting `!override` (2.24.4 or newer).
- [Ollama](https://ollama.com/) running locally with [`qwen3.5:9b-mlx`](https://ollama.com/library/qwen3.5:9b-mlx).
- [Tailscale](https://tailscale.com/) on the Mac and mobile devices for trusted HTTPS/PWA access. Java 21 is needed only when rebuilding the ontology.

Initial setup needs internet access for dependencies, images, and model/dictionary downloads. Inference and application data remain local at runtime.

## Set up from scratch

Clone this repository and run the following in its root:

```sh
git clone https://github.com/anatoliykmetyuk/kotoba-studio-v2.git
cd kotoba-studio-v2
uv sync --python 3.11 --all-groups
npm ci
uv run python scripts/prepare_models.py
```

The model preparation script downloads a pinned [Kokoro speech model](https://huggingface.co/mlx-community/Kokoro-82M-bf16) and the upstream [UniDic speech dictionary](https://github.com/polm/unidic-py). Assets and download caches stay inside the project under `data/` and `.venv/`. UniDic is used only by Japanese speech synthesis; the reader's tokenizer is Ichiran. To reuse downloaded assets without modifying their originals:

```sh
uv run python scripts/prepare_models.py \
  --kokoro-source /path/to/Kokoro-82M-bf16 \
  --unidic-source /path/to/unidic/dicdir
```

If you already run Ollama locally, keep that service and install the required model with `ollama pull qwen3.5:9b-mlx`. For a new Ollama installation, keep its model files inside this project by starting it in a separate terminal:

```sh
mkdir -p data/models/ollama
OLLAMA_MODELS="$PWD/data/models/ollama" ollama serve
```

Then, in the project terminal:

```sh
ollama pull qwen3.5:9b-mlx
./kotoba start
./kotoba status
```

`start` builds and starts Neo4j, the API, the web server, the shared Ichiran dictionary service, and the native inference worker. The first Ichiran start downloads and verifies a dictionary snapshot and restores several gigabytes of PostgreSQL data; allow several minutes. Later starts reuse those files. Details and pinned versions are in [services/ichiran](services/ichiran/README.md).

Open **http://127.0.0.1:3010** on the Mac. A fresh installation has an empty library. Use **Import text** to add Japanese content you supply. Clicking a New word promotes it to Learning in both areas. Completing a lesson previews the number of remaining New word families and marks them Known in both areas after confirmation. Practice is available within each lesson.

## Mobile access and PWA installation

Enable MagicDNS and HTTPS certificates in your Tailscale network, then configure trusted HTTPS on custom port **3010**:

```sh
tailscale serve --bg --https=3010 http://127.0.0.1:3010
```

Open the HTTPS URL printed by Tailscale on your phone while connected to the same tailnet. On iPhone, use Safari's **Share > Add to Home Screen**; on Android, use the browser's install action. The app has a web manifest, icons, a service worker, cached reading, queued reading-progress recovery, and a Reload control when an update is available. New imports, uncached translations, and uncached pronunciation require the Mac to be running.

Use the Tailscale hostname with its trusted certificate. No self-signed certificate or certificate-warning bypass is needed. The app uses custom HTTPS port 3010 and binds upstream HTTP to loopback; it does not occupy HTTPS port 443. This is a single-user application with powerful graph-mutation APIs for trusted agents. Keep it on localhost or a tailnet restricted to authorized devices, not the public internet.

## Storage and operations

All project-owned persistent Docker storage is in git-ignored project directories:

| Data | Location |
| --- | --- |
| Production Neo4j graph and logs | `data/docker/production/neo4j`, `data/docker/production/neo4j-logs` |
| Production cached speech | `data/docker/production/media` |
| Isolated acceptance graph, logs, and media | `data/docker/acceptance/` |
| Disposable development database and logs | `data/docker/development/` |
| Ichiran PostgreSQL dictionary | `data/docker/ichiran/postgresql/` |
| Speech models and download caches | `data/models/`, `data/cache/` |
| Runtime credentials and native-worker logs | `.runtime/<environment>/` |
| Backups | `data/backups/` |

There are no Docker-managed named or anonymous persistent volumes. Credentials are generated on first start in `.runtime/production/environment.json` with mode 0600. Do not commit that file or any contents of `data/` or `.runtime/`.

```sh
./kotoba status
./kotoba audit
./kotoba backup data/backups/before-change
./kotoba worker-restart
./kotoba stop
```

`stop` stops that app environment and its worker. The shared Ichiran service remains running; stop it separately with `docker compose -p kotoba-v2-ichiran -f compose.ichiran.yaml stop` if needed. Run `./kotoba start` after restarting the Mac to relaunch the native worker. Docker services restart while Docker Desktop is running. Tailscale Serve has its own persistent configuration.

To restore an application backup, use `./kotoba restore data/backups/before-change`; it replaces that environment's graph and restores its media. Stop database writers before copying raw database files. See [graph operations](docs/graph-operations.md) for guarded migrations, backups, and schema changes.

## Agent access

Agent access is a supported project feature. These files are included in version control:

- [AGENTS.md](AGENTS.md): project constraints and workflow instructions.
- [Database-management skill](.agents/skills/kotoba-graph/SKILL.md): imports, progress inspection, graph queries and changes, learning statuses, lazy language actions, backups, and migrations.
- [Graph operations](docs/graph-operations.md) and [OpenAPI contract](docs/openapi.json).
- [OML ontology](ontology/src/) and its [database mapping](ontology/README.md).

Use predefined API actions instead of bypassing validation with direct database writes. Live API documentation is at `/api/v1/docs`; the machine-readable contract is `/api/v1/openapi.json`.

```sh
./kotoba schema
./kotoba request POST /imports --file lesson.json
./kotoba request GET /jobs/JOB_ID
./kotoba query 'MATCH (t:Text) RETURN t.id, t.title LIMIT 20'
```

`lesson.json` contains `title`, `body`, and optionally `folder` and `sourceUrl`. Imports expose stage, processed/total sentence counts, percentage, elapsed time, estimated remaining time, and errors. The skill documents both standard actions and validated graph transactions.

## Development and verification

```sh
# Start the isolated development database, using project-local bind directories.
KOTOBA_WORKER_TOKEN=dev-only docker compose -p kotoba-v2-dev \
  -f compose.yaml -f compose.dev.yaml up -d neo4j
KOTOBA_TEST_DATABASE=disposable uv run pytest -q
npm run build

# Separate acceptance data and upstream port 3011.
./kotoba --environment acceptance start
tailscale serve --bg --https=8443 http://127.0.0.1:3011
export KOTOBA_TEST_BASE_URL=https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8443
export KOTOBA_ACCEPTANCE_ORIGIN="$KOTOBA_TEST_BASE_URL"
npx playwright install chromium webkit
npx playwright test
```

Python integration tests reset only the explicitly enabled development database on loopback port 17687. Browser tests use isolated acceptance data. Some older end-to-end scenarios expect an imported legacy corpus; the lesson-practice, reader-selection, word-overlay, settings-gesture, safe-area, and reading-position suites create their own lesson fixtures. Live-model checks require `KOTOBA_LIVE_MODELS=1`. Service-worker update tests require `KOTOBA_PWA_UPDATE=1` and exclusive access to the acceptance web container. Settings outage/retry checks require `KOTOBA_SETTINGS_OUTAGE=1`, `KOTOBA_ACCEPTANCE_ORIGIN` and exclusive access to the acceptance API.

The browser matrix covers phone Chromium, phone WebKit, iPad WebKit, and desktop overlays. Mobile configurations cover portrait and landscape. These are browser emulations, not physical-device tests. WebKit offline emulation has a documented service-worker limitation; it is not reported as passing when skipped. See [acceptance evidence](docs/acceptance.md).

To rebuild the ontology, install Java 21 and run `uv run python scripts/compile_ontology.py`. OML is authoritative; graph writes are transactionally checked against its generated contract.

## Optional legacy migration

A fresh installation does not need the previous application. To migrate its database, supply explicit source paths:

```sh
uv run python -m cli.migrate \
  --source /path/to/old-app/data/studio.sqlite3 \
  --legacy-python /path/to/old-app/.venv/bin/python \
  --output data/migration \
  --apply-url http://127.0.0.1:3010
```

The source is read-only. Migration validates the graph and requires an empty destination. Writing journals, goals, points, and daily targets are excluded. Rebuilding stored tokenization later uses a reviewable plan, backup, fingerprint guard, and atomic apply as documented in the agent skill.

## Dictionary sources

Japanese-English dictionary data is provided by James William Breen and the
Electronic Dictionary Research and Development Group (EDRDG) through JMdict,
under CC BY-SA 4.0. [Attribution, documentation and licence copies](public/licenses/)
are included in the application and dictionary image. Settings links to these
sources. See the [Ichiran service guide](services/ichiran/README.md) for pinned
versions and the supported dictionary-update procedure.
