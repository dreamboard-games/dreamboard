# @dreamboard-games/sdk-types

Public authoring and manifest types shared by Dreamboard generated code,
workspace manifests, and SDK packages.

This package is published as `@dreamboard-games/sdk-types`. Dreamboard
workspaces and the CLI may install it through the npm alias
`@dreamboard/sdk-types` so authored and generated source can use stable import
paths.

## Common Use

```ts
import { defineTopologyManifest } from "@dreamboard/sdk-types";
```

Use this package for manifest authoring types, card and slot descriptors, and
shared generated-code helper types. Reducer behavior belongs in
`@dreamboard/app-sdk/reducer`; UI primitives belong in `@dreamboard/ui-sdk` and
the generated `@dreamboard/ui-contract` workspace alias.

