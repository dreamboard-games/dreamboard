# Browser gameplay runtime

`createBrowserGameplayRuntime` runs a self-contained default-exported SDK reducer bundle offline. The trusted host supplies the canonical `initialize` request and a persistence callback. `start`, `dispatch`, `selectSeat`, and `reset` serialize operations and publish a selected-seat snapshot only after persistence succeeds. `dispose` ends execution.

Full reducer state is passed only to the trusted persistence callback. Never expose it to the authored UI iframe. Render that UI in a separate `sandbox="allow-scripts"` frame and use the SDK protocol through `PluginBridge`. This bridge comes from the product host runtime; the public package owns the reusable browser boundary.

The reducer executes in a worker created inside its own opaque iframe using a data URL (opaque-origin module blob workers are not portable). CSP denies network access, and the iframe owns a watchdog that terminates a non-responsive worker. The host validates reducer outputs against published SDK schemas. The runtime does not fetch assets, authenticate, synchronize, or call a backend. Hosts must supply complete self-contained code and local assets before claiming offline availability.

The parent page and its persistence callback are trusted. Local hot-seat play permits the human using the device to switch seats; it is not adversarial multiplayer authorization.
