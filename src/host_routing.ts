export type RequestSurface = "api" | "admin" | "local" | "unknown";

export interface HostRoutingConfig {
  apiHostnames: string[];
  adminHostnames: string[];
}

export function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[::1]")) return "::1";
  const colon = value.lastIndexOf(":");
  if (colon > -1 && value.indexOf(":") === colon) {
    return value.substring(0, colon);
  }
  return value;
}

export function isLocalHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

export function classifyRequestSurface(
  url: string,
  config: HostRoutingConfig
): RequestSurface {
  const host = normalizeHost(new URL(url).host);

  if (isLocalHost(host)) return "local";
  if (config.adminHostnames.includes(host)) return "admin";
  if (config.apiHostnames.includes(host)) return "api";

  if (config.adminHostnames.length === 0 && config.apiHostnames.length === 0) {
    return "local";
  }

  return "unknown";
}

export function pathAllowedForSurface(pathname: string, surface: RequestSurface): boolean {
  if (surface === "local") return true;
  if (surface === "api") return !pathname.startsWith("/admin");
  if (surface === "admin") return !pathname.startsWith("/v1");
  return false;
}
