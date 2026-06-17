type ZoneItemElement = Pick<Element, "getAttribute" | "querySelector">;

type ZoneItemRoot = Pick<ParentNode, "querySelectorAll">;

export interface PlayableZoneItemWarning {
  key: string;
  message: string;
}

const PLAYABLE_ZONE_ITEM_SELECTOR =
  '[data-dreamboard-zone-item][data-playable="true"]';
const INTERACTION_CARD_INPUT_SELECTOR =
  "[data-dreamboard-interaction-card-input]";

export function collectPlayableZoneItemWarnings(
  root: ZoneItemRoot,
): PlayableZoneItemWarning[] {
  const warnings: PlayableZoneItemWarning[] = [];
  for (const item of root.querySelectorAll(PLAYABLE_ZONE_ITEM_SELECTOR)) {
    const element = item as ZoneItemElement;
    if (element.querySelector(INTERACTION_CARD_INPUT_SELECTOR)) {
      continue;
    }

    const zone = element.getAttribute("data-zone") ?? "unknown";
    const cardId = element.getAttribute("data-card-id") ?? "unknown";
    const cardType = element.getAttribute("data-card-type") ?? null;
    const key = `${zone}:${cardId}`;
    const cardLabel =
      cardType && cardType !== cardId
        ? `'${cardId}' (${cardType})`
        : `'${cardId}'`;
    warnings.push({
      key,
      message: [
        `[dreamboard] Playable card ${cardLabel} in zone '${zone}' rendered without an interaction card input.`,
        "This usually means the UI rendered a raw Card/custom tile instead of <handSurface.Card>.",
        "Render the surface card consistently and let Dreamboard disable unavailable interactions.",
      ].join(" "),
    });
  }
  return warnings;
}

export function installPlayableZoneItemWarnings(
  options: {
    root?: Document;
    warn?: (...args: unknown[]) => void;
    MutationObserverImpl?: typeof MutationObserver;
    schedule?: (callback: () => void) => void;
  } = {},
): () => void {
  const root = options.root ?? document;
  const warn = options.warn ?? console.warn.bind(console);
  const MutationObserverImpl =
    options.MutationObserverImpl ?? window.MutationObserver;
  const schedule =
    options.schedule ??
    ((callback) => {
      window.requestAnimationFrame(callback);
    });
  const emitted = new Set<string>();
  let scheduled = false;

  const scan = () => {
    scheduled = false;
    for (const warning of collectPlayableZoneItemWarnings(root)) {
      if (emitted.has(warning.key)) {
        continue;
      }
      emitted.add(warning.key);
      warn(warning.message);
    }
  };

  const requestScan = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    schedule(scan);
  };

  const observer = new MutationObserverImpl(requestScan);
  observer.observe(root.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-dreamboard-zone-item",
      "data-playable",
      "data-dreamboard-interaction-card-input",
    ],
  });
  requestScan();

  return () => {
    observer.disconnect();
  };
}
