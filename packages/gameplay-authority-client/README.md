# @dreamboard-games/gameplay-authority-client

Typed WebSocket client for the Dreamboard Gameplay Authority service. Wraps
connection lifecycle, frame parsing, and reconnect handling over
[`@dreamboard-games/gameplay-authority-protocol`](https://www.npmjs.com/package/@dreamboard-games/gameplay-authority-protocol).

Used by the Dreamboard web app and the `dreamboard dev` host to stream
gameplay session state.

```ts
import { connectGameplayAuthority } from "@dreamboard-games/gameplay-authority-client";
```

Versioning follows the authority service deployment cadence; pin exact
versions in consumers.
