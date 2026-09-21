# @dreamboard-games/ui-host-runtime

Dreamboard host session runtime shared by the Dreamboard web app and the
`dreamboard dev` host:

- unified session store, projection, and recovery (`.`)
- one stateful Gameplay Authority connection and plugin bridge (`./runtime`)
- host-side controls and feedback UI (player switching, history restore,
  `YOUR_TURN` / `ACTION_REJECTED` feedback) (`./components`)

This package owns host session chrome. It is intentionally separate from the
`@dreamboard-games/sdk` UI surface: SDK presentation stays
Dreamboard-interaction unaware, while this package polls backend control
snapshots and binds one credential-refreshing, reconnecting Gameplay Authority
connection to the plugin runtime. Canonical SDK frames and interaction commands
pass through unchanged; accepted command responses are acknowledgements, and
all gameplay state enters through authority snapshots.

```ts
import { HostControls } from "@dreamboard-games/ui-host-runtime/components";
import { createUnifiedSessionStore } from "@dreamboard-games/ui-host-runtime";
```

Versioning follows the Dreamboard product release cadence; pin exact versions
in consumers.
