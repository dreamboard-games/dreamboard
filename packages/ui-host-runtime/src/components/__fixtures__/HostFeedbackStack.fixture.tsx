import { useState } from "react";
import { HostFeedbackStack } from "../host-feedback.js";
import type { HostFeedback } from "../../unified-session-store.js";

const INITIAL_FEEDBACK: HostFeedback[] = [
  {
    id: "feedback-1",
    type: "YOUR_TURN",
    payload: { type: "YOUR_TURN", activePlayers: ["player-1", "player-2"] },
    timestamp: Date.now() - 2000,
  },
  {
    id: "feedback-2",
    type: "ACTION_REJECTED",
    payload: {
      type: "ACTION_REJECTED",
      reason: "Road placement is blocked",
      targetPlayer: "player-2",
    },
    timestamp: Date.now() - 1000,
  },
];

function FeedbackFixture() {
  const [feedback, setFeedback] = useState(INITIAL_FEEDBACK);

  return (
    <div className="min-h-screen p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="space-y-4 border-[3px] border-border bg-[#fffdf7] p-6 hard-shadow wobbly-border-lg">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              Host Feedback
            </p>
            <h2 className="font-display text-3xl">Notification stack</h2>
          </div>

          <HostFeedbackStack
            feedback={feedback}
            onDismiss={(feedbackId) =>
              setFeedback((current) =>
                current.filter((entry) => entry.id !== feedbackId),
              )
            }
          />
        </section>
      </div>
    </div>
  );
}

export default {
  default: <FeedbackFixture />,
};
