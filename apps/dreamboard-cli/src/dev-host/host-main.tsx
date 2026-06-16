/// <reference lib="dom" />

import "./host-main.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  RotateCw,
  X,
} from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./components/drawer.js";
import { Input } from "./components/input.js";
import { client } from "@dreamboard-games/api-client/client.gen";
import {
  HostFeedbackToaster,
  HostHistoryNavigator,
  HostPlayerSwitcher,
  HostSessionMetadata,
  PerfOverlay,
  type HostControllablePlayer,
} from "@dreamboard-games/ui-host-runtime/components";
import {
  LongPollSessionManager,
  createGameplayAuthorityTransport,
  createUnifiedSessionStore,
  unifiedSessionSelectors,
  type HistoryState,
  type HostFeedback,
} from "@dreamboard-games/ui-host-runtime/runtime";
import devConfig from "virtual:dreamboard-dev-config";
import {
  createDevDiagnosticsLogger,
  formatConsoleArgs,
  resolveDevDiagnosticsLevel,
  shouldRelayDevLog,
  stringifyForRelay,
  type DevLogEnvelope,
} from "./dev-diagnostics.js";
import {
  DevHostController,
  type DevHostRuntimeError,
} from "./dev-host-controller.js";
import { createDevHostSessionTransport } from "./dev-host-session-transport.js";
import {
  SessionStorageDevHostStorage,
  type ActiveSession,
} from "./dev-host-storage.js";
import { resolveInitialDevHostPlayerId } from "./dev-host-player-query.js";

const diagnosticsLevel = resolveDevDiagnosticsLevel(devConfig.debug);
const devLogger = createDevDiagnosticsLogger(diagnosticsLevel);
const storage = new SessionStorageDevHostStorage(window.sessionStorage);
// Gameplay streaming and submits go through the Gameplay Authority WebSocket
// (the backend's event-batches stream is removed); snapshot/start/dev-session
// requests fall back to the dev-server endpoints.
const hostSessionTransport = createGameplayAuthorityTransport({
  fallbackTransport: createDevHostSessionTransport(),
  getCurrentSessionContext: () =>
    unifiedSessionSelectors.sessionContext(store.getState()),
  getCurrentGameplay: () =>
    unifiedSessionSelectors.gameplayViewport(store.getState()),
});
let runtimeDisposed = false;

type DevAuthorWarning = {
  id: string;
  title: string;
  message: string;
  source: DevLogEnvelope["source"];
};

let devAuthorWarnings: DevAuthorWarning[] = [];

const store = createUnifiedSessionStore({
  createSseManager: () =>
    new LongPollSessionManager({
      transport: hostSessionTransport,
      logger: {
        log: (...args: unknown[]) => {
          if (runtimeDisposed) {
            return;
          }
          devLogger.log(...args);
        },
        warn: (...args: unknown[]) => {
          if (runtimeDisposed) {
            return;
          }
          devLogger.warn(...args);
        },
        error: (...args: unknown[]) => {
          if (runtimeDisposed) {
            return;
          }
          devLogger.error(...args);
          controller.handleSseTransportError(args);
        },
      },
    }),
  logger: devLogger,
  transport: hostSessionTransport,
  fallbackToAllSeatsWhenUserIdMissing: !devConfig.userId,
});

const controller = new DevHostController(
  store,
  storage,
  {
    autoStartGame: devConfig.autoStartGame,
    compiledResultId: devConfig.compiledResultId,
    createDevSessionSnapshot: hostSessionTransport.createDevSessionSnapshot,
    debug: devConfig.debug,
    fallbackSession: devConfig.initialSession,
    gameId: devConfig.gameId,
    initialPlayerId: resolveInitialDevHostPlayerId(window.location.search),
    playerCount: devConfig.playerCount,
    setupProfileId: devConfig.setupProfileId,
    slug: devConfig.slug,
    userId: devConfig.userId,
  },
  devLogger,
);

// The browser never sees the bearer token. All backend traffic is
// same-origin and the CLI's reverse-proxy middleware (`/api/*`) injects
// `Authorization: Bearer <fresh>` on the wire.
client.setConfig({ baseUrl: "" });
installProxyAuthErrorInterceptor();

const app = document.getElementById("app");
if (!(app instanceof HTMLElement)) {
  throw new Error("Missing root app container.");
}
const root = createRoot(app);

function installProxyAuthErrorInterceptor(): void {
  client.interceptors.response.use(async (response) => {
    if (response.status !== 401) {
      return response;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return response;
    }
    // Clone first so downstream handlers can still read the body.
    const clone = response.clone();
    type AuthErrorPayload = { error?: unknown; message?: unknown };
    let payload: AuthErrorPayload | null = null;
    try {
      payload = (await clone.json()) as AuthErrorPayload;
    } catch {
      return response;
    }
    if (payload?.error !== "session_invalid") {
      return response;
    }
    const detail =
      typeof payload.message === "string" && payload.message.length > 0
        ? payload.message
        : "Stored Dreamboard session is no longer valid.";
    controller.reportRuntimeError({
      title: "Session expired",
      summary: `${detail} Run \`dreamboard login\` in your terminal, then reload this page.`,
      violations: [],
    });
    return response;
  });
}

const restoreConsoleRelay = installConsoleRelay("host");
const removeWindowErrorRelay = installWindowErrorRelay("host");
installSseRelay();
window.addEventListener("message", handlePluginLogMessage);
window.addEventListener("pagehide", disposeHostRuntime);
window.addEventListener("beforeunload", disposeHostRuntime);

const unsubscribeStoreRender = store.subscribe(() => {
  render();
});
const unsubscribeControllerRender = controller.subscribe(() => {
  render();
});

void controller.initialize();

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    disposeHostRuntime();
  });
}

function render(): void {
  if (runtimeDisposed) {
    return;
  }

  const state = store.getState();
  const controllerState = controller.getSnapshot();
  const session = state.getPluginSnapshot().session;
  const seats = unifiedSessionSelectors.seats(state);
  const controllablePlayers: HostControllablePlayer[] =
    session.controllablePlayerIds.map((playerId) => {
      const seat = seats.find((entry) => entry.playerId === playerId);
      return {
        playerId,
        displayName: seat?.displayName || playerId,
      };
    });
  const isHost = unifiedSessionSelectors.isSessionHost(state);
  const phase = unifiedSessionSelectors.sessionType(state);

  root.render(
    <DevHostApp
      session={controllerState.session}
      phase={phase}
      bootstrapStatus={unifiedSessionSelectors.bootstrapStatus(state)}
      isConnected={unifiedSessionSelectors.isConnected(state)}
      connectionError={unifiedSessionSelectors.connectionError(state)}
      runtimeError={controllerState.runtimeError}
      syncId={unifiedSessionSelectors.syncId(state)}
      pluginReady={controllerState.pluginReady}
      controllablePlayers={controllablePlayers}
      controllingPlayerId={
        unifiedSessionSelectors.currentPlayerId(state) ??
        session.controllingPlayerId
      }
      canStart={phase === "lobby" && unifiedSessionSelectors.canStart(state)}
      isHost={isHost}
      history={unifiedSessionSelectors.history(state)}
      hostFeedback={unifiedSessionSelectors.hostFeedback(state)}
      authorWarnings={devAuthorWarnings}
      iframeSrc={controllerState.iframeSrc}
      seedValue={controllerState.seedValue}
      isCreatingSession={controllerState.isCreatingSession}
      onSeedChange={(value) => controller.setSeedValue(value)}
      onCreateSession={() => void controller.createNewSession()}
      onStartGame={() => void controller.startGameFromSidebar()}
      onSwitchPlayer={(playerId) => controller.switchPlayer(playerId)}
      onRestoreHistory={(entryId) => controller.restoreHistoryEntry(entryId)}
      onDismissHostFeedback={(feedbackId) =>
        store.getState().dismissHostFeedback(feedbackId)
      }
      onDismissAuthorWarning={dismissDevAuthorWarning}
      onDismissRuntimeError={() => controller.dismissRuntimeError()}
      onRetryBootstrap={() => void controller.initialize()}
      onIframeReady={(element) => {
        controller.setIframe(element);
      }}
      onIframeLoad={() => {
        controller.onIframeLoad();
      }}
    />,
  );
}

type DevHostAppProps = {
  session: ActiveSession;
  phase: string;
  bootstrapStatus: "loading" | "lobby" | "renderable" | "error";
  isConnected: boolean;
  connectionError: string | null;
  runtimeError: DevHostRuntimeError | null;
  syncId: number;
  pluginReady: boolean;
  controllablePlayers: HostControllablePlayer[];
  controllingPlayerId: string | null;
  canStart: boolean;
  isHost: boolean;
  history: HistoryState | null;
  hostFeedback: HostFeedback[];
  authorWarnings: DevAuthorWarning[];
  iframeSrc: string;
  seedValue: string;
  isCreatingSession: boolean;
  onSeedChange: (value: string) => void;
  onCreateSession: () => void;
  onStartGame: () => void;
  onSwitchPlayer: (playerId: string) => void;
  onRestoreHistory: (entryId: string) => Promise<void>;
  onDismissHostFeedback: (feedbackId: string) => void;
  onDismissAuthorWarning: (warningId: string) => void;
  onDismissRuntimeError: () => void;
  onRetryBootstrap: () => void;
  onIframeReady: (element: HTMLIFrameElement | null) => void;
  onIframeLoad: () => void;
};

function DevHostApp({
  session,
  phase,
  bootstrapStatus,
  isConnected,
  connectionError,
  runtimeError,
  syncId,
  pluginReady,
  controllablePlayers,
  controllingPlayerId,
  canStart,
  isHost,
  history,
  hostFeedback,
  authorWarnings,
  iframeSrc,
  seedValue,
  isCreatingSession,
  onSeedChange,
  onCreateSession,
  onStartGame,
  onSwitchPlayer,
  onRestoreHistory,
  onDismissHostFeedback,
  onDismissAuthorWarning,
  onDismissRuntimeError,
  onRetryBootstrap,
  onIframeReady,
  onIframeLoad,
}: DevHostAppProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(() =>
    storage.loadSidebarOpen(),
  );
  const needsBootstrap = phase !== "error" && bootstrapStatus === "loading";

  const handleToggleSidebar = (open: boolean) => {
    setIsSidebarOpen(open);
    storage.persistSidebarOpen(open);
  };

  // ⌘. / Ctrl+. toggles the dev drawer. Cheap, doesn't fight typical
  // game-side keybindings, and discoverable via the edge-tab tooltip.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ".") {
        return;
      }
      event.preventDefault();
      handleToggleSidebar(!isSidebarOpen);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarOpen]);

  const primaryAction = canStart
    ? { label: "Start Game", handler: onStartGame, disabled: false }
    : {
        label: isCreatingSession ? "Creating…" : "New Session",
        handler: onCreateSession,
        disabled: isCreatingSession,
      };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-transparent font-sans text-foreground">
      <HostFeedbackToaster
        feedback={hostFeedback}
        onDismiss={onDismissHostFeedback}
      />
      <DevAuthorWarningPanel
        warnings={authorWarnings}
        onDismiss={onDismissAuthorWarning}
      />
      <main className="absolute inset-0 z-0 flex flex-col bg-transparent">
        <iframe
          ref={onIframeReady}
          src={iframeSrc}
          referrerPolicy="no-referrer"
          title="Dreamboard UI Plugin"
          className="h-full w-full flex-1 border-0 bg-background"
          onLoad={onIframeLoad}
        />
        {needsBootstrap ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#fdfbf7]/92 px-6 text-center backdrop-blur-[2px]">
            <div className="max-w-md rounded-2xl border border-border/30 bg-white px-5 py-4 shadow-[0_24px_60px_-12px_rgba(45,45,45,0.25),0_8px_20px_-8px_rgba(45,45,45,0.18)]">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                Dev host
              </p>
              <h2 className="mt-2 font-display text-xl text-foreground">
                Waiting for session bootstrap
              </h2>
              <p className="mt-3 text-sm font-medium text-foreground">
                Attaching to{" "}
                <span className="font-bold">{session.shortCode}</span>.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                The host will create a fresh session automatically if the
                current one cannot finish bootstrapping.
              </p>
              {connectionError ? (
                <p className="mt-3 rounded-md border border-border/30 bg-[#ffe1d6] px-3 py-2 text-sm font-semibold text-foreground">
                  {connectionError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {runtimeError ? (
          <RuntimeErrorOverlay
            error={runtimeError}
            onDismiss={onDismissRuntimeError}
            onRetry={onRetryBootstrap}
          />
        ) : null}
      </main>

      <Drawer
        open={isSidebarOpen}
        onOpenChange={handleToggleSidebar}
        direction="left"
      >
        {!isSidebarOpen ? (
          <DrawerTrigger asChild>
            <button
              type="button"
              aria-label="Open Dev Tools (⌘.)"
              title="Open Dev Tools (⌘.)"
              className="dev-edge-handle group fixed left-0 top-0 z-40 flex h-full w-4 cursor-pointer items-center justify-start"
            >
              <span className="dev-edge-strip block h-24 w-[3px] rounded-r-full bg-border/25" />
            </button>
          </DrawerTrigger>
        ) : null}

        <DrawerContent className="h-full w-[340px] max-w-[calc(100vw-1rem)] border-r border-border/20 bg-[#fdfbf7] p-0 rounded-r-2xl shadow-[8px_0_32px_-8px_rgba(45,45,45,0.18),2px_0_8px_-2px_rgba(45,45,45,0.12)]">
          <div className="flex h-full flex-col overflow-hidden">
            <DrawerHeader className="flex flex-row items-center justify-between gap-3 px-6 pb-3 pt-6">
              <DrawerDescription className="sr-only">
                Developer controls for the local Dreamboard host session. Press
                ⌘ + period to toggle.
              </DrawerDescription>
              <DrawerTitle className="min-w-0 flex-1 truncate font-display text-2xl leading-tight text-foreground">
                {devConfig.slug}
              </DrawerTitle>
              <DrawerClose asChild>
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground"
                  title="Hide Dev Tools (⌘.)"
                  aria-label="Hide Dev Tools (⌘.)"
                >
                  <X className="h-4 w-4" />
                </button>
              </DrawerClose>
            </DrawerHeader>

            <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">
              <ShortCodeRow shortCode={session.shortCode} />

              <SectionHeading className="mt-7">Play as</SectionHeading>
              <div className="mt-2.5">
                <HostPlayerSwitcher
                  controllablePlayers={controllablePlayers}
                  controllingPlayerId={controllingPlayerId}
                  onSwitchPlayer={onSwitchPlayer}
                  className="w-full min-w-0"
                />
              </div>
              <div className="dev-history-shell mt-2 flex justify-start">
                <HostHistoryNavigator
                  isHost={isHost}
                  history={history}
                  onRestoreHistory={onRestoreHistory}
                />
              </div>

              <SectionHeading className="mt-7">Seed</SectionHeading>
              <Input
                id="seed-input"
                type="number"
                inputMode="numeric"
                className="dev-seed-input mt-2.5 h-10 text-sm"
                value={seedValue}
                onChange={(event) => onSeedChange(event.target.value)}
              />
              <button
                type="button"
                className="dev-calm-button mt-3 w-full"
                disabled={primaryAction.disabled}
                onClick={primaryAction.handler}
              >
                {primaryAction.label}
              </button>

              <details className="dev-debug-fold group/debug mt-7">
                <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground group-open/debug:text-foreground">
                  <ChevronDown className="h-3.5 w-3.5 -rotate-90 transition-transform group-open/debug:rotate-0" />
                  Debug
                </summary>
                <div className="dev-host-debug-shell mt-3 space-y-3 pb-1">
                  <HostSessionMetadata
                    gameId={session.gameId}
                    sessionId={session.sessionId}
                    shortCode={session.shortCode}
                  />
                  <DebugRow label="Backend" value={devConfig.apiBaseUrl} />
                </div>
              </details>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
      <PerfOverlay />
    </div>
  );
}

function SectionHeading({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={
        "text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground" +
        (className ? ` ${className}` : "")
      }
    >
      {children}
    </p>
  );
}

function ShortCodeRow({ shortCode }: { shortCode: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeoutId = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const handleCopy = async () => {
    if (!shortCode || !navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shortCode);
      setCopied(true);
    } catch {
      // Clipboard failures are non-fatal.
    }
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate font-mono text-base font-bold text-foreground">
        {shortCode}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground"
        title={copied ? "Copied" : "Copy short code"}
        aria-label={copied ? "Copied" : "Copy short code"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-all text-right font-mono text-foreground">
        {value}
      </span>
    </div>
  );
}

function DevAuthorWarningPanel({
  warnings,
  onDismiss,
}: {
  warnings: DevAuthorWarning[];
  onDismiss: (warningId: string) => void;
}) {
  if (warnings.length === 0) return null;

  return (
    <aside
      aria-label="Author warnings"
      className="pointer-events-none fixed right-4 top-4 z-30 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
    >
      {warnings.map((warning) => (
        <div
          key={warning.id}
          className="pointer-events-auto rounded-lg border-2 border-[#2d2d2d] bg-[#fff7d6] p-3 shadow-[4px_4px_0_#2d2d2d]"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                Author warning · {warning.source}
              </p>
              <h2 className="mt-1 text-sm font-bold text-foreground">
                {warning.title}
              </h2>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs font-medium leading-relaxed text-foreground/80">
                {warning.message}
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground"
              title="Dismiss author warning"
              aria-label="Dismiss author warning"
              onClick={() => onDismiss(warning.id)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}

/**
 * Full-viewport overlay that surfaces runtime failures (e.g. reducer
 * `initialize` rejections, session-start 500s) to the game author instead of
 * burying them in the backend log. Each violation is rendered as its own
 * block so the JS stack trace — which the backend already parses into a
 * separate violation entry — stays readable with file/line detail intact.
 */
function RuntimeErrorOverlay({
  error,
  onDismiss,
  onRetry,
}: {
  error: DevHostRuntimeError;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const headlineViolation =
    error.violations.length > 0 ? error.violations[0] : null;
  const stackViolations = error.violations.slice(1);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#2d2d2d]/70 px-6 py-8 backdrop-blur-[2px]">
      <div className="relative max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-[#fff7e5] shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border bg-[#ffd3d3] px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/70">
              Runtime error
            </p>
            <h2 className="mt-1 text-xl font-semibold text-foreground">
              {error.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md border border-border bg-white p-1.5 transition-colors hover:bg-accent"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(85vh-88px)] overflow-y-auto px-5 py-4">
          <p className="text-sm font-medium text-foreground">{error.summary}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
            >
              <RotateCw className="h-4 w-4" />
              Retry Bootstrap
            </button>
          </div>
          {headlineViolation ? (
            <div className="mt-4 rounded-md border border-border bg-white px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {headlineViolation.code ?? "message"}
                {headlineViolation.field ? ` · ${headlineViolation.field}` : ""}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm font-semibold text-foreground">
                {headlineViolation.message}
              </p>
            </div>
          ) : null}
          {stackViolations.length > 0 ? (
            <details className="mt-4" open>
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground/70">
                Stack trace
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-[#1f1f1f] p-3 text-[11px] leading-relaxed text-[#f8f8f2]">
                {stackViolations
                  .map((violation) => violation.message)
                  .join("\n")}
              </pre>
            </details>
          ) : null}
          {error.correlationId ? (
            <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Request ID · {error.correlationId}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function installSseRelay(): void {
  let lastLoggedEventId = 0;
  store.subscribe((state) => {
    const nextEntries = unifiedSessionSelectors
      .sseEvents(state)
      .filter((entry) => entry.id > lastLoggedEventId);
    if (nextEntries.length === 0) {
      return;
    }

    for (const entry of nextEntries) {
      lastLoggedEventId = entry.id;
      relayBrowserLog({
        source: "sse",
        level: "info",
        message: devConfig.debug
          ? `${entry.eventType} ${stringifyForRelay(entry.data)}`
          : `${entry.eventType} toUser=${getMessageRecipient(entry.data) ?? "-"}`,
      });
    }
  });
}

function getMessageRecipient(message: unknown): unknown {
  return message && typeof message === "object" && "toUser" in message
    ? (message as { toUser?: unknown }).toUser
    : null;
}

function installConsoleRelay(source: "host"): () => void {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    original.log(...args);
    relayBrowserLog({
      source,
      level: "log",
      message: formatConsoleArgs(args),
    });
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    relayBrowserLog({
      source,
      level: "warn",
      message: formatConsoleArgs(args),
    });
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    relayBrowserLog({
      source,
      level: "error",
      message: formatConsoleArgs(args),
    });
  };

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}

function installWindowErrorRelay(source: "host"): () => void {
  const onError = (event: ErrorEvent) => {
    if (runtimeDisposed || shouldIgnoreBrowserError(event.error)) {
      return;
    }
    relayBrowserLog({
      source,
      level: "error",
      message: `window.error ${event.message}`,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (runtimeDisposed || shouldIgnoreBrowserError(event.reason)) {
      return;
    }
    relayBrowserLog({
      source,
      level: "error",
      message: `unhandledrejection ${stringifyForRelay(event.reason)}`,
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

function handlePluginLogMessage(event: MessageEvent): void {
  if (!controller.matchesPluginWindow(event.source)) {
    return;
  }

  const payload = event.data as Partial<DevLogEnvelope> & { type?: string };
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.type !== "dreamboard-dev-console"
  ) {
    return;
  }

  relayBrowserLog({
    source: "plugin",
    level:
      payload.level === "warn" ||
      payload.level === "error" ||
      payload.level === "log"
        ? payload.level
        : "log",
    message:
      typeof payload.message === "string"
        ? payload.message
        : stringifyForRelay(payload.message),
  });

  if (payload.level === "error" && typeof payload.message === "string") {
    maybeAddDevAuthorWarning({
      source: "plugin",
      message: payload.message,
    });
  }
}

function relayBrowserLog(payload: DevLogEnvelope): void {
  if (runtimeDisposed || !shouldRelayDevLog(diagnosticsLevel, payload)) {
    return;
  }

  void fetch("/__dreamboard_dev/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Ignore log relay failures to avoid recursive console noise.
  });
}

function maybeAddDevAuthorWarning({
  source,
  message,
}: {
  source: DevLogEnvelope["source"];
  message: string;
}): void {
  const parsed = parseDevAuthorWarning(message);
  if (!parsed) return;
  const id = `${source}:${parsed.title}:${parsed.message}`;
  if (devAuthorWarnings.some((warning) => warning.id === id)) {
    return;
  }
  devAuthorWarnings = [
    { id, source, title: parsed.title, message: parsed.message },
    ...devAuthorWarnings,
  ].slice(0, 4);
  render();
}

function dismissDevAuthorWarning(warningId: string): void {
  const nextWarnings = devAuthorWarnings.filter(
    (warning) => warning.id !== warningId,
  );
  if (nextWarnings.length === devAuthorWarnings.length) {
    return;
  }
  devAuthorWarnings = nextWarnings;
  render();
}

function parseDevAuthorWarning(
  message: string,
): { title: string; message: string } | null {
  if (!message.startsWith("[dreamboard] ")) {
    return null;
  }
  if (message.includes("Ambiguous Board.")) {
    return {
      title: "Ambiguous board target",
      message,
    };
  }
  return null;
}

function disposeHostRuntime(): void {
  if (runtimeDisposed) {
    return;
  }

  runtimeDisposed = true;
  removeWindowErrorRelay();
  restoreConsoleRelay();
  window.removeEventListener("message", handlePluginLogMessage);
  window.removeEventListener("pagehide", disposeHostRuntime);
  window.removeEventListener("beforeunload", disposeHostRuntime);
  unsubscribeStoreRender();
  unsubscribeControllerRender();
  controller.dispose();
  root.unmount();
}

function shouldIgnoreBrowserError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
