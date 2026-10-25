# Database recovery and retained-world checks

`node tools/db-backup.mjs create data /separate-volume/paahde-2026-10-25` snapshots every SQLite database under
the data directory, including the registry, world files and minigame scores. Use a **new directory outside live data**.
The SQLite online backup API includes committed WAL writes; copying only live `.db` files can lose them.
Each completed file is integrity checked and hashed, and `backup.json` appears only after the full set completes.
Individual databases are consistent snapshots; the set is not one transaction across all world processes.

`node tools/db-backup.mjs verify /separate-volume/paahde-2026-10-25` checks every hash and database before restore.
For a restore drill, copy verified snapshots into an isolated data directory, start the server with `DB_PATH` pointing
there and a spare `PORT`, join a saved world, and check its inventory, buildings, recovery packs and called bosses.
Restore the registry too: it contains game settings and the secret needed for existing access keys. Never overwrite
live databases or their WAL files while servers are running. The regression suite rehearses a live-WAL snapshot and
restores/migrates an older world while checking item conservation.

Host backup scheduling and off-host retention must be verified on the actual host; these tools do not assume a host
backup exists or install a scheduler. Keep multiple dated backups on a separate volume/host, monitor successful
verification and rehearse recovery after schema changes. No live host credentials are needed for the local drill.

`node tools/bench/server.ts --aged --types --seconds 30` starts an isolated, disposable fixture with 600 buildings,
2,500 dropped items, 500 edited terrain chunks and 600 visited sites, then joins eight clients and runs the same
combat/input load as the fresh-world benchmark. Compare its startup, join time, network volume, tick percentiles
and memory with `node tools/bench/server.ts --types --seconds 30`. This fixture is intentionally retained data, not
a claim about a typical world's size. Use the same tree/hardware and alternate runs before interpreting differences.

Telemetry is written per world (`telemetry.<world>.jsonl`, plus `.1` after rotation), with a bounded pending queue.
`node tools/telemetry.ts --file data/telemetry.jsonl --no-open` combines those files and older shared logs;
local tail mode discovers new world files as they appear. Remote tail attaches to files present at startup.
