# Server resource limits

The front server reserves capacity before asynchronous password checks or world startup. Defaults are
16 running/starting worlds (`MAX_WORLDS`), two concurrent startups, and 1,000 stored registry worlds
(`MAX_STORED_WORLDS`). Creation is also limited to 30 attempts per minute across the server. A startup
must report its port within 30 seconds. Password hashing uses two workers and at most 16 waiting requests;
additional requests receive a busy response. Player admission reserves the slot before connecting upstream.

A process that nobody ever joins exits after one minute. A world that has had players exits after ten
empty minutes. Both retain their database. The stored-world quota rejects new creation rather than deleting
existing games or player items. Choose limits from measured memory and host capacity before raising them.

There is intentionally no automatic save deletion. For retention, an operator should stop the relevant world,
take and verify a SQLite backup, inspect the world's player and item counts, and explicitly archive selected
world databases and their matching registry records. A world with no connected players can still contain
valuable progress; last activity alone is not permission to erase it. Keep the registry and world backups
together so access settings and saved state can be restored consistently.

World browsing caches summaries for one minute. Each five-second browse refresh performs at most 16 database
reads, from a bounded recent candidate list plus running public worlds. A cold browser list fills over the
next refreshes instead of opening every historical world database on the proxy thread.

Corpse recovery time advances only while its owner is ready in the world, and the remaining budget is persisted.
Called bosses retain damage and position across restarts; transient attacks and movement phases restart safely.
