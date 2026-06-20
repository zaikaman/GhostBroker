import type {
  NegotiationMove,
  RedactedNegotiationSessionView,
} from "./types.js";
import { GhostBrokerApiError } from "./errors.js";
import { logger } from "../../logging/logger.js";

export interface NegotiationTicketRequest {
  agentId: string;
  agentDid: string;
  policyHash: string;
  assetCode: string;
  side: "buy" | "sell";
  compatibilityToken: string;
}

export interface NegotiationTicketAccepted {
  ticketHandle: string;
  sessionId: string | null;
}

export interface SubmitNegotiationMoveRequest {
  agentId: string;
  agentDid: string;
  authorityRef: string;
  move: NegotiationMove;
  claimCredential?: unknown;
}

export interface NegotiationMoveAccepted {
  status:
    | "pairing"
    | "active"
    | "awaiting_approval"
    | "converged"
    | "settling"
    | "settled"
    | "walked_away"
    | "expired";
}

export interface NegotiationEscalationDecision {
  status:
    | "pairing"
    | "active"
    | "awaiting_approval"
    | "converged"
    | "settling"
    | "settled"
    | "walked_away"
    | "expired";
}

export class NegotiationClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  public async submitTicket(
    request: NegotiationTicketRequest,
    token: string,
  ): Promise<NegotiationTicketAccepted> {
    const response = await fetch(`${this.baseUrl}/api/negotiations/tickets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<NegotiationTicketAccepted>;
  }

  public async listSessions(
    token: string,
    agentDid?: string,
  ): Promise<{ sessions: RedactedNegotiationSessionView[] }> {
    const url = new URL(`${this.baseUrl}/api/negotiations`);
    if (agentDid) {
      url.searchParams.set("agentDid", agentDid);
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<{ sessions: RedactedNegotiationSessionView[] }>;
  }

  public async getSession(
    sessionId: string,
    token: string,
  ): Promise<RedactedNegotiationSessionView> {
    const response = await fetch(`${this.baseUrl}/api/negotiations/${sessionId}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<RedactedNegotiationSessionView>;
  }

  public async submitMove(
    sessionId: string,
    request: SubmitNegotiationMoveRequest,
    token: string,
  ): Promise<NegotiationMoveAccepted> {
    const response = await fetch(`${this.baseUrl}/api/negotiations/${sessionId}/moves`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<NegotiationMoveAccepted>;
  }

  public async walkAway(
    sessionId: string,
    request: {
      agentId: string;
      agentDid: string;
      authorityRef: string;
      reasoning?: string;
    },
    token: string,
  ): Promise<NegotiationMoveAccepted> {
    const response = await fetch(`${this.baseUrl}/api/negotiations/${sessionId}/walkaway`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<NegotiationMoveAccepted>;
  }

  public async approveEscalation(
    sessionId: string,
    token: string,
  ): Promise<NegotiationEscalationDecision> {
    const response = await fetch(
      `${this.baseUrl}/api/negotiations/${sessionId}/escalation/approve`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!response.ok) {
      throw await this.parseError(response);
    }
    return response.json() as Promise<NegotiationEscalationDecision>;
  }

  public async declineEscalation(
    sessionId: string,
    request: { reason?: string },
    token: string,
  ): Promise<NegotiationEscalationDecision> {
    const response = await fetch(
      `${this.baseUrl}/api/negotiations/${sessionId}/escalation/decline`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      throw await this.parseError(response);
    }
    return response.json() as Promise<NegotiationEscalationDecision>;
  }

  private async parseError(response: Response): Promise<GhostBrokerApiError> {
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      return new GhostBrokerApiError(
        response.status,
        (body.code as GhostBrokerApiError["code"]) || "request_failed",
        body.message || `HTTP ${response.status}`,
      );
    } catch (err) {
      logger.debug(
        {
          err,
          event: "sdk.parse_error_fallback",
          url: response.url,
          status: response.status,
        },
        "SDK failed to parse error response body; falling back to request_failed.",
      );
      return new GhostBrokerApiError(response.status, "request_failed", `HTTP ${response.status}`);
    }
  }
}
