# Browser gameplay runtime

`createBrowserGameplayRuntime` runs a self-contained default-exported SDK reducer bundle offline. The trusted host supplies the canonical `initialize` request and a persistence callback. `start`, `dispatch`, `selectSeat`, and `reset` serialize operations and publish a selected-seat snapshot only after persistence succeeds. `dispose` ends execution.

Full reducer state is passed only to the trusted persistence callback. Never expose it to the authored UI iframe. Render that UI in a separate `sandbox="allow-scripts"` frame and use the SDK protocol through `PluginBridge`. This bridge comes from the product host runtime; the public package owns the reusable browser boundary.

The reducer executes in a worker created inside its own opaque iframe using a data URL (opaque-origin module blob workers are not portable). CSP denies network access, and the iframe owns a watchdog that terminates a non-responsive worker. The host validates reducer outputs against published SDK schemas. The runtime does not fetch assets, authenticate, synchronize, or call a backend. Hosts must supply complete self-contained code and local assets before claiming offline availability.

The parent page and its persistence callback are trusted. Local hot-seat play permits the human using the device to switch seats; it is not adversarial multiplayer authorization.

The headless SDK cohort uses only its root, `/react`, `/reducer`, and `/testing` exports. The worker imports canonical bundle admission and wire schemas from `/reducer`; the bridge imports canonical protocol schemas and the seat-frame materializer from the root. The host passes static boards to that materializer. Frames have one selected-seat view and the required persisted `events` batch, with no shared-view or stage fallback.

`mountGameplayUI` admits both submit and cancel commands. It copies each request before queueing, checks exact command-ID identity before stale-basis admission, and returns cached results for exact retries without dispatching twice. A reused ID with a changed operation, basis or payload rejects. `runtime.resume` republishes the current frame without dispatching or changing its revision.

The trusted runtime's `checkpoint()` returns serialized state and terminal metadata. `restore(checkpoint)` validates the roster and canonical state, projects and persists before committing, and never initializes or replays. The UI adapter's corresponding restore remounts its source and advances the transport revision, so prior queued intents cannot act on the restored lifetime. Pending selections, seeded RNG, options and events remain in the checkpoint. Neither checkpoints nor full reducer state cross into authored UI.
