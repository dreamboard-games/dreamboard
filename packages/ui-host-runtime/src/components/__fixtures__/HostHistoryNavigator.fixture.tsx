import { useMemo, useState } from "react";
import { HostHistoryNavigator, HostSessionToolbar } from "../host-controls.js";
import type { HistoryState } from "../../unified-session-store.js";

const HISTORY: HistoryState = {
  currentIndex: 2,
  canGoBack: true,
  canGoForward: false,
  entries: [
    {
      id: "entry-1",
      description: "Session created",
      timestamp: "2026-03-25T09:00:00.000Z",
      version: 1,
      isCurrent: false,
    },
    {
      id: "entry-2",
      description: "Player switched to Test 2",
      timestamp: "2026-03-25T09:02:00.000Z",
      version: 2,
      isCurrent: false,
    },
    {
      id: "entry-3",
      description: "Current turn synced",
      timestamp: "2026-03-25T09:04:00.000Z",
      version: 3,
      isCurrent: true,
    },
  ],
};

function HistoryFixture() {
  const [restoredEntryId, setRestoredEntryId] = useState<string | null>(null);
  const lastRestoreDescription = useMemo(
    () =>
      HISTORY.entries.find((entry) => entry.id === restoredEntryId)
        ?.description ?? "Nothing restored yet",
    [restoredEntryId],
  );

  return (
    <div className="min-h-screen p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="space-y-4 border-[3px] border-border bg-[#fffdf7] p-6 hard-shadow wobbly-border-lg">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              History Navigator
            </p>
            <h2 className="font-display text-3xl">Restore flow preview</h2>
          </div>

          <HostSessionToolbar className="justify-start">
            <HostHistoryNavigator
              isHost={true}
              history={HISTORY}
              onRestoreHistory={async (entryId) => {
                setRestoredEntryId(entryId);
              }}
            />
          </HostSessionToolbar>

          <div className="border-[3px] border-border bg-[#e5e0d8] p-4 wobbly-border-md">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Last Restored Entry
            </p>
            <p className="mt-2 text-lg font-bold">{lastRestoreDescription}</p>
          </div>
        </section>
      </div>
    </div>
  );
}

export default {
  default: <HistoryFixture />,
};
