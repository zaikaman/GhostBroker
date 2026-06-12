import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AuthSessionService } from "../../services/auth.service.js";
import type { AgentAdmissionService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildBackendTestEnv,
  buildInstitution,
} from "../data/us1-seed-builders.js";

function buildServices(authService: AuthSessionService): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService: {
      admitAgent: async () => ({
        agentDid: "did:t3:0x0000000000000000000000000000000000000301",
        status: "admitted",
        authorityRef: "authority:test",
      }),
    } satisfies AgentAdmissionService,
    authService,
  };
}

describe("DID authentication contract", () => {
  it("issues a one-time challenge for a known Terminal 3 DID", async () => {
    const authService: AuthSessionService = {
      createChallenge: async () => ({
        challengeId: "auth_challenge_contract",
        challenge: "GhostBroker Terminal 3 DID authorization\nNonce: contract",
        expiresAt: "2026-06-12T12:00:00.000Z",
      }),
      verifyChallenge: async () => {
        throw new Error("not used");
      },
    };
    const app = createApp(buildBackendTestEnv(), buildServices(authService));

    const response = await request(app)
      .post("/api/auth/challenge")
      .send({ did: "did:t3:0x0000000000000000000000000000000000000301" })
      .expect(201);

    expect(response.body).toEqual({
      challengeId: "auth_challenge_contract",
      challenge: "GhostBroker Terminal 3 DID authorization\nNonce: contract",
      expiresAt: "2026-06-12T12:00:00.000Z",
    });
  });

  it("establishes a bearer session after a verified DID signature", async () => {
    const authService: AuthSessionService = {
      createChallenge: async () => {
        throw new Error("not used");
      },
      verifyChallenge: async () => ({
        token: "session.jwt.contract",
        expiresAt: "2026-06-12T20:00:00.000Z",
        institution: {
          id: "00000000-0000-4000-8000-000000000101",
          displayName: "Northstar Capital",
          t3TenantDid: "did:t3:0x0000000000000000000000000000000000000301",
        },
      }),
    };
    const app = createApp(buildBackendTestEnv(), buildServices(authService));

    const response = await request(app)
      .post("/api/auth/verify")
      .send({
        challengeId: "auth_challenge_contract",
        did: "did:t3:0x0000000000000000000000000000000000000301",
        signature: "0xsignature",
      })
      .expect(200);

    expect(response.body).toEqual({
      token: "session.jwt.contract",
      expiresAt: "2026-06-12T20:00:00.000Z",
      institution: {
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "Northstar Capital",
        t3TenantDid: "did:t3:0x0000000000000000000000000000000000000301",
      },
    });
  });
});
