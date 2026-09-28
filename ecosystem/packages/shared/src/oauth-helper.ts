import { createHmac } from "node:crypto";

export interface SessionPayload {
  sub: string;
  login: string;
  role: string;
  exp: number;
}

/**
 * Builds GitHub OAuth authorization redirect URL
 */
export function generateGitHubOAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string = "delentia_auth"
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Signs a session payload using HMAC-SHA256
 */
export function createSessionToken(payload: SessionPayload, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/**
 * Verifies and decodes an HMAC-SHA256 signed session token
 */
export function verifySessionToken(
  token: string,
  secret: string
): { valid: boolean; payload?: SessionPayload; error?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Malformed token format" };
    }
    const [header, body, signature] = parts;
    const expectedSig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
    if (signature !== expectedSig) {
      return { valid: false, error: "Invalid signature" };
    }
    const payload: SessionPayload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return { valid: false, error: "Token expired" };
    }
    return { valid: true, payload };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Token verification failure" };
  }
}
