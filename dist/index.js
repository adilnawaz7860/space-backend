import "dotenv/config";
import { createServer } from "http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Server as SocketServer } from "socket.io";
import { connectDB } from "./lib/db.js";
import authRoutes from "./routes/auth.js";
import friendsRoutes from "./routes/friends.js";
import spacesRoutes, { setIo } from "./routes/spaces.js";
import { verifyAccessToken } from "./services/jwt.js";
import { Space } from "./models/Space.js";
function toClean(obj) {
    if (obj === null || obj === undefined)
        return obj;
    if (typeof obj === "object" && obj._bsontype === "ObjectId")
        return obj.toString();
    if (Array.isArray(obj))
        return obj.map(toClean);
    if (obj instanceof Date)
        return obj;
    if (typeof obj === "object") {
        const out = {};
        for (const k of Object.keys(obj))
            out[k] = toClean(obj[k]);
        if (out._id && typeof out._id !== "string")
            out._id = out._id.toString();
        return out;
    }
    return obj;
}
// ─── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
app.use("*", cors({
    origin: FRONTEND_URL,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
}));
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/auth", authRoutes);
app.route("/friends", friendsRoutes);
app.route("/spaces", spacesRoutes);
app.notFound((c) => c.json({ error: "Not found" }, 404));
// ─── Bridge Node HTTP → Hono fetch ───────────────────────────────────────────
async function nodeToHono(req, res) {
    try {
        const host = req.headers.host || "localhost:4000";
        const url = `http://${host}${req.url ?? "/"}`;
        // Read body (skip for GET/HEAD/OPTIONS)
        let body;
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
            const chunks = [];
            for await (const chunk of req)
                chunks.push(Buffer.from(chunk));
            if (chunks.length > 0)
                body = Buffer.concat(chunks);
        }
        // Build headers — filter out undefined values
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (v)
                headers[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        const webReq = new Request(url, {
            method: req.method ?? "GET",
            headers,
            body: body && body.length > 0 ? body : undefined,
        });
        const webRes = await app.fetch(webReq);
        // Write status + headers
        const resHeaders = {};
        webRes.headers.forEach((v, k) => { resHeaders[k] = v; });
        res.writeHead(webRes.status, resHeaders);
        // Write body
        if (webRes.body) {
            const reader = webRes.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                res.write(value);
            }
        }
        res.end();
    }
    catch (err) {
        console.error("Request handling error:", err);
        if (!res.headersSent)
            res.writeHead(500);
        res.end("Internal Server Error");
    }
}
// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = createServer(nodeToHono);
// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
    cors: {
        origin: FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true,
    },
    path: "/socket.io",
});
// Give routes access to io for real-time pushes
setIo(io);
io.use(async (socket, next) => {
    try {
        const payload = await verifyAccessToken(socket.handshake.auth.token || "");
        socket.data.userId = payload.userId;
        socket.data.username = payload.username;
        next();
    }
    catch {
        next(new Error("Unauthorized"));
    }
});
io.on("connection", (socket) => {
    const { userId, username } = socket.data;
    console.log(`🔌 Socket: ${username} connected`);
    // Each user joins their personal room for direct notifications (invites etc)
    socket.join(`user:${userId}`);
    socket.on("join_space", async (spaceId) => {
        socket.join(`space:${spaceId}`);
        const space = await Space.findById(spaceId)
            .populate("host", "username displayName")
            .populate("participants.user", "username displayName")
            .populate("invitedUsers", "_id username displayName")
            .populate("joinRequests.user", "username displayName")
            .lean();
        if (space) {
            socket.emit("space_state", toClean(space));
            socket.to(`space:${spaceId}`).emit("participant_joined", { userId, username });
        }
    });
    socket.on("leave_space", (spaceId) => {
        socket.leave(`space:${spaceId}`);
        socket.to(`space:${spaceId}`).emit("participant_left", { userId });
    });
    socket.on("role_changed", (data) => {
        io.to(`space:${data.spaceId}`).emit("role_changed", data);
    });
    socket.on("mic_changed", (data) => {
        io.to(`space:${data.spaceId}`).emit("mic_changed", data);
    });
    socket.on("hand_changed", (data) => {
        io.to(`space:${data.spaceId}`).emit("hand_changed", { userId, ...data });
    });
    socket.on("space_ended", (spaceId) => {
        io.to(`space:${spaceId}`).emit("space_ended", { spaceId });
    });
    socket.on("space_updated", async (spaceId) => {
        console.log(`🔄 space_updated for ${spaceId} — broadcasting to room`);
        const space = await Space.findById(spaceId)
            .populate("host", "username displayName")
            .populate("participants.user", "username displayName")
            .populate("invitedUsers", "_id username displayName")
            .populate("joinRequests.user", "username displayName")
            .lean();
        if (space) {
            const cleaned = toClean(space);
            // Emit to everyone in the room INCLUDING the sender
            io.to(`space:${spaceId}`).emit("space_state", cleaned);
            // Also emit directly to sender in case they're not in the room yet
            socket.emit("space_state", cleaned);
            console.log(`✅ Emitted space_state to room space:${spaceId} (${io.sockets.adapter.rooms.get(`space:${spaceId}`)?.size ?? 0} sockets)`);
        }
        else {
            console.log(`⚠️ space_updated: space ${spaceId} not found in DB`);
        }
    });
    socket.on("disconnect", () => console.log(`🔌 Socket: ${username} left`));
});
// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
    await connectDB();
    const PORT = parseInt(process.env.PORT || "4000");
    httpServer.listen(PORT, () => {
        console.log(`🚀 Backend running on http://localhost:${PORT}`);
        console.log(`✅ CORS allowed for: ${FRONTEND_URL}`);
        console.log(`🔌 Socket.io on ws://localhost:${PORT}/socket.io`);
    });
}
main().catch(console.error);
