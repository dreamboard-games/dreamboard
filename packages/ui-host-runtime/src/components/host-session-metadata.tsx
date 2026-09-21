import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

type HostMetaField = "projectId" | "sessionId" | "shortCode";

export interface HostSessionMetadataProps {
  projectId: string;
  sessionId: string;
  shortCode: string;
  className?: string;
}

export function HostSessionMetadata({
  projectId,
  sessionId,
  shortCode,
  className,
}: HostSessionMetadataProps) {
  const [copiedField, setCopiedField] = useState<HostMetaField | null>(null);

  useEffect(() => {
    if (!copiedField) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedField(null);
    }, 1600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copiedField]);

  const handleCopyMeta = async (field: HostMetaField, value: string) => {
    if (!value || !navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
    } catch {
      // Ignore clipboard failures; the button remains readable.
    }
  };

  return (
    <dl className={className ?? "space-y-3 text-sm"}>
      <HostSessionMetaRow
        label="Project ID"
        value={projectId}
        copied={copiedField === "projectId"}
        onCopy={() => void handleCopyMeta("projectId", projectId)}
        truncate
      />
      <HostSessionMetaRow
        label="Session ID"
        value={sessionId}
        copied={copiedField === "sessionId"}
        onCopy={() => void handleCopyMeta("sessionId", sessionId)}
        truncate
      />
      <HostSessionMetaRow
        label="Short code"
        value={shortCode}
        copied={copiedField === "shortCode"}
        onCopy={() => void handleCopyMeta("shortCode", shortCode)}
      />
    </dl>
  );
}

interface HostSessionMetaRowProps {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  truncate?: boolean;
}

function HostSessionMetaRow({
  label,
  value,
  copied,
  onCopy,
  truncate = false,
}: HostSessionMetaRowProps) {
  const displayValue = truncate ? truncateMiddle(value) : value;

  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3">
      <dt className="pt-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0">
        <button
          type="button"
          onClick={onCopy}
          className={`flex w-full items-center justify-end gap-2 border-[2px] px-2.5 py-2 text-right transition-all ${
            copied
              ? "border-[#2d5da1] bg-[#2d5da1] text-white shadow-[2px_2px_0px_0px_#1d3f72]"
              : "border-border bg-white/85 text-foreground shadow-[2px_2px_0px_0px_#2d2d2d] hover:-translate-y-[1px] hover:bg-[#fff9c4]"
          } wobbly-border-md`}
          title={`Copy ${label}`}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-bold sm:text-[13px]">
            {displayValue}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em]">
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </span>
        </button>
      </dd>
    </div>
  );
}

function truncateMiddle(value: string, leading = 12, trailing = 8): string {
  if (value.length <= leading + trailing + 3) {
    return value;
  }

  return `${value.slice(0, leading)}...${value.slice(-trailing)}`;
}
