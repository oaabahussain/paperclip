import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { getServerAdapter, registerServerAdapter } from "../adapters/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-detach-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-detach");
  vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-detach-db-");
  db = createDb(database.connectionString);
  const original = getServerAdapter("claude_local");
  registerServerAdapter({ ...original, testEnvironment: async () => ({ adapterType: "claude_local", status: "pass", checks: [{ code: "claude_hello_probe_passed", level: "info", message: "hello" }], testedAt: new Date().toISOString() }) });
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

const binding = { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const;

async function fixture() {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Detach test", issuePrefix: `D${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Bound agent",
    role: "general",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-5" },
    runtimeConfig: { aiConnection: binding },
  });
  await aiConnectionService(db).save(companyId, userId, {
    provider: "anthropic", method: "subscription", name: "Detach fixture connection", ownership: "personal", agentIds: [agentId], allAgents: false,
    loginSessionId: "fixture",
  }, JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } }));
  const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", responsibleUserId: userId }).returning();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt", onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return { app, companyId, agentId, userId };
}

async function savedAgent(agentId: string) {
  const [saved] = await db.select().from(agents).where(eq(agents.id, agentId));
  return saved;
}

describe("agent update detaches AI connections that cannot follow a harness switch", () => {
  it("drops an incompatible binding when switching to a harness with no AI connection path (adapter-only patch)", async () => {
    const f = await fixture();
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterType: "pi_local", adapterConfig: { model: "zai/glm-5.3" } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await savedAgent(f.agentId);
    expect(saved.adapterType).toBe("pi_local");
    expect(saved.runtimeConfig.aiConnection).toBeUndefined();
  });

  it("drops an incompatible binding when the patch re-sends it explicitly (UI save shape)", async () => {
    const f = await fixture();
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({
      adapterType: "pi_local",
      adapterConfig: { model: "zai/glm-5.3" },
      runtimeConfig: { aiConnection: binding },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await savedAgent(f.agentId);
    expect(saved.runtimeConfig.aiConnection).toBeUndefined();
  });

  it("treats an explicit aiConnection null as a detach on the same harness", async () => {
    const f = await fixture();
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({
      runtimeConfig: { aiConnection: null },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await savedAgent(f.agentId);
    expect(saved.adapterType).toBe("claude_local");
    expect(saved.runtimeConfig.aiConnection).toBeUndefined();
  });

  it("preserves the stored binding when the patch omits runtimeConfig entirely", async () => {
    const f = await fixture();
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { model: "claude-sonnet-5-2026" } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await savedAgent(f.agentId);
    expect(saved.runtimeConfig.aiConnection).toEqual(binding);
  });

  it("still rejects an incompatible binding on the same harness instead of dropping it", async () => {
    const f = await fixture();
    await db.update(agents).set({
      adapterType: "opencode_local",
      adapterConfig: { model: "anthropic/claude-sonnet-5" },
      runtimeConfig: { aiConnection: { provider: "openrouter", method: "api_key", mode: "responsible_user" } },
    }).where(eq(agents.id, f.agentId));
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { model: "anthropic/claude-sonnet-5" } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const saved = await savedAgent(f.agentId);
    expect(saved.runtimeConfig.aiConnection).toEqual({ provider: "openrouter", method: "api_key", mode: "responsible_user" });
  });
});
