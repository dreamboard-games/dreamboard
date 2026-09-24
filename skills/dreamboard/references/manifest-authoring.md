# Manifest authoring

The authored manifest is a normal TypeScript module. Use the installed
`defineTopologyManifest` helper to retain literal identities:

```ts
import { defineTopologyManifest } from "@dreamboard-games/sdk/reducer";
export default defineTopologyManifest({
  players: { minPlayers: 2, maxPlayers: 2 },
  cardSets: [],
  zones: [],
  boards: [],
});
```

Pass it to createGame, or call compileManifest when tooling needs explicit ID
schemas, table schema, initial table construction and static geometry. Do not
hand-build a second compiler or commit generated identity contracts. Consult the
installed declaration for each component shape rather than copying an obsolete
schema table from a tutorial.

## Cards and zones

Manual card sets declare id/name, cardSchema, defaultHome and cards. Each card
has type/name/count and properties matching its schema. Explicit cardType, when
authored, is the runtime family identity; preserve literal property variants.
References to homes and allowedCardSetIds must name actual authored components.

Zones declare id/name, scope (`shared` or `perPlayer`) and visibility (`public`,
`ownerOnly` or `hidden`) as appropriate. Shared means one table-wide container;
perPlayer materializes a container for each seat. Scope does not grant visibility.
Hidden zones must not expose card IDs/properties through projection. UI code uses
canonical projected zone/card objects rather than rebuilding hidden contents from
the manifest.

## Inline board geometry

```ts
import { defineTopologyManifest, hexagon } from "@dreamboard-games/sdk/reducer";
export default defineTopologyManifest({
  players: { minPlayers: 2, maxPlayers: 2 },
  cardSets: [],
  zones: [],
  boards: [
    {
      id: "island",
      name: "Island",
      layout: "hex",
      scope: "shared",
      orientation: "pointy",
      shape: hexagon({ radius: 2 }),
      exclude: [{ q: 2, r: 0 }],
      spaces: { "0,0": { id: "capital", typeId: "city" } },
    },
  ],
});
```

Hex shapes, orientation and exclusions produce canonical space/edge/vertex
identities and incidence. Attach metadata through the canonical authoring
references; do not maintain a competing adjacency map or invent boundary IDs.
Square and generic boards also use inline data: there is no template identity or
merging path. Generic boards remain data-only unless the app supplies a layout.

The manifest owns static topology and component defaults. Reducers own mutable
occupancy, resource balances, turn data and rules. The canonical host materializer
joins static boards into frame.view.boards; the authored seat view must not use
that reserved own key.

## Initialization options

Lobby options belong to the createGame options Zod schema, not manifest setup
profiles. Values enter initialize as JSON, are validated and persisted, and are
available to state and phase initializers. Shuffle/deal and other setup mutations
happen in ordinary phase entry. Keep options JSON-native; do not introduce a
second profile selector or execution DSL.
