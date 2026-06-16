import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  type HostPlayerGameplayView,
  type HostSessionEvent,
  type InteractionDescriptor,
} from "@dreamboard-games/api-client";
import { toApiProblem } from "../../utils/errors.js";
import { subscribeToCliSessionEvents } from "../../utils/session-event-stream.js";
import {
  submitGameplayAuthorityAction,
  type SubmitGameplayAuthorityActionOptions,
  type SubmitGameplayAuthorityActionResult,
} from "../gameplay-authority-submit.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };
type RequestId = string | number;

type JoinRequest = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type JoinProtocolError = {
  code: string;
  message: string;
  details?: JsonObject;
};

type JoinSuccessEnvelope = {
  id: RequestId;
  result: JsonValue;
};

type JoinErrorEnvelope = {
  id: RequestId | null;
  error: JoinProtocolError;
};

type JoinEventEnvelope = {
  type: "event";
  event: JsonObject;
};

type JoinStreamErrorEnvelope = {
  type: "error";
  error: JoinProtocolError;
};

type ProtocolEnvelope =
  | JoinSuccessEnvelope
  | JoinErrorEnvelope
  | JoinEventEnvelope
  | JoinStreamErrorEnvelope;

type SubscribeToEvents = typeof subscribeToCliSessionEvents;
type SubmitPlayerAction = (
  options: SubmitGameplayAuthorityActionOptions,
) => Promise<SubmitGameplayAuthorityActionResult>;

export type JoinJsonlSessionOptions = {
  sessionId: string;
  playerId: string;
  rawEvents?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  subscribeToEvents?: SubscribeToEvents;
  submitPlayerAction?: SubmitPlayerAction;
  signal?: AbortSignal;
};

class JsonlWriter {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly output: NodeJS.WritableStream) {}

  write(envelope: ProtocolEnvelope): Promise<void> {
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const line = `${JSON.stringify(normalizeEnvelopeForJsonl(envelope))}\n`;
          const flushed = this.output.write(line, (error?: Error | null) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
          if (!flushed) {
            this.output.once("error", reject);
          }
        }),
    );
    return this.writeChain;
  }
}

function normalizeEnvelopeForJsonl(
  envelope: ProtocolEnvelope,
): ProtocolEnvelope {
  if ("event" in envelope) {
    return {
      ...envelope,
      event: normalizeProtocolValue(envelope.event) as JsonObject,
    };
  }
  if ("result" in envelope) {
    return {
      ...envelope,
      result: normalizeProtocolValue(envelope.result),
    };
  }
  return envelope;
}

function normalizeProtocolValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeProtocolValue(entry));
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const normalized: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "view" || key === "boardStatic") &&
      typeof entry === "string"
    ) {
      normalized[key] = parseJsonField(key, entry);
      continue;
    }
    if (key === "gameplay" && isJsonObject(entry)) {
      normalized[key] = normalizeGameplaySnapshotForJsonl(entry);
      continue;
    }
    normalized[key] = normalizeProtocolValue(entry);
  }
  return normalized;
}

function normalizeGameplaySnapshotForJsonl(gameplay: JsonObject): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, value] of Object.entries(gameplay)) {
    if (
      (key === "view" || key === "boardStatic") &&
      typeof value === "string"
    ) {
      normalized[key] = parseJsonField(key, value);
      continue;
    }
    normalized[key] = normalizeProtocolValue(value);
  }
  return normalized;
}

function parseJsonField(field: string, value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw protocolError(
      "INVALID_GAMEPLAY_JSON",
      `Gameplay field '${field}' was not valid JSON: ${formatUnknown(error)}`,
    );
  }
}

export async function runJoinJsonlSession(
  options: JoinJsonlSessionOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const writer = new JsonlWriter(options.output ?? process.stdout);
  const errorOutput = options.errorOutput ?? process.stderr;
  const abortController = new AbortController();
  const inFlightIds = new Set<RequestId>();
  const pendingRequests = new Set<Promise<void>>();
  const state = new JoinBotState(options.playerId);
  const subscribe = options.subscribeToEvents ?? subscribeToCliSessionEvents;
  const submitAction =
    options.submitPlayerAction ?? submitGameplayAuthorityAction;

  const rl = createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });
  const abort = () => {
    abortController.abort();
    rl.close();
  };

  const eventPump = pumpSessionEvents({
    sessionId: options.sessionId,
    playerId: options.playerId,
    writer,
    state,
    subscribe,
    rawEvents: options.rawEvents ?? false,
    signal: abortController.signal,
    errorOutput,
  })
    .catch((error) => {
      errorOutput.write(
        `dreamboard join event pump failed: ${formatUnknown(error)}\n`,
      );
    })
    .finally(() => {
      if (!abortController.signal.aborted) {
        abort();
      }
    });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: JoinRequest;
      try {
        parsed = JSON.parse(trimmed) as JoinRequest;
      } catch (error) {
        void writer.write({
          id: null,
          error: protocolError(
            "INVALID_JSON",
            error instanceof Error ? error.message : "Invalid JSON line.",
          ),
        });
        continue;
      }

      const requestId = parseRequestId(parsed.id);
      if (!requestId.ok) {
        void writer.write({
          id: null,
          error: requestId.error,
        });
        continue;
      }

      if (inFlightIds.has(requestId.value)) {
        void writer.write({
          id: requestId.value,
          error: protocolError(
            "DUPLICATE_IN_FLIGHT_ID",
            `Request id '${String(requestId.value)}' is already in flight.`,
          ),
        });
        continue;
      }

      inFlightIds.add(requestId.value);
      const requestPromise = handleRequest({
        request: parsed,
        requestId: requestId.value,
        sessionId: options.sessionId,
        playerId: options.playerId,
        state,
        submitAction,
      })
        .then((result) =>
          writer.write({
            id: requestId.value,
            result,
          }),
        )
        .catch((error) =>
          writer.write({
            id: requestId.value,
            error: coerceProtocolError(error),
          }),
        )
        .finally(() => {
          inFlightIds.delete(requestId.value);
          pendingRequests.delete(requestPromise);
        });
      pendingRequests.add(requestPromise);
    }

    await Promise.all([...pendingRequests]);
  } finally {
    rl.close();
    abortController.abort();
    options.signal?.removeEventListener("abort", abort);
    void eventPump;
  }
}

async function pumpSessionEvents(options: {
  sessionId: string;
  playerId: string;
  writer: JsonlWriter;
  state: JoinBotState;
  subscribe: SubscribeToEvents;
  rawEvents: boolean;
  signal: AbortSignal;
  errorOutput: NodeJS.WritableStream;
}): Promise<void> {
  try {
    let lastSseError: unknown;
    const subscription = await options.subscribe({
      sessionId: options.sessionId,
      playerId: options.playerId,
      signal: options.signal,
      clientSource: "dreamboard-join",
      onSseError: (error) => {
        lastSseError = error;
      },
      sseDefaultRetryDelay: 250,
      sseMaxRetryAttempts: 1,
    });
    const { stream } = subscription;

    try {
      for await (const event of stream) {
        if (!event) {
          continue;
        }
        const compactEvent = options.state.applyEvent(event);
        const eventToWrite = options.rawEvents
          ? (event as unknown as JsonObject)
          : compactEvent;
        if (!eventToWrite) {
          continue;
        }
        await options.writer.write({
          type: "event",
          event: eventToWrite,
        });
      }
      if (!options.signal.aborted) {
        throw (
          lastSseError ??
          new Error(
            "Gameplay event stream closed before the join session ended.",
          )
        );
      }
    } finally {
      await subscription.disconnect?.().catch(() => {});
    }
  } catch (error) {
    if (options.signal.aborted) {
      return;
    }
    options.errorOutput.write(
      `dreamboard join event stream failed: ${formatUnknown(error)}\n`,
    );
    await options.writer.write({
      type: "error",
      error: protocolError("EVENT_STREAM_ERROR", formatUnknown(error)),
    });
  }
}

class JoinBotState {
  private hasBootstrap = false;
  private latestGameplay: HostPlayerGameplayView | undefined;
  private latestActions: InteractionActionCache | undefined;
  private previousCompactActions: CompactAction[] | undefined;

  constructor(readonly playerId: string) {}

  applyEvent(event: HostSessionEvent): JsonObject | undefined {
    switch (event.type) {
      case "session.snapshot": {
        if (event.snapshot.type !== "gameplay") {
          return undefined;
        }
        this.assertScopedGameplay(event.snapshot.gameplay);
        this.hasBootstrap = true;
        return this.applyGameplayEvent(event.type, event.snapshot.gameplay);
      }
      case "session.gameplayUpdated": {
        this.assertScopedGameplay(event.gameplay);
        return this.applyGameplayEvent(event.type, event.gameplay);
      }
    }
    return undefined;
  }

  applyGameplay(gameplay: HostPlayerGameplayView | undefined): void {
    if (gameplay) {
      this.assertScopedGameplay(gameplay);
      this.latestGameplay = gameplay;
      this.latestActions = actionCacheFromGameplay(gameplay);
    }
  }

  assertReady(): void {
    if (!this.hasBootstrap) {
      throw protocolError(
        "NOT_READY",
        "No gameplay bootstrap is available yet. Wait for bot.gameplay.",
      );
    }
  }

  getLatestGameplay(): JsonObject {
    this.assertReady();
    if (!this.latestGameplay) {
      throw protocolError(
        "NOT_READY",
        "No gameplay snapshot is available yet. Wait for bot.gameplay.",
      );
    }
    return normalizeGameplaySnapshotForJsonl(
      this.latestGameplay as unknown as JsonObject,
    );
  }

  latestActionRequest(
    interactionId: string,
    inputs: JsonObject,
  ): LatestActionRequest {
    this.assertReady();
    const cache = this.latestActions;
    if (!cache) {
      throw protocolError(
        "NOT_READY",
        "No action set is available yet. Wait for bot.gameplay.",
      );
    }
    if (
      !cache.actions.some((action) => action.interactionId === interactionId)
    ) {
      throw protocolError(
        "ACTION_NOT_FOUND",
        `Action '${interactionId}' is not available.`,
      );
    }
    return {
      interactionId,
      expectedVersion: cache.version,
      actionSetVersion: cache.actionSetVersion,
      inputs,
    };
  }

  applyActionSet(actionSet: {
    version: number;
    actionSetVersion: string;
    actions?: ReadonlyArray<InteractionDescriptorLike>;
    interactionsByRef?: Record<string, InteractionDescriptorLike | undefined>;
    availableInteractionRefs?: ReadonlyArray<string>;
  }): void {
    const actions = actionsFromActionSet(actionSet);
    this.latestActions = {
      version: actionSet.version,
      actionSetVersion: actionSet.actionSetVersion,
      actions,
    };
  }

  hasInteraction(interactionId: string): boolean {
    return (
      this.latestActions?.actions.some(
        (action) => action.interactionId === interactionId,
      ) ?? false
    );
  }

  latestActionSet(): {
    version: number;
    actionSetVersion: string;
    actions: InteractionDescriptorLike[];
  } {
    this.assertReady();
    const cache = this.latestActions;
    if (!cache) {
      throw protocolError(
        "NOT_READY",
        "No action set is available yet. Wait for bot.gameplay.",
      );
    }
    return {
      version: cache.version,
      actionSetVersion: cache.actionSetVersion,
      actions: cache.actions,
    };
  }

  describeAction(interactionId: string): JsonObject {
    const actionSet = this.latestActionSet();
    const action = actionSet.actions.find(
      (candidate) => candidate.interactionId === interactionId,
    );
    if (!action) {
      throw protocolError(
        "ACTION_NOT_FOUND",
        `Action '${interactionId}' is not available.`,
      );
    }
    return {
      version: actionSet.version,
      actionSetVersion: actionSet.actionSetVersion,
      action: action as unknown as JsonValue,
    };
  }

  actionTargets(interactionId: string, inputKey: string): JsonObject {
    const actionSet = this.latestActionSet();
    const action = actionSet.actions.find(
      (candidate) => candidate.interactionId === interactionId,
    );
    if (!action) {
      throw protocolError(
        "ACTION_NOT_FOUND",
        `Action '${interactionId}' is not available.`,
      );
    }
    const input = action.inputs.find((candidate) => candidate.key === inputKey);
    if (!input) {
      throw protocolError(
        "INPUT_NOT_FOUND",
        `Input '${inputKey}' is not defined for action '${interactionId}'.`,
      );
    }
    const zoneId = action.zoneId;
    const zoneCardsById =
      zoneId && this.latestGameplay
        ? this.latestGameplay.seats[this.latestGameplay.perspectivePlayerId]
            ?.zones[zoneId]?.cardViewsById
        : undefined;
    return compactObject({
      version: actionSet.version,
      actionSetVersion: actionSet.actionSetVersion,
      interactionId,
      inputKey,
      domain: input.domain as unknown as JsonValue,
      zoneCardsById: zoneCardsById as unknown as JsonValue,
    });
  }

  private applyGameplayEvent(
    sourceType: string,
    gameplay: HostPlayerGameplayView | undefined,
  ): JsonObject | undefined {
    if (!gameplay) {
      return undefined;
    }
    this.latestGameplay = gameplay;
    this.latestActions = actionCacheFromGameplay(gameplay);
    const compactActions = actionsFromGameplay(gameplay).map(
      compactActionFromDescriptor,
    );
    const event = compactGameplayEvent({
      sourceType,
      gameplay,
      actions: compactActions,
      previousActions: this.previousCompactActions,
    });
    this.previousCompactActions = compactActions;
    return event;
  }

  private assertScopedGameplay(
    gameplay: HostPlayerGameplayView | null | undefined,
  ): void {
    if (!gameplay) {
      return;
    }
    if (gameplay.perspectivePlayerId !== this.playerId) {
      throw protocolError(
        "PLAYER_SCOPE_MISMATCH",
        `Received gameplay for '${gameplay.perspectivePlayerId}' while joined as '${this.playerId}'.`,
      );
    }
  }
}

type InteractionDescriptorLike = InteractionDescriptor;

type InteractionActionCache = {
  version: number;
  actionSetVersion: string;
  actions: InteractionDescriptorLike[];
};

type CompactAction = {
  interactionId: string;
  interactionKey?: string;
  kind?: string;
  available: boolean;
  unavailableReason?: string;
  inputs?: JsonValue;
  cost?: JsonValue;
  currentResources?: JsonValue;
  missingResources?: Record<string, number>;
  context?: JsonValue;
};

type LatestActionRequest = {
  interactionId: string;
  expectedVersion: number;
  actionSetVersion: string;
  inputs: JsonObject;
};

function actionCacheFromGameplay(
  gameplay: HostPlayerGameplayView,
): InteractionActionCache {
  return {
    version: gameplay.version,
    actionSetVersion: gameplay.actionSetVersion,
    actions: actionsFromGameplay(gameplay),
  };
}

function compactActionFromDescriptor(
  descriptor: InteractionDescriptorLike,
): CompactAction {
  const availability = descriptor.availability;
  const unavailableReason =
    availability.status === "available" ? undefined : availability.reason;
  const missingResources =
    availability.status === "insufficientResources"
      ? availability.missingResources
      : undefined;
  return compactObject({
    interactionId: descriptor.interactionId,
    interactionKey: descriptor.interactionKey,
    kind: descriptor.kind,
    available: availability.status === "available",
    unavailableReason,
    inputs: normalizeUnknownJson(descriptor.inputs),
    cost: normalizeUnknownJson(descriptor.cost),
    currentResources: normalizeUnknownJson(descriptor.currentResources),
    missingResources,
    context:
      descriptor.kind === "prompt"
        ? normalizeUnknownJson(descriptor.context)
        : undefined,
  }) as CompactAction;
}

function compactGameplayEvent(options: {
  sourceType: string;
  gameplay: HostPlayerGameplayView;
  actions: CompactAction[];
  previousActions: CompactAction[] | undefined;
}): JsonObject {
  const { gameplay, actions, previousActions } = options;
  return compactObject({
    type: "bot.gameplay",
    sourceType: options.sourceType,
    version: gameplay.version,
    actionSetVersion: gameplay.actionSetVersion,
    playerId: gameplay.perspectivePlayerId,
    activePlayers: normalizeUnknownJson(gameplay.shared.activePlayers),
    currentPhase: gameplay.shared.currentPhase,
    currentStage: gameplay.shared.currentStage,
    stageSeats: normalizeUnknownJson(gameplay.shared.stageSeats),
    isActivePlayer: gameplay.shared.activePlayers.includes(
      gameplay.perspectivePlayerId,
    ),
    actions: actions as unknown as JsonValue,
    deltas:
      previousActions === undefined
        ? undefined
        : (actionDeltas(previousActions, actions) as unknown as JsonValue),
  });
}

function actionDeltas(previous: CompactAction[], current: CompactAction[]) {
  const previousById = new Map(
    previous.map((action) => [action.interactionId, action]),
  );
  const currentById = new Map(
    current.map((action) => [action.interactionId, action]),
  );
  const appeared = current.filter(
    (action) => !previousById.has(action.interactionId),
  );
  const disappeared = previous
    .filter((action) => !currentById.has(action.interactionId))
    .map((action) => action.interactionId);
  const availabilityChanged = current.flatMap((action) => {
    const before = previousById.get(action.interactionId);
    if (
      !before ||
      (before.available === action.available &&
        before.unavailableReason === action.unavailableReason)
    ) {
      return [];
    }
    return [
      compactObject({
        interactionId: action.interactionId,
        interactionKey: action.interactionKey,
        previousAvailable: before.available,
        available: action.available,
        previousUnavailableReason: before.unavailableReason,
        unavailableReason: action.unavailableReason,
      }),
    ];
  });
  const promptsAppeared = appeared.filter((action) => action.kind === "prompt");
  const promptsCleared = previous
    .filter(
      (action) =>
        action.kind === "prompt" && !currentById.has(action.interactionId),
    )
    .map((action) => action.interactionId);
  return {
    appeared,
    disappeared,
    availabilityChanged,
    promptsAppeared,
    promptsCleared,
  };
}

function compactObject(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry as JsonValue;
    }
  }
  return result;
}

function normalizeUnknownJson(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeProtocolValue(value as JsonValue);
}

async function handleRequest(options: {
  request: JoinRequest;
  requestId: RequestId;
  sessionId: string;
  playerId: string;
  state: JoinBotState;
  submitAction: SubmitPlayerAction;
}): Promise<JsonValue> {
  if (typeof options.request.method !== "string") {
    throw protocolError("INVALID_REQUEST", "Request method must be a string.");
  }
  if (
    options.request.method.startsWith("actions.") ||
    options.request.method === "state.get"
  ) {
    options.state.assertReady();
  }

  switch (options.request.method) {
    case "state.get":
      return {
        gameplay: options.state.getLatestGameplay(),
      };
    case "actions.list": {
      return normalizeActionSetForJsonl(
        options.state.latestActionSet(),
      ) as unknown as JsonValue;
    }
    case "actions.describe": {
      const params = requireObjectParams(options.request.params);
      return options.state.describeAction(
        requireString(params, "interactionId"),
      ) as unknown as JsonValue;
    }
    case "actions.targets": {
      const params = requireObjectParams(options.request.params);
      return options.state.actionTargets(
        requireString(params, "interactionId"),
        requireString(params, "inputKey"),
      ) as unknown as JsonValue;
    }
    case "actions.validate": {
      const params = parseInputRequestParams(
        options.request.params,
        options.playerId,
      );
      return validateLocally(params) as unknown as JsonValue;
    }
    case "actions.validateLatest": {
      const params = parseLatestInputRequestParams(
        options.request.params,
        options.playerId,
      );
      const latest = options.state.latestActionRequest(
        params.interactionId,
        params.inputs,
      );
      return withRetry(validateLocally(latest), { attempted: false });
    }
    case "actions.submitLatest": {
      const params = parseLatestInputRequestParams(
        options.request.params,
        options.playerId,
      );
      const latest = options.state.latestActionRequest(
        params.interactionId,
        params.inputs,
      );
      const first = await callSubmitAction({
        sessionId: options.sessionId,
        playerId: options.playerId,
        submitAction: options.submitAction,
        params: latest,
      });
      options.state.applyGameplay(gameplayFromSubmitResult(first));
      if (!isActionSetStaleResponse(first)) {
        return withRetry(first, { attempted: false });
      }

      if (!options.state.hasInteraction(params.interactionId)) {
        return withRetry(first, {
          attempted: true,
          reason: "ACTION_SET_STALE",
        });
      }

      const refreshed = options.state.latestActionRequest(
        params.interactionId,
        params.inputs,
      );
      const validation = validateLocally(refreshed);
      if (isValidationRejected(validation)) {
        return withRetry(first, {
          attempted: true,
          reason: "ACTION_SET_STALE",
        });
      }

      const retryResult = await callSubmitAction({
        sessionId: options.sessionId,
        playerId: options.playerId,
        submitAction: options.submitAction,
        params: refreshed,
      });
      options.state.applyGameplay(gameplayFromSubmitResult(retryResult));
      return withRetry(retryResult, {
        attempted: true,
        reason: "ACTION_SET_STALE",
      });
    }
    case "actions.submit": {
      const params = parseInputRequestParams(
        options.request.params,
        options.playerId,
      );
      const { data, error, response } = await options.submitAction({
        path: {
          sessionId: options.sessionId,
          playerId: options.playerId,
          interactionId: params.interactionId,
        },
        body: {
          expectedVersion: params.expectedVersion,
          actionSetVersion: params.actionSetVersion,
          inputs: params.inputs,
        },
        headers: { "X-Dreamboard-Client-Action-Id": randomUUID() },
      });
      if (error || !data) {
        throw apiProtocolError(
          error,
          response,
          "Failed to submit interaction.",
        );
      }
      options.state.applyGameplay(gameplayFromSubmitResult(data));
      return data as unknown as JsonValue;
    }
    default:
      throw protocolError(
        "UNKNOWN_METHOD",
        `Unknown method '${options.request.method}'.`,
      );
  }
}

async function callSubmitAction(options: {
  sessionId: string;
  playerId: string;
  submitAction: SubmitPlayerAction;
  params: LatestActionRequest;
}): Promise<JsonValue> {
  const { data, error, response } = await options.submitAction({
    path: {
      sessionId: options.sessionId,
      playerId: options.playerId,
      interactionId: options.params.interactionId,
    },
    body: {
      expectedVersion: options.params.expectedVersion,
      actionSetVersion: options.params.actionSetVersion,
      inputs: options.params.inputs,
    },
    headers: { "X-Dreamboard-Client-Action-Id": randomUUID() },
  });
  if (error || !data) {
    throw apiProtocolError(error, response, "Failed to submit interaction.");
  }
  return data as unknown as JsonValue;
}

function gameplayFromSubmitResult(
  result: unknown,
): HostPlayerGameplayView | undefined {
  if (!isJsonObject(result)) {
    return undefined;
  }
  const event = result.event;
  if (!isJsonObject(event) || event.type !== "session.gameplayUpdated") {
    return undefined;
  }
  return event.gameplay as HostPlayerGameplayView | undefined;
}

function actionsFromActionSet(actionSet: {
  actions?: ReadonlyArray<InteractionDescriptorLike>;
  interactionsByRef?: Record<string, InteractionDescriptorLike | undefined>;
  availableInteractionRefs?: ReadonlyArray<string>;
}): InteractionDescriptorLike[] {
  if (Array.isArray(actionSet.actions)) {
    return [...actionSet.actions];
  }
  const registry = actionSet.interactionsByRef ?? {};
  return (actionSet.availableInteractionRefs ?? [])
    .map((ref) => registry[ref])
    .filter((action): action is InteractionDescriptorLike => Boolean(action));
}

function validateLocally(params: LatestActionRequest): JsonObject {
  return {
    valid: true,
    version: params.expectedVersion,
    actionSetVersion: params.actionSetVersion,
  };
}

function actionsFromGameplay(
  gameplay: HostPlayerGameplayView,
): InteractionDescriptorLike[] {
  const seat = gameplay.seats[gameplay.perspectivePlayerId];
  return actionsFromActionSet({
    interactionsByRef: gameplay.interactionsByRef,
    availableInteractionRefs: seat?.availableInteractionRefs ?? [],
  });
}

function normalizeActionSetForJsonl(actionSet: {
  version: number;
  actionSetVersion: string;
  actions?: ReadonlyArray<InteractionDescriptorLike>;
  interactionsByRef?: Record<string, InteractionDescriptorLike | undefined>;
  availableInteractionRefs?: ReadonlyArray<string>;
}): {
  version: number;
  actionSetVersion: string;
  actions: InteractionDescriptorLike[];
} {
  return {
    version: actionSet.version,
    actionSetVersion: actionSet.actionSetVersion,
    actions: actionsFromActionSet(actionSet),
  };
}

function withRetry(
  data: JsonValue,
  retry: { attempted: boolean; reason?: "ACTION_SET_STALE" },
): JsonValue {
  if (!isJsonObject(data)) {
    return { value: data, retry };
  }
  return {
    ...data,
    retry,
  };
}

function isActionSetStaleResponse(data: JsonValue): boolean {
  return isJsonObject(data) && data.errorCode === "ACTION_SET_STALE";
}

function isValidationRejected(data: JsonValue): boolean {
  return isJsonObject(data) && data.valid === false;
}

function parseRequestId(
  value: unknown,
): { ok: true; value: RequestId } | { ok: false; error: JoinProtocolError } {
  if (typeof value === "string" && value.length > 0) {
    return { ok: true, value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: protocolError(
      "MISSING_ID",
      "Every JSONL request must include a string or numeric id.",
    ),
  };
}

function requireObjectParams(params: unknown): JsonObject {
  if (params === undefined) {
    return {};
  }
  if (isJsonObject(params)) {
    return params;
  }
  throw protocolError("INVALID_PARAMS", "Request params must be an object.");
}

function parseInputRequestParams(
  rawParams: unknown,
  defaultPlayerId: string,
): {
  interactionId: string;
  expectedVersion: number;
  actionSetVersion: string;
  inputs: JsonObject;
} {
  const params = requireObjectParams(rawParams);
  const requestPlayerId = params.playerId;
  if (requestPlayerId !== undefined && requestPlayerId !== defaultPlayerId) {
    throw protocolError(
      "PLAYER_MISMATCH",
      `This join session is scoped to player '${defaultPlayerId}'.`,
    );
  }
  const expectedVersion = params.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isFinite(expectedVersion)
  ) {
    throw protocolError(
      "INVALID_PARAMS",
      "actions.validate and actions.submit require numeric expectedVersion.",
    );
  }
  const interactionParams = params.params;
  if (interactionParams !== undefined) {
    throw protocolError(
      "INVALID_PARAMS",
      "Use 'inputs' for action input payloads; 'params.params' is no longer supported.",
    );
  }
  const inputs = params.inputs;
  if (inputs !== undefined && !isJsonObject(inputs)) {
    throw protocolError(
      "INVALID_PARAMS",
      "Action inputs must be an object when provided.",
    );
  }
  return {
    interactionId: requireString(params, "interactionId"),
    expectedVersion,
    actionSetVersion: requireString(params, "actionSetVersion"),
    inputs: inputs ?? {},
  };
}

function parseLatestInputRequestParams(
  rawParams: unknown,
  defaultPlayerId: string,
): {
  interactionId: string;
  inputs: JsonObject;
} {
  const params = requireObjectParams(rawParams);
  const requestPlayerId = params.playerId;
  if (requestPlayerId !== undefined && requestPlayerId !== defaultPlayerId) {
    throw protocolError(
      "PLAYER_MISMATCH",
      `This join session is scoped to player '${defaultPlayerId}'.`,
    );
  }
  if (
    params.expectedVersion !== undefined ||
    params.actionSetVersion !== undefined
  ) {
    throw protocolError(
      "INVALID_PARAMS",
      "actions.validateLatest and actions.submitLatest fill expectedVersion and actionSetVersion automatically.",
    );
  }
  if (params.params !== undefined) {
    throw protocolError(
      "INVALID_PARAMS",
      "Use 'inputs' for action input payloads; 'params.params' is no longer supported.",
    );
  }
  const inputs = params.inputs;
  if (inputs !== undefined && !isJsonObject(inputs)) {
    throw protocolError(
      "INVALID_PARAMS",
      "Action inputs must be an object when provided.",
    );
  }
  return {
    interactionId: requireString(params, "interactionId"),
    inputs: inputs ?? {},
  };
}

function requireString(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw protocolError("INVALID_PARAMS", `Param '${key}' must be a string.`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(
  code: string,
  message: string,
  details?: JsonObject,
): JoinProtocolError {
  return { code, message, ...(details ? { details } : {}) };
}

function apiProtocolError(
  error: unknown,
  response: unknown,
  fallback: string,
): JoinProtocolError {
  const problem = toApiProblem(error as never, response as never, fallback);
  return protocolError(problem.type, problem.detail || problem.title, {
    status: problem.status,
    title: problem.title,
    detail: problem.detail,
    requestId: problem.requestId ?? null,
    retryable: problem.retryable ?? null,
  } as JsonObject);
}

function coerceProtocolError(error: unknown): JoinProtocolError {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return error as JoinProtocolError;
  }
  return protocolError("INTERNAL_ERROR", formatUnknown(error));
}

function formatUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
