import { describe, expect, it } from "vitest";
import {
  classifyRequestSurface,
  normalizeHost,
  pathAllowedForSurface,
} from "../src/host_routing";

const config = {
  apiHostnames: ["api.licence.getanimate.app", "licence.getanimate.app"],
  adminHostnames: ["admin.licence.getanimate.app"],
};

describe("host routing isolation", () => {
  it("normalizes hostnames with ports", () => {
    expect(normalizeHost("API.LICENCE.GETANIMATE.APP:443")).toBe(
      "api.licence.getanimate.app"
    );
    expect(normalizeHost("[::1]:8787")).toBe("::1");
  });

  it("allows local development to access both surfaces", () => {
    expect(classifyRequestSurface("http://127.0.0.1:8787/admin/", config)).toBe(
      "local"
    );
    expect(pathAllowedForSurface("/admin/", "local")).toBe(true);
    expect(pathAllowedForSurface("/v1/activate", "local")).toBe(true);
  });

  it("keeps admin routes off the api host", () => {
    const surface = classifyRequestSurface(
      "https://api.licence.getanimate.app/admin/",
      config
    );
    expect(surface).toBe("api");
    expect(pathAllowedForSurface("/admin/", surface)).toBe(false);
    expect(pathAllowedForSurface("/v1/activate", surface)).toBe(true);
  });

  it("keeps client api routes off the admin host", () => {
    const surface = classifyRequestSurface(
      "https://admin.licence.getanimate.app/v1/activate",
      config
    );
    expect(surface).toBe("admin");
    expect(pathAllowedForSurface("/v1/activate", surface)).toBe(false);
    expect(pathAllowedForSurface("/admin/", surface)).toBe(true);
  });

  it("rejects unknown production hostnames when hostnames are configured", () => {
    expect(classifyRequestSurface("https://evil.example.com/", config)).toBe(
      "unknown"
    );
  });
});
