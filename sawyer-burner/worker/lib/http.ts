import type { Context } from "hono";
import type { Role } from "../../shared/types";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: number;
  mustChangePassword: boolean;
  sessionId: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser | null };
};

export type AppContext = Context<AppEnv>;

/** Thrown anywhere in a handler; rendered as `{ error }` JSON by the app's onError. */
export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export function requireUser(c: AppContext): SessionUser {
  const user = c.get("user");
  if (!user) throw new ApiError(401, "Log in first.");
  // After an admin reset, the temporary password only unlocks /api/auth/change-password.
  if (user.mustChangePassword) throw new ApiError(403, "Choose a new password first.");
  return user;
}

/** Signed in AND not suspended — required for posting, burning, reacting. */
export function requireActiveUser(c: AppContext): SessionUser {
  const user = requireUser(c);
  if (user.status === "suspended") throw new ApiError(403, "Your account is suspended. You can't post, burn or react right now.");
  return user;
}

/** Admin role is re-read from D1 on every request (see session middleware), never trusted from the client. */
export function requireAdmin(c: AppContext): SessionUser {
  const user = requireUser(c);
  if (user.role !== "admin") throw new ApiError(403, "Admins only.");
  return user;
}

export async function readJson<T extends Record<string, unknown>>(c: AppContext): Promise<Partial<T>> {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Expected JSON.");
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Partial<T>;
  } catch {
    throw new ApiError(400, "Malformed JSON.");
  }
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const imageUrl = (postId: string) => `/img/${postId}`;
