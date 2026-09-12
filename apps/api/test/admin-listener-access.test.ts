import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ListenerAccessRepository } from "../src/db/listenerAccessRepository";
import worker from "../src/index";
import {
  adminCookie,
  DEFAULT_TEST_ORG_ID,
  seedOrg,
  seedPlatformAdmin,
  seedProgram,
  seedViewer,
  testEnv
} from "./test-env";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = ConstructorParameters<typeof IncomingRequest>[1];

async function request(path: string, init: IncomingRequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`https://bhasha.test${path}`, init),
    testEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_access");
  await testEnv.DB.exec("DELETE FROM admin_sessions");
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM programs");
  await testEnv.DB.exec("DELETE FROM users");
  await testEnv.DB.exec("DELETE FROM orgs");
  await seedOrg(testEnv, { id: DEFAULT_TEST_ORG_ID, name: "Default test org" });
}

describe("admin listener access routes", () => {
  beforeEach(resetDb);

  it("returns pending, approved, and revoked counts for a program", async () => {
    await seedPlatformAdmin(testEnv);
    const program = await seedProgram(testEnv);
    const repo = new ListenerAccessRepository(testEnv.DB);
    const pending = await repo.createClaim(program.id, "client_pending");
    const approved = await repo.createClaim(program.id, "client_approved");
    const revoked = await repo.createClaim(program.id, "client_revoked");
    await repo.approveClaim(program.id, { claimId: approved.claimId }, "scan");
    await repo.approveClaim(program.id, { claimId: revoked.claimId }, "code");
    await repo.revokeForClient(program.id, "client_revoked");
    const cookie = await adminCookie();

    expect(pending.shortCode).toHaveLength(6);

    const response = await request(
      `/api/admin/programs/${program.id}/listener-access/summary`,
      { method: "GET", headers: { Cookie: cookie } }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pending: 1,
      approved: 1,
      revoked: 1
    });
  });

  it("allows same-org viewers to read but rejects viewer revoke writes", async () => {
    const org = await seedOrg(testEnv);
    const viewer = await seedViewer(testEnv, { orgId: org.id });
    const program = await seedProgram(testEnv, { orgId: org.id });
    const viewerCookie = await adminCookie(viewer.email);

    const read = await request(
      `/api/admin/programs/${program.id}/listener-access/summary`,
      { method: "GET", headers: { Cookie: viewerCookie } }
    );
    expect(read.status).toBe(200);

    const write = await request(
      `/api/admin/programs/${program.id}/listener-access/revoke`,
      {
        method: "POST",
        headers: { Cookie: viewerCookie },
        body: JSON.stringify({ clientId: "client_1" })
      }
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "forbidden" });
  });

  it("revokes all client rows and validates the clientId payload", async () => {
    await seedPlatformAdmin(testEnv);
    const program = await seedProgram(testEnv);
    const repo = new ListenerAccessRepository(testEnv.DB);
    const claim = await repo.createClaim(program.id, "client_1");
    await repo.approveClaim(program.id, { claimId: claim.claimId }, "scan");
    await repo.createClaim(program.id, "client_1");
    const cookie = await adminCookie();

    const badRequest = await request(
      `/api/admin/programs/${program.id}/listener-access/revoke`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({})
      }
    );
    expect(badRequest.status).toBe(400);
    expect(await badRequest.json()).toEqual({ error: "validation_error" });

    const response = await request(
      `/api/admin/programs/${program.id}/listener-access/revoke`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ clientId: "client_1" })
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 2 });
    expect(await repo.countByStatus(program.id)).toEqual({
      pending: 0,
      approved: 0,
      revoked: 2
    });
  });
});
