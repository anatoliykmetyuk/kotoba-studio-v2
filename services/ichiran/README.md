# Local Ichiran service

Run the shared dictionary once, independently of the production and acceptance
application projects:

```sh
docker compose -p kotoba-v2-ichiran -f compose.ichiran.yaml up -d --build --wait --wait-timeout 900
curl --fail http://127.0.0.1:8091/health
```

The initial build downloads a checksum-verified 200 MB PostgreSQL dictionary
snapshot and restores roughly 4 GB of tables and indexes. Subsequent starts reuse
the project-local `data/docker/ichiran/postgresql` bind directory. Never delete that directory as a
routine restart. PostgreSQL is not published to the host. The HTTP service binds
to host loopback only. Override `KOTOBA_ICHIRAN_PORT` when running another isolated
copy and set `KOTOBA_ICHIRAN_URL` for its client.

Native workers use `http://127.0.0.1:8091`; container API deployments use
`http://host.docker.internal:8091` through `compose.yaml`. The service must be
healthy before starting an import or a word dictionary lookup. Service errors
fail the job instead of manufacturing a dictionary miss or invoking a model.

`POST /analyze` and `POST /dictionary` accept JSON `{"text":"..."}`. Analysis
returns original Unicode code-point offsets and Ichiran's gloss/conjugation
objects. Dictionary lookup returns an explicit `entries` array, including an
empty array only on an actual miss. A persistent Lisp process retains dictionary
caches, serializes analysis to protect upstream mutable state, and loads the
upstream suffix cache before its health endpoint becomes available. Requests are
limited to 20,000 code points for analysis and 512 for dictionary lookup.

Segmentation, compounds, primary lexical heads, conjugations, candidate ordering,
and dictionary glosses come from upstream Ichiran without application grammar
rules. The transport applies upstream normalization tables while preserving
original source offsets. The Python adapter excludes Latin runs as required by
the application's vocabulary policy, keeps full source spellings, follows
upstream primary-head/conjugation metadata for the base, and formats glosses for
the existing Meaning contract. It does not split or merge Ichiran tokens.

Pinned sources:

- [Ichiran](https://github.com/tshatrov/ichiran), revision `ea9583368e67cad22d94abae8dbcc8df96d99bcd` (MIT).
- [Dictionary release](https://github.com/tshatrov/ichiran/releases/tag/ichiran-260118), SHA-256 `98a44e2cc88a65677da8b1f7124e7d6c904253eb1aae0ef16d2c7cc1dacdba82`.
- [JMdictDB](https://gitlab.com/yamagoya/jmdictdb), revision `c9c82328d0ba5b15c496c4a32116da105be29e4c`.
- Quicklisp distribution `2026-01-01`; bootstrap checksum is in `Dockerfile.ichiran`.

Dictionary content derives from [JMdict/EDRDG](https://www.edrdg.org/jmdict/j_jmdict.html).
Keep its upstream attribution and licensing with distributed dictionary images.
MeCab, fugashi, UniDic and Jamdict are not used for corpus analysis. The optional
Kokoro Japanese speech dependencies still include fugashi/UniDic for speech.

## Upstream token granularity

The pinned CLI exposes output formats and the number of ranked segmentations
(`--limit`), but no setting that separates grammatical compounds while retaining
other compounds. `dict-segment` has only the corresponding `limit` option.
Native component records describe lexical parts, sometimes expanded from
contractions, and lack their own source offsets. They are metadata, not a
separate source-token mode.

Actual local outputs include `食べた → 食べる`, `決めてる → 決める`, dictionary
expression `にとって → にとって`, and upstream compound
`譲り合ってても → 譲り合う`. The last remains one token under the explicitly
accepted unchanged-upstream fallback. The adapter does not introduce a rule for
`ても` or other grammatical constructions. Standalone digits remain nonword
text, and upstream may split `ねえ` as `ね` and `え`.

Meaning source keys preserve upstream dictionary sequence IDs and original sense
ordinals (`jmdict:<sequence>:<ordinal>`), including the original sequence for
conjugated forms, so stored Meaning display order follows the dictionary.

## Dictionary attribution and updates

The Japanese-English dictionary is copyright James William Breen and EDRDG,
licensed under [CC BY-SA 4.0](../../public/licenses/CC-BY-SA-4.0.txt).
[Notices, documentation and the licence statement](../../public/licenses/)
are bundled with the web app and dictionary image. Settings provides the same
source acknowledgement. Stored dictionary glosses retain their source IDs;
Ichiran's upstream errata and conjugation analysis are applied without
application-specific segmentation rules.

The pinned snapshot is January 2026. Periodically check for a newer upstream
release and update the URL and verified checksum in `Dockerfile.postgres`.
Prepare it in a new project-local bind directory and verify its analysis before
switching the running service. Keep the previous directory as a backup; never
restore over a live database. Restart the service and workers to clear their
reference-data caches. Previously stored corpus meanings remain intact.

When a newer dump is unavailable, use the supported upstream rebuild procedure
with current JMdict XML and current JMdictDB support files, configured against a
new PostgreSQL database in `settings.lisp`:

```lisp
(ichiran/maintenance:load-jmdict :path #p"/path/to/JMdict_e")
(ichiran/maintenance:load-best-readings :reset t)
(ichiran/conn:init-all-caches t)
(ichiran/dict:init-suffixes t t)
(ichiran/test:run-all-tests)
```

`load-jmdict` drops and rebuilds dictionary tables, so this must target the new
database. `add-errata` alone does not download current JMdict data. Follow the
[pinned upstream instructions](https://github.com/tshatrov/ichiran/blob/ea9583368e67cad22d94abae8dbcc8df96d99bcd/README.md)
and [EDRDG update conditions](https://www.edrdg.org/edrdg/licence.html) when
maintaining a deployed dictionary.
