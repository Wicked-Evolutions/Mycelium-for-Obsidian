# Semantic Index Recovery

Semantic indexes are derived from Markdown notes. A storage compatibility or
recovery failure does not mean the notes were lost, and an available Ollama model
does not prove that an index can be opened.

Do not remove database companions or publication artifacts just to make a status
call succeed. A WAL can contain committed rows absent from the main database;
a publication rollback can preserve the previous complete generation.

## Legacy WAL Normalization

The optional operator command handles recognized legacy WAL-format indexes. It
does not import server startup, modify notes, generate embeddings, change model
identity, or perform publication-lock recovery. It uses the existing native
filesystem adapter on macOS/Linux and the installed SQLite dependency.

1. Stop every current and older Mycelium server and watcher that can use the
   selected vault. Prevent clients, background jobs and other hosts from restarting
   them for the entire operation. An empty open-handle scan or a dead PID is not
   proof that an idle in-memory publisher cannot write later.
2. Keep the same explicit `OBSIDIAN_VAULTS` configuration used by the server and
   build the reviewed source. Run the command for exactly one configured vault:

   ```sh
   node dist/embeddings/recover-legacy-index.js --vault "Example Vault" --offline-confirmed
   ```

   `--offline-confirmed` is the operator's assertion of the maintained offline
   window, not a process-discovery mechanism. Do not supply it while a server or
   watcher can still access the index.
3. Keep the returned private backup directory and receipt. The command copies and
   verifies the original database/WAL/SHM bundle before doing any normalization.
   SQLite opens only a separate temporary working copy; the original SHM is kept
   as evidence, not reused as trusted working state.
4. The working copy must pass integrity checks, complete checkpoint accounting and
   a deterministic comparison of stored table contents, including embedding BLOBs,
   metadata and FTS data. SQLite converts it to DELETE journal mode. Only that
   validated single-file snapshot is staged and atomically published.
5. Sidecars are quarantined after database publication, with directory syncs between
   transitions. Keep both the backup bundle and quarantined originals until the
   result has been checked. No original artifact is intentionally discarded.
6. Start the current server, run `index_status`, then a representative
   `semantic_search`. The compatibility receipt still determines whether old
   embeddings need re-indexing. Normalization preserves existing model metadata;
   it cannot invent a missing model digest or make incompatible vectors exact.

This is a conservative normalizer, not a salvage utility. Incomplete framing,
ambiguous trailing frames, mixed WAL generations, corruption, changed artifacts,
publication state or invalid file identities stop the operation. Some unusual but
valid SQLite states therefore require separate operator inspection.

The checks follow SQLite's [WAL format](https://www.sqlite.org/fileformat2.html#wal_format)
and [checkpoint contract](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).
They do not replace SQLite's own integrity and checkpoint validation.

## Interrupted Normalization

Keep all publishers offline. Preserve the complete backup bundle, the canonical
database, staged snapshots and quarantined companions. Do not rerun the command
blindly: the canonical database may already be normalized while a companion still
blocks the normal runtime.

- Before publication, the original canonical bundle remains authoritative.
- After publication, the validated normalized database may already contain every
  committed row. A remaining WAL/SHM intentionally prevents ordinary startup from
  guessing about that mixed intermediate state.
- A verified original bundle provides a rollback source, but restoration must be
  handled as one complete offline generation, never by copying only its database
  or deleting companions independently. Retain the interrupted state as evidence.

Do not claim an interrupted operation succeeded solely because the database passes
an integrity check. Reconcile the returned/preserved artifacts and then verify a
fresh-process status and semantic query.

## Publication Identity Mismatch

New saves write version-4 publication records containing SHA-256 fingerprints of
the published snapshot and its verified rollback copy before the commit marker
becomes durable. After an interrupted committed save, a normal storage open can
verify these bytes even when the filesystem device number has changed. Recovery
still requires a dead publisher, matching inodes, regular single-link files,
pinned directory/path checks and unchanged transaction evidence. Unknown state,
changed bytes, replaced files, sidecars or unexpected temporary artifacts are
not accepted. Hashes establish recorded-byte continuity, not authentication of
the publisher.

The canonical database is not rewritten or re-indexed. Recovery removes only the
verified rollback, syncs the directory, and removes the verified lock last. A
restart after rollback cleanup can finish from the remaining valid record.
`index_status` and `get_ecosystem_stats` use the same verification to inspect a
proven committed snapshot without modifying any artifacts; normal storage open
(for example, semantic search) completes cleanup.

This fixes recovery of the specified interrupted committed-save/device-change
case for new records. It does not prevent process interruption, explain the
original incident's interruption, or accept uncommitted transactions after
identity drift. Normal physical-identity checks remain unchanged. Existing
healthy indexes need no database or embedding migration: the next save writes
the new temporary record.

### Older or Unverifiable Records

Version-3 records remain supported when physical identities match. They contain
no snapshot fingerprints, so an already interrupted version-3 transaction with
changed device identity cannot acquire retrospective proof from this upgrade.
Inode equality or a valid SQLite integrity check alone is insufficient. Do not
rewrite recorded device IDs, remove the lock blindly, or overwrite a committed
database with its older rollback snapshot.

An operator-assisted recovery requires an independently justified, explicitly
accepted generation, a maintained offline window and verified private copies of
every original artifact. Preserve the committed database bytes; quarantine the
verified rollback first while the lock still blocks publication, revalidate the
database and lock, and quarantine the lock last. Stop if identities, bytes,
transaction state or provenance cannot be established.

That procedure is the explicit fallback for old or otherwise unverifiable
records, not the automatic version-4 recovery path. Preserve the refusal if an
operator cannot justify which generation is authoritative.

## Explicit Rebuild Fallback

Rebuilding from Markdown is a separate operator choice when lossless normalization
or justified recovery is unavailable. Preserve/quarantine the complete old derived
index state first and maintain the offline window while moving it out of service.
Never include notes in that operation. Only then start a fresh derived index with
the current server and explicitly run `index_vault`.

Index coverage describes current indexed file paths, not the freshness of every
stored passage. Validate relevant query results against their note sources before
using them as current evidence.
