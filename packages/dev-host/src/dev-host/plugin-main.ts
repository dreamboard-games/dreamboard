import devConfig from "virtual:dreamboard-dev-config";
import { stringifyForRelay } from "./dev-diagnostics.js";
import { installPlayableZoneItemWarnings } from "./dev-author-dom-warnings.js";

installPluginConsoleRelay();
const disposePlayableZoneWarnings = installPlayableZoneItemWarnings();

void import("virtual:dreamboard-project-entry").catch((error: unknown) => {
  console.error("[dreamboard-dev] Failed to load project entry.", error);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposePlayableZoneWarnings();
  });
}

function installPluginConsoleRelay(): void {
  const relay = (level: "log" | "warn" | "error", args: unknown[]): void => {
    try {
      window.parent.postMessage(
        {
          type: "dreamboard-dev-console",
          level,
          message: args.map((value) => stringifyForRelay(value)).join(" "),
        },
        "*",
      );
    } catch {
      // Ignore logging failures in the dev iframe.
    }
  };

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    original.log(...args);
    if (devConfig.debug) {
      relay("log", args);
    }
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    relay("warn", args);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    relay("error", args);
  };

  window.addEventListener("error", (event) => {
    relay("error", [`window.error ${event.message}`]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    relay("error", ["unhandledrejection", event.reason]);
  });
}
