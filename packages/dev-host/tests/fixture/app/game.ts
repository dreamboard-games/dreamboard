import { z } from "zod";
import { createGame } from "@dreamboard-games/sdk/reducer";
import {
  createManifestStringLiteralSchema,
  type RuntimeTableRecord,
} from "@dreamboard-games/sdk/reducer/advanced";
const perPlayer = (ids: readonly string[], create: () => unknown) =>
  Object.fromEntries(ids.map((id) => [id, create()]));
function createModel() {
  const playerIds = ["player-1", "player-2"] as const;
  const phaseNames = ["play"] as const;
  const cardIds = ["card-1", "card-2"] as const;
  const handIds = ["hand"] as const;
  const emptyIds = [] as const;
  const literalIds = createManifestStringLiteralSchema;
  return {
    manifest: {
      literals: {
        playerIds,
        phaseNames,
        boardLayouts: emptyIds,
        setupOptionIds: emptyIds,
        setupProfileIds: emptyIds,
        cardSetIds: ["cards"] as const,
        cardTypes: ["action"] as const,
        deckIds: emptyIds,
        handIds,
        sharedZoneIds: emptyIds,
        playerZoneIds: handIds,
        zoneIds: handIds,
        cardIds,
        resourceIds: emptyIds,
        pieceTypeIds: emptyIds,
        pieceIds: emptyIds,
        dieTypeIds: emptyIds,
        dieIds: emptyIds,
        boardTemplateIds: emptyIds,
        boardTypeIds: emptyIds,
        boardBaseIds: emptyIds,
        boardIds: emptyIds,
        boardContainerIds: emptyIds,
        relationTypeIds: emptyIds,
        edgeIds: emptyIds,
        edgeTypeIds: emptyIds,
        vertexIds: emptyIds,
        vertexTypeIds: emptyIds,
        spaceIds: emptyIds,
        spaceTypeIds: emptyIds,
        handVisibilityById: { hand: "ownerOnly" } as const,
        zoneVisibilityById: { hand: "ownerOnly" } as const,
        setupChoiceIdsByOptionId: {},
        cardSetIdByCardId: { "card-1": "cards", "card-2": "cards" },
        cardTypeByCardId: { "card-1": "action", "card-2": "action" },
        cardSetIdsBySharedZoneId: {},
        cardSetIdsByPlayerZoneId: { hand: ["cards"] },
      },
      ids: {
        playerId: literalIds(playerIds),
        phaseName: literalIds(phaseNames),
        boardLayout: z.never(),
        setupOptionId: z.never(),
        setupProfileId: z.never(),
        cardSetId: literalIds(["cards"] as const),
        cardType: literalIds(["action"] as const),
        cardId: literalIds(cardIds),
        deckId: z.never(),
        handId: literalIds(handIds),
        sharedZoneId: z.never(),
        playerZoneId: literalIds(handIds),
        zoneId: literalIds(handIds),
        resourceId: z.never(),
        pieceTypeId: z.never(),
        pieceId: z.never(),
        dieId: z.never(),
        dieTypeId: z.never(),
        boardTypeId: z.never(),
        boardId: z.never(),
        boardBaseId: z.never(),
        boardContainerId: z.never(),
        relationTypeId: z.never(),
        edgeId: z.never(),
        edgeTypeId: z.never(),
        vertexId: z.never(),
        vertexTypeId: z.never(),
        spaceId: z.never(),
        spaceTypeId: z.never(),
      },
      defaults: {
        zones: () => ({ shared: {}, perPlayer: {}, visibility: {} }),
        decks: () => ({}),
        hands: () => ({ hand: perPlayer([], () => []) }),
        handVisibility: () => ({}),
        ownerOfCard: () => ({}),
        visibility: () => ({}),
        resources: () => perPlayer([], () => ({})),
      },
      setupOptionsById: {},
      setupChoiceIdsByOptionId: {},
      setupProfilesById: {},
      tableSchema: z.custom<RuntimeTableRecord>(),
      runtimeSchema: z.any(),
      createGameStateSchema: () => z.any(),
    },
    state: {
      public: z.object({ count: z.number() }),
      private: z.object({}),
      hidden: z.object({}),
    },
    phases: { play: z.object({}) },
    errors: { NOPE: "Not allowed." },
  };
}

const game = createGame(createModel());
export default game.assemble({
  initial: {
    public: () => ({ count: 0 }),
    private: () => ({}),
    hidden: () => ({}),
  },
  initialPhase: "play",
  phases: {
    play: game.phase("play").define({
      kind: "player",
      initialState: () => ({}),
      actor: ({ q }) => q.player.order()[0],
      interactions: {
        increment: {
          inputs: {},
          reduce: ({ state, accept }) =>
            accept({
              ...state,
              publicState: { count: state.publicState.count + 1 },
            }),
        },
      },
    }),
  },
  views: {
    shared: { project: ({ state }) => ({ count: state.publicState.count }) },
    player: { project: ({ shared }) => shared },
  },
});
