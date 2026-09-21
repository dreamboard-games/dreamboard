import { useMemo, useState } from "react";
import {
  HostPlayerSwitcher,
  HostSessionToolbar,
  type HostControllablePlayer,
} from "../host-controls.js";

const PLAYERS: HostControllablePlayer[] = [
  { playerId: "player-1", displayName: "Test" },
  { playerId: "player-2", displayName: "Test 2" },
  { playerId: "player-3", displayName: "Test 3" },
];

function FixtureFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="inline-block border-[3px] border-border bg-[#fff9c4] px-4 py-2 font-display text-2xl hard-shadow wobbly-border-md">
          Host Runtime Fixtures
        </div>
        {children}
      </div>
    </div>
  );
}

function InteractivePlayerSwitcher() {
  const [controllingPlayerId, setControllingPlayerId] = useState("player-1");
  const [switchEvents, setSwitchEvents] = useState<string[]>([]);
  const currentPlayer = useMemo(
    () =>
      PLAYERS.find((player) => player.playerId === controllingPlayerId) ??
      PLAYERS[0],
    [controllingPlayerId],
  );

  return (
    <FixtureFrame>
      <section className="space-y-4 border-[3px] border-border bg-[#fffdf7] p-6 hard-shadow wobbly-border-lg">
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Player Switcher
          </p>
          <h2 className="font-display text-3xl">Interactive seat control</h2>
          <p className="max-w-xl text-base text-foreground/75">
            Use this fixture to verify the dropdown opens above overlays and the
            active seat updates after selection.
          </p>
        </div>

        <HostSessionToolbar className="justify-start">
          <HostPlayerSwitcher
            controllablePlayers={PLAYERS}
            controllingPlayerId={controllingPlayerId}
            onSwitchPlayer={(playerId) => {
              setControllingPlayerId(playerId);
              setSwitchEvents((current) => [playerId, ...current].slice(0, 5));
            }}
          />
        </HostSessionToolbar>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="border-[3px] border-border bg-white p-4 wobbly-border-md">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Active Seat
            </p>
            <p className="mt-2 font-display text-2xl">
              {currentPlayer.displayName}
            </p>
            <p className="text-sm font-bold text-muted-foreground">
              {currentPlayer.playerId}
            </p>
          </div>
          <div className="border-[3px] border-border bg-[#e5e0d8] p-4 wobbly-border-md">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Last Switch Events
            </p>
            <div className="mt-2 space-y-1 text-sm font-bold">
              {switchEvents.length > 0 ? (
                switchEvents.map((playerId, index) => (
                  <p key={`${playerId}-${index}`}>{playerId}</p>
                ))
              ) : (
                <p className="text-muted-foreground">No switches yet</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </FixtureFrame>
  );
}

export default {
  interactive: <InteractivePlayerSwitcher />,
};
