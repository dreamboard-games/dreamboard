export function canonicalizeBrowserOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return null;
  }
  if (!url.hostname) {
    return null;
  }
  if (url.hostname !== "localhost" && url.hostname.includes("localhost")) {
    return null;
  }

  const canonical = url.origin;
  return canonical === origin ? canonical : null;
}

export function isLoopbackBrowserOrigin(origin: string): boolean {
  const canonical = canonicalizeBrowserOrigin(origin);
  if (!canonical) {
    return false;
  }
  const url = new URL(canonical);
  if (!url.port) {
    return false;
  }
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}
