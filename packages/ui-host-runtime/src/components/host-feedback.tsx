/**
 * Host-owned inline feedback stack.
 *
 * Visual styling is driven entirely by the active `@dreamboard-games/sdk/ui`
 * `Theme` so the stack re-skins with the rest of the host shell. The
 * earlier implementation relied on raw Tailwind colour classes
 * (`bg-emerald-500/10`, `text-amber-700`, …) which were untouchable
 * by the theme tokens.
 */

import { AlertTriangle, Bell, Clock3, X } from "lucide-react";
import {
  intentForVariant,
  surfaceStyle,
  useTheme,
  type ButtonVariant,
  type Theme,
} from "@dreamboard-games/sdk/ui";
import type { HostFeedback } from "../unified-session-store.js";

export interface HostFeedbackStackProps {
  feedback: HostFeedback[];
  onDismiss?: (feedbackId: string) => void;
  className?: string;
}

interface StackPresentation {
  title: string;
  description: string;
  variant: Extract<ButtonVariant, "danger" | "warning" | "success" | "info">;
  icon: typeof AlertTriangle;
}

function describeFeedback(item: HostFeedback): StackPresentation {
  switch (item.type) {
    case "YOUR_TURN": {
      const description =
        item.payload.activePlayers.length > 1
          ? "You can act with one of your controlled players."
          : "You can act now.";
      return {
        title: "Your turn",
        description,
        variant: "success",
        icon: Bell,
      };
    }
    case "PROMPT_OPENED": {
      const payload = item.payload;
      const description = payload.targetPlayer
        ? `${payload.title ?? "A prompt is waiting."} (${payload.targetPlayer})`
        : (payload.title ?? "A prompt is waiting.");
      return {
        title: "Response needed",
        description,
        variant: "warning",
        icon: Clock3,
      };
    }
    case "ACTION_REJECTED": {
      const payload = item.payload;
      const description = payload.targetPlayer
        ? `${payload.reason} (${payload.targetPlayer})`
        : payload.reason;
      return {
        title: "Action rejected",
        description,
        variant: "danger",
        icon: AlertTriangle,
      };
    }
  }

  const exhaustive: never = item;
  throw new Error(
    `Unsupported host feedback item type: ${String((exhaustive as { type?: unknown }).type)}`,
  );
}

interface FeedbackEntryProps {
  item: HostFeedback;
  presentation: StackPresentation;
  theme: Theme;
  onDismiss?: (feedbackId: string) => void;
}

function FeedbackEntry({
  item,
  presentation,
  theme,
  onDismiss,
}: FeedbackEntryProps) {
  const intent = intentForVariant(theme, presentation.variant);
  const Icon = presentation.icon;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...surfaceStyle(theme, { tone: "card", radius: "lg" }),
        background: intent.soft,
        color: intent.onSoft,
        border: `1px solid ${intent.border}`,
        boxShadow: theme.elevation.rest,
        display: "flex",
        alignItems: "flex-start",
        gap: theme.space[3],
        padding: theme.space[3],
        fontFamily: theme.typography.fontFamily.body,
      }}
    >
      <Icon
        size={20}
        strokeWidth={2.5}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          marginTop: 2,
          color: intent.solid,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: theme.typography.fontFamily.display,
            fontSize: theme.typography.fontSize.md,
            fontWeight: theme.typography.fontWeight.bold,
            lineHeight: theme.typography.lineHeight.tight,
            color: intent.onSoft,
          }}
        >
          {presentation.title}
        </div>
        <div
          style={{
            marginTop: theme.space[1],
            fontSize: theme.typography.fontSize.sm,
            fontWeight: theme.typography.fontWeight.medium,
            lineHeight: theme.typography.lineHeight.normal,
            color: intent.onSoft,
            opacity: 0.92,
            wordBreak: "break-word",
          }}
        >
          {presentation.description}
        </div>
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss feedback"
          onClick={() => onDismiss(item.id)}
          style={{
            flexShrink: 0,
            width: 28,
            height: 28,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            borderRadius: theme.radius.pill,
            color: intent.onSoft,
            cursor: "pointer",
            opacity: 0.7,
            transition: `opacity ${theme.motion.duration.fast} ${theme.motion.easing.out}`,
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.opacity = "0.7";
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function HostFeedbackStack({
  feedback,
  onDismiss,
  className,
}: HostFeedbackStackProps) {
  const theme = useTheme();
  if (feedback.length === 0) {
    return null;
  }

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: theme.space[2],
      }}
    >
      {[...feedback].reverse().map((item) => (
        <FeedbackEntry
          key={item.id}
          item={item}
          presentation={describeFeedback(item)}
          theme={theme}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
