import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/setup";
import { decryptLicencePayload } from "../src/licence/codec";
import { createV1Router } from "../src/routes/v1";

describe("trial API routes", () => {
  it("ignores client feature input and signs the server-configured plan features", async () => {
    const env = await createTestEnv();
    const router = createV1Router(env.db, env.config, env.registry);

    const response = await router.request("/trials/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product_id: "animate",
        fingerprint: "trial-route-machine-001",
        feature: "import_dance",
        app_version: "1.2.0",
        platform: "windows",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.trial.features).toEqual(["import_vrm", "import_dance", "import_stage"]);

    const [auth] = await decryptLicencePayload(
      body.licence,
      env.keys.publicKeySpkiHex
    );
    expect(auth.features).toEqual(["import_vrm", "import_dance", "import_stage"]);
  });

  it("returns only server_time from trial time-check", async () => {
    const env = await createTestEnv();
    const router = createV1Router(env.db, env.config, env.registry);
    const before = Math.floor(Date.now() / 1000);

    const response = await router.request("/trials/time-check", {
      method: "POST",
      headers: {
        "X-Animate-Product": "animate",
        "X-Animate-Time-Check-Token": env.config.trialTimeCheckToken,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["server_time"]);
    expect(typeof body.server_time).toBe("number");
    expect(body.server_time as number).toBeGreaterThanOrEqual(before);
    expect(body).not.toHaveProperty("valid_until");
    expect(body).not.toHaveProperty("next_check_after");
    expect(body).not.toHaveProperty("offline_grace_until");
    expect(body).not.toHaveProperty("licence");
  });

  it("rejects invalid trial time-check headers", async () => {
    const env = await createTestEnv();
    const router = createV1Router(env.db, env.config, env.registry);

    const response = await router.request("/trials/time-check", {
      method: "POST",
      headers: {
        "X-Animate-Product": "animate",
        "X-Animate-Time-Check-Token": "wrong-token",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });
});
