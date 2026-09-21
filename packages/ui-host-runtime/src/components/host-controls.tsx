import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from "./host-primitives.js";
import {
  Check,
  ChevronDown,
  Clock3,
  History,
  RotateCcw,
  Sparkles,
  Users,
} from "lucide-react";
import type { HistoryState } from "../unified-session-store.js";
import {
  createHostSwitchControlledPlayerActuatorAttributes,
  createHostSwitchControlledPlayerMenuTriggerAttributes,
  createHostSwitchControlledPlayerRootAttributes,
} from "../browser-interaction.js";

export interface HostControllablePlayer {
  playerId: string;
  displayName: string;
}

export interface HostPlayerSwitcherProps {
  controllablePlayers: HostControllablePlayer[];
  controllingPlayerId: string | null;
  onSwitchPlayer: (playerId: string) => void;
  className?: string;
}

export interface HostHistoryNavigatorProps {
  isHost: boolean;
  history: HistoryState | null;
  onRestoreHistory: (target: { version: number }) => Promise<void> | void;
  className?: string;
}

export interface HostSessionToolbarProps {
  children: React.ReactNode;
  className?: string;
}

function formatHistoryTimestamp(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return timestamp;
  }
}

export function HostSessionToolbar({
  children,
  className,
}: HostSessionToolbarProps) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2", className)}
    >
      {children}
    </div>
  );
}

export function HostPlayerSwitcher({
  controllablePlayers,
  controllingPlayerId,
  onSwitchPlayer,
  className,
}: HostPlayerSwitcherProps) {
  const currentPlayer = useMemo(
    () =>
      controllablePlayers.find(
        (player) => player.playerId === controllingPlayerId,
      ) ?? controllablePlayers[0],
    [controllablePlayers, controllingPlayerId],
  );
  const switchRootAttributes = createHostSwitchControlledPlayerRootAttributes();
  const switchMenuTriggerAttributes =
    createHostSwitchControlledPlayerMenuTriggerAttributes();

  if (controllablePlayers.length <= 1) {
    return null;
  }

  // Designer's Notebook: the trigger button is the ONE punctuation moment
  // for this control (wobbly + hard shadow). The dropdown contents below are
  // intentionally calm — plain rows, no rotation, no per-row wobbly borders.
  return (
    <div {...switchRootAttributes}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "group h-auto min-h-14 min-w-[220px] justify-between gap-3 border-[3px] border-border bg-white px-4 py-3 text-left text-foreground hard-shadow transition-all hover:bg-[#fff9c4] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0px_0px_#2d2d2d] wobbly-border-md",
              className,
            )}
            {...switchMenuTriggerAttributes}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-border bg-[#e7eefc] text-[#2d5da1]">
                <Users className="h-4 w-4 text-[#2d5da1]" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Seat Control
                </span>
                <span className="block truncate font-display text-lg leading-none text-foreground">
                  {currentPlayer?.displayName ?? "Choose player"}
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {currentPlayer?.playerId ?? "Switch the active seat"}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Badge
                variant="secondary"
                className="border border-border/40 bg-[#efe7da] px-2.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-foreground shadow-none"
              >
                {controllablePlayers.length} seats
              </Badge>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="z-[80] w-[22rem] border-2 border-border bg-[#fdfbf7] p-2 font-sans"
        >
          <DropdownMenuLabel className="px-2 pb-3 pt-1">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Play As
                </p>
                <p className="mt-1 font-display text-xl leading-none text-foreground">
                  Switch the active seat
                </p>
              </div>
              <Sparkles className="h-5 w-5 text-primary shrink-0" />
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="mx-1 border-b border-border/40 bg-transparent" />
          <DropdownMenuRadioGroup
            {...switchRootAttributes}
            value={controllingPlayerId ?? ""}
            onValueChange={(playerId) => {
              if (playerId !== controllingPlayerId) {
                onSwitchPlayer(playerId);
              }
            }}
          >
            {controllablePlayers.map((player, index) => (
              <DropdownMenuRadioItem
                key={player.playerId}
                value={player.playerId}
                {...createHostSwitchControlledPlayerActuatorAttributes({
                  playerId: player.playerId,
                  selected: player.playerId === controllingPlayerId,
                  enabled: true,
                })}
                className="mb-1 rounded-none border-2 border-transparent bg-white px-3 py-3 transition-colors focus:border-border/40 focus:bg-[#fff9c4] focus:text-foreground focus:outline-none data-[state=checked]:border-border data-[state=checked]:bg-[#fff9c4] data-[state=checked]:text-foreground [&>span]:hidden"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center border-2 border-border bg-[#efe7da] text-sm font-bold text-foreground">
                    {index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-display text-lg leading-none">
                      {player.displayName}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {player.playerId}
                    </span>
                  </div>
                  {player.playerId === controllingPlayerId ? (
                    <Check className="ml-auto h-5 w-5 shrink-0 text-primary" />
                  ) : null}
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function HostHistoryNavigator({
  isHost,
  history,
  onRestoreHistory,
  className,
}: HostHistoryNavigatorProps) {
  const [open, setOpen] = useState(false);
  const [confirmEntryId, setConfirmEntryId] = useState<string | null>(null);
  const [restoringEntryId, setRestoringEntryId] = useState<string | null>(null);
  const [popoverContainer, setPopoverContainer] = useState<HTMLElement | null>(
    null,
  );
  const capturePopoverContainer = useCallback((node: HTMLDivElement | null) => {
    const container = node?.closest("[data-slot='drawer-content']");
    setPopoverContainer(container instanceof HTMLElement ? container : null);
  }, []);

  const entries = useMemo(
    () => (history ? [...history.entries].reverse() : []),
    [history],
  );

  if (!isHost || !history || history.entries.length === 0) {
    return null;
  }

  const handleRestoreClick = async (entry: HistoryState["entries"][number]) => {
    const entryId = `${entry.version}`;
    if (confirmEntryId !== entryId) {
      setConfirmEntryId(entryId);
      return;
    }

    setRestoringEntryId(entryId);
    try {
      await onRestoreHistory({
        version: entry.version,
      });
      setOpen(false);
      setConfirmEntryId(null);
    } finally {
      setRestoringEntryId(null);
    }
  };

  return (
    <div ref={capturePopoverContainer}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setConfirmEntryId(null);
          }
        }}
      >
        <PopoverTrigger asChild>
          {/* Calm secondary control — the player switcher is the loud one
              in this toolbar; history is its quiet sibling. */}
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-10 gap-2 border-2 border-border bg-white text-foreground transition-colors hover:bg-[#e5e0d8]",
              className,
            )}
          >
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="hidden sm:inline">History</span>
            <Badge
              variant="secondary"
              className="border border-border/40 bg-[#fff9c4] text-foreground"
            >
              {history.entries.length}
            </Badge>
          </Button>
        </PopoverTrigger>
        {/* Designer's Notebook: trigger above is the punctuation moment.
            Popover contents are calm — plain bordered rows, no per-row
            wobbly. Restore CTA only "presses" via translate, no inflation. */}
        <PopoverContent
          container={popoverContainer}
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={16}
          style={{ zIndex: 200 }}
          className="z-[200] w-[26rem] border-2 border-border bg-[#fdfbf7] p-0"
        >
          <div className="border-b-2 border-border bg-white px-4 py-3">
            <div className="flex items-center gap-2 font-display text-base">
              <History className="h-4 w-4" />
              Session History
            </div>
            <p className="mt-1 font-sans text-xs text-muted-foreground">
              Restore a previous game state. This affects the shared host
              session.
            </p>
          </div>
          <ScrollArea className="max-h-80">
            <div className="space-y-2 p-3">
              {entries.map((entry: HistoryState["entries"][number]) => {
                const entryId = `${entry.version}`;
                const isConfirming = confirmEntryId === entryId;
                const isRestoring = restoringEntryId === entryId;

                return (
                  <div
                    key={entryId}
                    className={cn(
                      "border-2 border-border px-3 py-3 transition-colors",
                      entry.isCurrent ? "bg-[#fff9c4]" : "bg-white",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {entry.description}
                          </span>
                          {entry.isCurrent && (
                            <Badge
                              variant="secondary"
                              className="shrink-0 border border-border/40 bg-[#e5e0d8] text-foreground"
                            >
                              Current
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock3 className="h-3.5 w-3.5" />
                          <span>{formatHistoryTimestamp(entry.timestamp)}</span>
                          <span>v{entry.version}</span>
                        </div>
                      </div>
                      {!entry.isCurrent && (
                        <Button
                          size="sm"
                          variant={isConfirming ? "default" : "outline"}
                          className="shrink-0"
                          disabled={isRestoring}
                          onClick={() => void handleRestoreClick(entry)}
                        >
                          {isRestoring ? (
                            "Restoring..."
                          ) : isConfirming ? (
                            <>
                              <Check className="mr-1 h-4 w-4" />
                              Confirm
                            </>
                          ) : (
                            <>
                              <RotateCcw className="mr-1 h-4 w-4" />
                              Restore
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
