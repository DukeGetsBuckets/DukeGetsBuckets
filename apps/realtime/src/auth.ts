import { jwtVerify } from "jose";
import { env } from "./env";

export interface SocketUser {
  id: string;
  username: string;
}

const secret = new TextEncoder().encode(env.REALTIME_JWT_SECRET);

/**
 * Socket tokens are short-lived HS256 JWTs minted by the web app for the logged-in user.
 * The realtime service never trusts a client-supplied user id directly.
 */
export async function verifySocketToken(token: string): Promise<SocketUser> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"], audience: "tempo-realtime" });
  if (typeof payload.sub !== "string" || typeof payload["username"] !== "string") {
    throw new Error("Malformed token");
  }
  return { id: payload.sub, username: payload["username"] };
}
