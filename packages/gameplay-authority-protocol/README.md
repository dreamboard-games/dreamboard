# Gameplay WebSocket protocol

The browser and CLI connect to `/v1/connect` and send `auth.connect` with a
concrete `sessionId`, `playerId`, and credential (`{kind:"user",token}` or
`{kind:"demo",secret}`). `auth.refresh` replaces only the credential; the
connection's actor, session, and seat remain fixed.

`session.snapshot` carries a seat-scoped dynamic SDK frame and separate persisted
`boardStatic`. The host merges static view content once. Versions increase across
both moves and restores; no generation or capability token exists.

Committed request IDs are durable across reconnects. Retry the identical submit
or restore request after losing its acknowledgement. Reusing an ID with different
content is rejected. A restore acknowledges its `restoreId` and broadcasts a new
snapshot. `gameplay.backpressure` uses `queue_full` or `capacity_full` and a retry
delay; retry the same request ID. Slow consumers close with code 4300 and reconnect.

Authored diagnostic logs are only delivered to the session host because they may
contain hidden game state. History metadata is bounded to the latest 200 commits;
restore still addresses any retained commit by its version.
