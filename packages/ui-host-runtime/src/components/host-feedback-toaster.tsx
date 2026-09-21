import { useEffect } from "react";
import { Toaster, toast } from "sonner";
import { AlertTriangle, Bell, Clock3, X } from "lucide-react";
import {
  intentForVariant,
  surfaceStyle,
  useTheme,
  type ButtonVariant,
  type Theme,
} from "@dreamboard-games/sdk/ui";
import type { HostFeedback } from "../unified-session-store.js";

export interface HostFeedbackToasterProps {
  feedback?: HostFeedback[];
  onDismiss?: (feedbackId: string) => void;
}

interface FeedbackPresentation {
  title: string;
  description: string;
  duration: number;
  variant: Extract<ButtonVariant, "danger" | "warning" | "success" | "info">;
  icon: typeof AlertTriangle;
}

function describeFeedback(item: HostFeedback): FeedbackPresentation {
  switch (item.type) {
    case "YOUR_TURN": {
      const activePlayerCount = item.payload.activePlayers.length;
      return {
        title: "Your turn",
        description:
          activePlayerCount > 1
            ? "You can act with one of your controlled players."
            : "You can act now.",
        duration: 3500,
        variant: "success",
        icon: Bell,
      };
    }
    case "PROMPT_OPENED": {
      const { targetPlayer, title } = item.payload;
      return {
        title: "Response needed",
        description: targetPlayer
          ? `${title ?? "A prompt is waiting."} (${targetPlayer})`
          : (title ?? "A prompt is waiting."),
        duration: 5000,
        variant: "warning",
        icon: Clock3,
      };
    }
    case "ACTION_REJECTED": {
      const reason = item.payload.targetPlayer
        ? `${item.payload.reason} (${item.payload.targetPlayer})`
        : item.payload.reason;
      return {
        title: "Action rejected",
        description: reason,
        duration: 5000,
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

interface HostFeedbackToastBodyProps {
  presentation: FeedbackPresentation;
  theme: Theme;
  onDismiss: () => void;
}

/**
 * Inner toast body. Rendered through sonner's `toast.custom` so the
 * surface is fully owned by the active {@link Theme} — no implicit
 * `richColors` styling, no hardcoded `bg-*` Tailwind classes.
 */
function HostFeedbackToastBody({
  presentation,
  theme,
  onDismiss,
}: HostFeedbackToastBodyProps) {
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
        boxShadow: theme.elevation.lifted,
        display: "flex",
        alignItems: "flex-start",
        gap: theme.space[3],
        padding: theme.space[3],
        // Match sonner's default 356px so the toast lines up with
        // sibling toasts that may live inside the same stack.
        minWidth: 320,
        maxWidth: 420,
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
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
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
    </div>
  );
}

/**
 * Mounts a {@link Toaster} and dispatches host-feedback events as
 * themed sonner toasts.
 *
 * Implementation notes:
 *
 * - We use `toast.custom(jsx, { id })` with a stable `id` so sonner
 *   deduplicates the same feedback id by itself. The previous
 *   implementation tracked processed ids in a `useRef`, which reset
 *   across remounts (StrictMode in dev, parent re-renders that swap
 *   the toaster's key) and caused the "shows / disappears / shows
 *   again" flicker. With sonner-owned dedup, remounts no longer
 *   replay the queue.
 * - We render a fully themed body so the toast picks up the active
 *   `useTheme()` palette, font stack, and elevation tokens. Sonner's
 *   default `richColors` theme is intentionally not used because it
 *   produces a parallel non-themeable colour scheme.
 * - Host feedback is the canonical home for `YOUR_TURN`,
 *   `PROMPT_OPENED` and `ACTION_REJECTED`. The plugin-side
 *   `<ToastProvider>` no longer mirrors these; consumers must pass
 *   the explicit `feedback` array sourced from the unified session
 *   store.
 */
export function HostFeedbackToaster({
  feedback = [],
  onDismiss,
}: HostFeedbackToasterProps) {
  const theme = useTheme();

  useEffect(() => {
    for (const item of feedback) {
      const presentation = describeFeedback(item);
      const dismiss = () => onDismiss?.(item.id);

      // `toast.custom(jsx, { id })` is idempotent — calling it again
      // with the same id updates the existing toast in place rather
      // than mounting a duplicate, which is exactly what we want for
      // host-feedback ids that may flow through several store
      // snapshots before being dismissed.
      toast.custom(
        (toastId) => (
          <HostFeedbackToastBody
            presentation={presentation}
            theme={theme}
            onDismiss={() => {
              toast.dismiss(toastId);
              dismiss();
            }}
          />
        ),
        {
          id: item.id,
          duration: presentation.duration,
          unstyled: true,
          onAutoClose: () => dismiss(),
          onDismiss: () => dismiss(),
        },
      );
    }
  }, [feedback, onDismiss, theme]);

  return (
    <Toaster
      position="top-center"
      // Disable `richColors` because we render fully themed bodies
      // via `toast.custom` and don't want sonner's default success /
      // error palette competing with the active theme.
      richColors={false}
      // Forward the OS-level theme hint so sonner's container
      // (backdrop, default text colour for any non-custom toasts)
      // matches the resolved Dreamboard theme mode.
      theme={theme.meta.mode === "dark" ? "dark" : "light"}
      toastOptions={{
        // We use unstyled toasts so the inner `HostFeedbackToastBody`
        // has full control. `unstyled: true` removes sonner's
        // built-in surface, padding and shadow.
        unstyled: true,
        // Make the offset match sonner's default but anchor to the
        // viewport with safe-area insets so the toast clears phone
        // notches.
        style: {
          marginTop: "env(safe-area-inset-top, 0px)",
        },
      }}
    />
  );
}
