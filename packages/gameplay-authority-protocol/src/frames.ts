import { z } from "zod";
import {
  GameOutcomeSchema,
  InteractionResultSchema,
  PluginGameplayFrameSchema,
  BoardStaticProjectionSchema,
  SubmitInteractionCommandSchema,
} from "@dreamboard-games/sdk/plugin-runtime-contract";

export const GameplayCloseCode = {
  GoingAway: 1001,
  CredentialExpired: 4000,
  CredentialInvalid: 4001,
  RefreshContextMismatch: 4002,
  PermissionDenied: 4100,
  ProtocolViolation: 4200,
  FrameBeforeAuth: 4201,
  SlowConsumer: 4300,
  TooManyRequests: 4301,
} as const;

export const GameplayPermissionSchema = z.enum([
  "observe",
  "submit",
  "restore-history",
]);
export const GameplayConnectionContextSchema = z.object({
  sessionId: z.string().uuid(),
  playerId: z.string().min(1),
  permissions: z.array(GameplayPermissionSchema),
});
export const GameplayCredentialSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("user"), token: z.string().min(1).max(16384) })
    .strict(),
  z
    .object({ kind: z.literal("demo"), secret: z.string().min(1).max(1024) })
    .strict(),
]);
export const AuthConnectFrameSchema = z
  .object({
    type: z.literal("auth.connect"),
    credential: GameplayCredentialSchema,
    sessionId: z.string().uuid(),
    playerId: z.string().min(1).max(128),
  })
  .strict();
export const AuthRefreshFrameSchema = z
  .object({
    type: z.literal("auth.refresh"),
    credential: GameplayCredentialSchema,
  })
  .strict();

export const SessionResumeFrameSchema = z.object({
  type: z.literal("session.resume"),
  lastSeenLogCursor: z.number().int().nonnegative().nullable(),
  unacknowledgedClientActionIds: z.array(z.string().min(1)).max(32),
});

export const HistoryRestoreFrameSchema = z
  .object({
    type: z.literal("history.restore"),
    restoreId: z.string().min(1).max(128),
    targetVersion: z.number().int().positive(),
  })
  .strict();

export const ClientGameplayFrameSchema = z.discriminatedUnion("type", [
  AuthConnectFrameSchema,
  AuthRefreshFrameSchema,
  SessionResumeFrameSchema,
  SubmitInteractionCommandSchema,
  HistoryRestoreFrameSchema,
]);

export const HistoryRestoredFrameSchema = z.object({
  type: z.literal("history.restored"),
  restoreId: z.string().min(1),
  version: z.number().int().positive(),
});

export const HistoryRestoreRejectedFrameSchema = z.object({
  type: z.literal("history.restoreRejected"),
  restoreId: z.string().min(1),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  currentVersion: z.number().int().nonnegative().optional(),
});

export const AuthAcceptedFrameSchema = z.object({
  type: z.literal("auth.accepted"),
  expiresAt: z.string().datetime(),
});

export const GameplayBackpressureReasonSchema = z.enum([
  "queue_full",
  "capacity_full",
]);
export const GameplayBackpressureOperationSchema = z.enum([
  "session.resume",
  "interaction.submit",
  "history.restore",
]);

export const GameplayBackpressureFrameSchema = z.object({
  type: z.literal("gameplay.backpressure"),
  reason: GameplayBackpressureReasonSchema,
  retryAfterMs: z.number().int().positive(),
  message: z.string().min(1),
  operation: GameplayBackpressureOperationSchema,
  clientActionId: z.string().min(1).optional(),
  restoreId: z.string().min(1).optional(),
});

export const GameplayHistoryEntrySchema = z.object({
  version: z.number().int().positive(),
  timestamp: z.string().datetime(),
  description: z.string().min(1),
  playerId: z.string().min(1).optional(),
  isCurrent: z.boolean(),
});

export const GameplayHistorySchema = z.object({
  entries: z.array(GameplayHistoryEntrySchema).max(200),
});

export const GameplayLifecycleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active") }),
  z.object({
    status: z.literal("ended"),
    outcome: GameOutcomeSchema,
    endedAt: z.string().datetime(),
  }),
]);

export const SessionSnapshotFrameSchema = z.object({
  type: z.literal("session.snapshot"),
  frame: PluginGameplayFrameSchema,
  boardStatic: BoardStaticProjectionSchema.nullable(),
  history: GameplayHistorySchema,
  lifecycle: GameplayLifecycleSchema,
});

export const GameplayLogEntrySchema = z.object({
  cursor: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  clientActionId: z.string().min(1).optional(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1).max(4096),
  timestamp: z.string().datetime(),
});

export const GameplayLogsFrameSchema = z.object({
  type: z.literal("gameplay.logs"),
  cursor: z.number().int().nonnegative(),
  entries: z.array(GameplayLogEntrySchema).min(1).max(100),
});

export const GameplayLogsResetFrameSchema = z.object({
  type: z.literal("gameplay.logs.reset"),
  cursor: z.number().int().nonnegative(),
  reason: z.enum(["retention-gap", "owner-replaced"]),
});

export const ServerGameplayFrameSchema = z.discriminatedUnion("type", [
  AuthAcceptedFrameSchema,
  GameplayBackpressureFrameSchema,
  SessionSnapshotFrameSchema,
  GameplayLogsFrameSchema,
  GameplayLogsResetFrameSchema,
  InteractionResultSchema,
  HistoryRestoredFrameSchema,
  HistoryRestoreRejectedFrameSchema,
]);

export type ClientGameplayFrame = z.infer<typeof ClientGameplayFrameSchema>;
export type ServerGameplayFrame = z.infer<typeof ServerGameplayFrameSchema>;
export type SubmitInteractionCommand = z.infer<
  typeof SubmitInteractionCommandSchema
>;
export type InteractionResult = z.infer<typeof InteractionResultSchema>;
export type GameplayLogEntry = z.infer<typeof GameplayLogEntrySchema>;
export type GameplayLogsFrame = z.infer<typeof GameplayLogsFrameSchema>;
export type GameplayLogsResetFrame = z.infer<
  typeof GameplayLogsResetFrameSchema
>;
export type GameplayBackpressureFrame = z.infer<
  typeof GameplayBackpressureFrameSchema
>;
export type GameplayBackpressureReason = z.infer<
  typeof GameplayBackpressureReasonSchema
>;
export type GameplayBackpressureOperation = z.infer<
  typeof GameplayBackpressureOperationSchema
>;
export type HistoryRestoreFrame = z.infer<typeof HistoryRestoreFrameSchema>;
export type HistoryRestoredFrame = z.infer<typeof HistoryRestoredFrameSchema>;
export type GameplayPermission = z.infer<typeof GameplayPermissionSchema>;
export type GameplayHistory = z.infer<typeof GameplayHistorySchema>;
export type GameplayLifecycle = z.infer<typeof GameplayLifecycleSchema>;
export type GameplayConnectionContext = z.infer<
  typeof GameplayConnectionContextSchema
>;
export type GameplayCloseCode =
  (typeof GameplayCloseCode)[keyof typeof GameplayCloseCode];

export type GameplayCredential = z.infer<typeof GameplayCredentialSchema>;
