import { Context, Next } from "hono";
import { verifyAccessToken } from "../services/jwt.js";

// Shared Hono env type — used across all routes so c.get() is typed
export type AuthEnv = {
  Variables: {
    userId: string;
    username: string;
  };
};

export async function authMiddleware(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(token);
    c.set("userId", payload.userId);
    c.set("username", payload.username);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}