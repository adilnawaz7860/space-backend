import { verifyAccessToken } from "../services/jwt.js";
export async function authMiddleware(c, next) {
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
    }
    catch {
        return c.json({ error: "Invalid or expired token" }, 401);
    }
}
