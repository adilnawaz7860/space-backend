import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../services/jwt.js";
import { authMiddleware } from "../middleware/auth.js";
const auth = new Hono();
const registerSchema = z.object({
    username: z.string().min(3).max(20).regex(/^[a-z0-9_]+$/, "Only lowercase letters, numbers and underscores"),
    displayName: z.string().min(1).max(50),
    email: z.string().email(),
    password: z.string().min(6),
});
const loginSchema = z.object({
    usernameOrEmail: z.string().min(1),
    password: z.string().min(1),
});
// POST /auth/register
auth.post("/register", async (c) => {
    try {
        const body = await c.req.json();
        const data = registerSchema.parse(body);
        const existing = await User.findOne({
            $or: [{ username: data.username }, { email: data.email }],
        });
        if (existing) {
            const field = existing.username === data.username ? "username" : "email";
            return c.json({ error: `This ${field} is already taken` }, 409);
        }
        const hashedPassword = await bcrypt.hash(data.password, 12);
        const user = await User.create({
            username: data.username,
            displayName: data.displayName,
            email: data.email,
            password: hashedPassword,
        });
        const payload = { userId: user._id.toString(), username: user.username };
        const accessToken = await signAccessToken(payload);
        const refreshToken = await signRefreshToken(payload);
        return c.json({
            user: { _id: user._id, username: user.username, displayName: user.displayName, email: user.email },
            accessToken,
            refreshToken,
        }, 201);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return c.json({ error: err.errors[0].message }, 400);
        return c.json({ error: "Registration failed" }, 500);
    }
});
// POST /auth/login
auth.post("/login", async (c) => {
    try {
        const body = await c.req.json();
        const data = loginSchema.parse(body);
        const user = await User.findOne({
            $or: [{ username: data.usernameOrEmail.toLowerCase() }, { email: data.usernameOrEmail.toLowerCase() }],
        });
        if (!user)
            return c.json({ error: "Invalid credentials" }, 401);
        const valid = await bcrypt.compare(data.password, user.password);
        if (!valid)
            return c.json({ error: "Invalid credentials" }, 401);
        const payload = { userId: user._id.toString(), username: user.username };
        const accessToken = await signAccessToken(payload);
        const refreshToken = await signRefreshToken(payload);
        return c.json({
            user: { _id: user._id, username: user.username, displayName: user.displayName, email: user.email },
            accessToken,
            refreshToken,
        });
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return c.json({ error: err.errors[0].message }, 400);
        return c.json({ error: "Login failed" }, 500);
    }
});
// POST /auth/refresh
auth.post("/refresh", async (c) => {
    try {
        const { refreshToken } = await c.req.json();
        if (!refreshToken)
            return c.json({ error: "No refresh token" }, 400);
        const payload = await verifyRefreshToken(refreshToken);
        const accessToken = await signAccessToken(payload);
        return c.json({ accessToken });
    }
    catch {
        return c.json({ error: "Invalid refresh token" }, 401);
    }
});
// GET /auth/me
auth.get("/me", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const user = await User.findById(userId).select("-password").populate("friends", "username displayName").lean();
    if (!user)
        return c.json({ error: "User not found" }, 404);
    return c.json({ user: { ...user, _id: user._id.toString() } });
});
export default auth;
