import { z } from "zod";
import {
  asPlayerId,
  defineGame,
  defineGameContract,
  defineInteraction,
  definePhase,
  definePlayerView,
  defineSharedView,
  formInput,
  perPlayer,
} from "@dreamboard-games/sdk/reducer";
import {
  createManifestStringLiteralSchema,
  type RuntimeTableRecord,
} from "@dreamboard-games/sdk/reducer/advanced";

const playerIds = ["player-1"] as const;
const phaseNames = ["play"] as const;

function createTable(ids: readonly string[]): RuntimeTableRecord {
  const players = ids.map(asPlayerId);
  return {
    playerOrder: players,
    zones: { shared: {}, perPlayer: {}, visibility: {} },
    decks: {},
    hands: {},
    handVisibility: {},
    cards: {},
    pieces: {},
    componentLocations: {},
    ownerOfCard: {},
    visibility: {},
    resources: perPlayer(players, () => ({})),
    boards: {
      byId: {},
      hex: {},
      network: {},
      square: {},
      track: {},
    },
    dice: {},
  };
}

const emptyIds = [] as const;
const manifest = {
  literals: {
    playerIds,
    phaseNames,
    setupOptionIds: emptyIds,
    setupProfileIds: emptyIds,
    cardSetIds: emptyIds,
    cardTypes: emptyIds,
    deckIds: emptyIds,
    handIds: emptyIds,
    sharedZoneIds: emptyIds,
    playerZoneIds: emptyIds,
    zoneIds: emptyIds,
    cardIds: emptyIds,
    resourceIds: emptyIds,
    pieceTypeIds: emptyIds,
    pieceIds: emptyIds,
    dieTypeIds: emptyIds,
    dieIds: emptyIds,
    boardBaseIds: emptyIds,
    boardIds: emptyIds,
    boardContainerIds: emptyIds,
    edgeIds: emptyIds,
    edgeTypeIds: emptyIds,
    vertexIds: emptyIds,
    vertexTypeIds: emptyIds,
    spaceIds: emptyIds,
    spaceTypeIds: emptyIds,
    handVisibilityById: {},
    zoneVisibilityById: {},
    cardSetIdByCardId: {},
    cardTypeByCardId: {},
    cardSetIdsBySharedZoneId: {},
    cardSetIdsByPlayerZoneId: {},
  },
  ids: {
    playerId: createManifestStringLiteralSchema(playerIds, "playerId"),
    phaseName: createManifestStringLiteralSchema(phaseNames, "phaseName"),
    setupOptionId: createManifestStringLiteralSchema(emptyIds, "setupOptionId"),
    setupProfileId: createManifestStringLiteralSchema(
      emptyIds,
      "setupProfileId",
    ),
    cardSetId: createManifestStringLiteralSchema(emptyIds, "cardSetId"),
    cardType: createManifestStringLiteralSchema(emptyIds, "cardType"),
    cardId: createManifestStringLiteralSchema(emptyIds, "cardId"),
    deckId: createManifestStringLiteralSchema(emptyIds, "deckId"),
    handId: createManifestStringLiteralSchema(emptyIds, "handId"),
    sharedZoneId: createManifestStringLiteralSchema(emptyIds, "sharedZoneId"),
    playerZoneId: createManifestStringLiteralSchema(emptyIds, "playerZoneId"),
    zoneId: createManifestStringLiteralSchema(emptyIds, "zoneId"),
    resourceId: createManifestStringLiteralSchema(emptyIds, "resourceId"),
    pieceTypeId: createManifestStringLiteralSchema(emptyIds, "pieceTypeId"),
    pieceId: createManifestStringLiteralSchema(emptyIds, "pieceId"),
    dieTypeId: createManifestStringLiteralSchema(emptyIds, "dieTypeId"),
    dieId: createManifestStringLiteralSchema(emptyIds, "dieId"),
    boardTypeId: createManifestStringLiteralSchema(emptyIds, "boardTypeId"),
    boardBaseId: createManifestStringLiteralSchema(emptyIds, "boardBaseId"),
    boardId: createManifestStringLiteralSchema(emptyIds, "boardId"),
    boardContainerId: createManifestStringLiteralSchema(
      emptyIds,
      "boardContainerId",
    ),
    relationTypeId: createManifestStringLiteralSchema(
      emptyIds,
      "relationTypeId",
    ),
    edgeId: createManifestStringLiteralSchema(emptyIds, "edgeId"),
    edgeTypeId: createManifestStringLiteralSchema(emptyIds, "edgeTypeId"),
    vertexId: createManifestStringLiteralSchema(emptyIds, "vertexId"),
    vertexTypeId: createManifestStringLiteralSchema(emptyIds, "vertexTypeId"),
    spaceId: createManifestStringLiteralSchema(emptyIds, "spaceId"),
    spaceTypeId: createManifestStringLiteralSchema(emptyIds, "spaceTypeId"),
  },
  defaults: {
    zones: () => ({ shared: {}, perPlayer: {}, visibility: {} }),
    decks: () => ({}),
    hands: () => ({}),
    handVisibility: () => ({}),
    ownerOfCard: () => ({}),
    visibility: () => ({}),
    resources: (ids?: readonly string[]) =>
      perPlayer((ids ?? []).map(asPlayerId), () => ({})),
  },
  normalSetup: {
    minPlayers: 1,
    maxPlayers: 1,
    createInitialTable: ({
      playerIds: ids,
    }: {
      playerIds: readonly string[];
    }) => createTable(ids),
  },
  setupOptionsById: {},
  setupChoiceIdsByOptionId: {},
  setupProfilesById: {},
  tableSchema: z.custom<RuntimeTableRecord>(),
  runtimeSchema: z.any(),
  createGameStateSchema: () => z.any(),
} as const;

const contract = defineGameContract({
  manifest,
  state: {
    public: z.object({ count: z.number().int() }),
    private: z.object({}),
    hidden: z.object({}),
  },
  phases: { play: z.object({}) },
  errors: { COUNT_TOO_LARGE: "The count cannot exceed two." },
});

const phaseState = z.object({});
const throwDuringReplay = false;

export default defineGame({
  contract,
  initial: {
    public: () => ({ count: 0 }),
    private: () => ({}),
    hidden: () => ({}),
  },
  initialPhase: "play",
  phases: {
    play: definePhase<typeof contract>()({
      kind: "player",
      state: phaseState,
      initialState: () => ({}),
      actor: ({ q }) => q.player.order()[0] ?? null,
      interactions: {
        increment: defineInteraction<typeof contract, typeof phaseState>()({
          inputs: { amount: formInput.number({ min: 1, max: 2 }) },
          rules: [
            {
              id: "count-limit",
              errorCode: "COUNT_TOO_LARGE",
              validate: ({ state, input }) =>
                state.publicState.count + input.params.amount <= 2
                  ? null
                  : { errorCode: "COUNT_TOO_LARGE" },
            },
          ],
          reduce: ({ state, input, accept }) => {
            if (throwDuringReplay) {
              throw new Error("fixture replay crashed");
            }
            return accept({
              ...state,
              publicState: {
                ...state.publicState,
                count: state.publicState.count + input.params.amount,
              },
            });
          },
        }),
      },
    }),
  },
  views: {
    shared: defineSharedView<typeof contract>()({
      project: ({ state }) => ({ count: state.publicState.count }),
    }),
    player: definePlayerView<typeof contract>()({
      project: ({ playerId, shared }) => ({ playerId, ...shared }),
    }),
  },
});
