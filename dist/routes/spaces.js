import { Hono } from "hono";
import mongoose from "mongoose";
import { z } from "zod";
import { Space } from "../models/Space.js";
import { User } from "../models/User.js";
import { authMiddleware } from "../middleware/auth.js";
import { generateLivekitToken, createLivekitRoom, deleteLivekitRoom, generateRoomName } from "../services/livekit.js";
const spaces = new Hono();
// Module-level emitter so routes can push socket events
// Set by index.ts after io is created
let _io = null;
export function setIo(io) { _io = io; }
function pushSpaceState(spaceId) {
    if (!_io)
        return;
    Space.findById(spaceId)
        .populate("host", "username displayName")
        .populate("participants.user", "username displayName")
        .populate("invitedUsers", "_id username displayName")
        .populate("joinRequests.user", "username displayName")
        .lean()
        .then((space) => {
        if (space) {
            _io.to(`space:${spaceId}`).emit("space_state", toClean(space));
        }
    })
        .catch(() => { });
}
spaces.use("*", authMiddleware);
const SPEAKER_LIMIT = 15; // max speakers (excludes host + cohosts)
const COHOST_LIMIT = 3; // max co-hosts
// Recursively convert all ObjectIds to strings
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
// Helper: check if a userId is host or cohost of a space
function isHostOrCoHost(space, userId) {
    return (space.host.toString() === userId ||
        space.participants.some((p) => p.user.toString() === userId && p.role === "cohost"));
}
// Helper: update Livekit permissions silently
async function updateLivekitPerms(roomName, identity, canPublish) {
    try {
        const { getRoomServiceClient } = await import("../services/livekit.js");
        const svc = getRoomServiceClient();
        await svc.updateParticipant(roomName, identity, undefined, {
            canPublish,
            canSubscribe: true,
            canPublishData: true,
        });
    }
    catch { /* participant may not be connected yet — ignore */ }
}
// ─── GET /spaces — list spaces visible to this user ──────────────────────────
// Only shows spaces where the user is the host OR has been invited
spaces.get("/", async (c) => {
    const userId = c.get("userId");
    const myId = new mongoose.Types.ObjectId(userId);
    const raw = await Space.find({
        status: "live",
        $or: [
            { host: myId }, // user is the host
            { invitedUsers: myId }, // user has been invited
            { participants: { $elemMatch: { user: myId } } }, // user is already in the space
        ],
    })
        .sort({ startedAt: -1 })
        .populate("host", "username displayName")
        .populate("participants.user", "username displayName")
        .populate("invitedUsers", "_id username displayName")
        .lean();
    return c.json({ spaces: raw.map(toClean) });
});
// ─── GET /spaces/:id ─────────────────────────────────────────────────────────
spaces.get("/:id", async (c) => {
    const space = await Space.findById(c.req.param("id"))
        .populate("host", "username displayName")
        .populate("participants.user", "username displayName")
        .populate("invitedUsers", "_id username displayName")
        .populate("joinRequests.user", "username displayName")
        .lean();
    if (!space)
        return c.json({ error: "Space not found" }, 404);
    return c.json({ space: toClean(space) });
});
// ─── POST /spaces — create ───────────────────────────────────────────────────
spaces.post("/", async (c) => {
    try {
        const userId = c.get("userId");
        const body = await c.req.json();
        const schema = z.object({
            title: z.string().min(1).max(100),
            topic: z.string().max(280).optional().default(""),
            inviteOnly: z.boolean().default(false),
            recordingEnabled: z.boolean().default(false),
        });
        const data = schema.parse(body);
        const roomName = generateRoomName();
        await createLivekitRoom(roomName);
        const myId = new mongoose.Types.ObjectId(userId);
        const space = await Space.create({
            title: data.title,
            topic: data.topic,
            host: myId,
            participants: [{ user: myId, role: "host", micOn: true, handRaised: false, joinedAt: new Date() }],
            inviteOnly: data.inviteOnly,
            invitedUsers: [myId],
            joinRequests: [],
            status: "live",
            recordingEnabled: data.recordingEnabled,
            livekitRoomName: roomName,
            startedAt: new Date(),
        });
        await space.populate([
            { path: "host", select: "username displayName" },
            { path: "participants.user", select: "username displayName" },
            { path: "invitedUsers", select: "_id username displayName" },
        ]);
        return c.json({ space: toClean(space.toObject()) }, 201);
    }
    catch (err) {
        if (err instanceof z.ZodError)
            return c.json({ error: err.errors[0].message }, 400);
        return c.json({ error: "Failed to create space" }, 500);
    }
});
// ─── POST /spaces/:id/join ───────────────────────────────────────────────────
spaces.post("/:id/join", async (c) => {
    const userId = c.get("userId");
    const space = await Space.findById(c.req.param("id"));
    if (!space)
        return c.json({ error: "Space not found" }, 404);
    if (space.status !== "live")
        return c.json({ error: "Space is not live" }, 400);
    const myId = new mongoose.Types.ObjectId(userId);
    const isInvited = space.invitedUsers.some((u) => u.toString() === userId);
    const isHost = space.host.toString() === userId;
    const alreadyIn = space.participants.some((p) => p.user.toString() === userId);
    if (space.inviteOnly && !isInvited && !isHost)
        return c.json({ error: "invite_only" }, 403);
    if (!alreadyIn) {
        await Space.findByIdAndUpdate(space._id, {
            $push: { participants: { user: myId, role: "listener", micOn: false, handRaised: false, joinedAt: new Date() } }
        });
        pushSpaceState(space._id.toString());
    }
    return c.json({ message: "Joined" });
});
// ─── POST /spaces/:id/leave ──────────────────────────────────────────────────
spaces.post("/:id/leave", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    // Atomic: only pull listeners, keep speakers/cohosts so role persists on rejoin
    await Space.findByIdAndUpdate(id, {
        $pull: { participants: { user: new mongoose.Types.ObjectId(userId), role: "listener" } }
    });
    return c.json({ message: "Left space" });
});
// ─── POST /spaces/:id/leave-hard ─────────────────────────────────────────────
spaces.post("/:id/leave-hard", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    await Space.findByIdAndUpdate(id, {
        $pull: { participants: { user: new mongoose.Types.ObjectId(userId) } }
    });
    pushSpaceState(id);
    return c.json({ message: "Left space" });
});
// ─── POST /spaces/:id/end ────────────────────────────────────────────────────
spaces.post("/:id/end", async (c) => {
    const userId = c.get("userId");
    const space = await Space.findById(c.req.param("id"));
    if (!space)
        return c.json({ error: "Not found" }, 404);
    if (space.host.toString() !== userId)
        return c.json({ error: "Only host can end" }, 403);
    space.status = "ended";
    space.endedAt = new Date();
    await space.save();
    await deleteLivekitRoom(space.livekitRoomName);
    return c.json({ message: "Space ended" });
});
// ─── POST /spaces/:id/token — Livekit token ──────────────────────────────────
spaces.post("/:id/token", async (c) => {
    const userId = c.get("userId");
    const username = c.get("username");
    const space = await Space.findById(c.req.param("id"))
        .populate("participants.user", "username displayName");
    if (!space)
        return c.json({ error: "Not found" }, 404);
    const participant = space.participants.find((p) => p.user.toString() === userId || p.user._id?.toString() === userId);
    const role = participant?.role || "listener";
    const canPublish = role === "host" || role === "cohost" || role === "speaker";
    const user = await User.findById(userId).select("displayName");
    const token = await generateLivekitToken({
        roomName: space.livekitRoomName,
        participantName: user?.displayName || username,
        participantIdentity: userId,
        canPublish,
        canSubscribe: true,
        canPublishData: true,
    });
    return c.json({ token, roomName: space.livekitRoomName, livekitUrl: process.env.LIVEKIT_URL });
});
// ─── POST /spaces/:id/invite/:targetUserId ───────────────────────────────────
spaces.post("/:id/invite/:targetUserId", async (c) => {
    const userId = c.get("userId");
    const { id, targetUserId } = c.req.param();
    // Fetch as Mongoose document (not lean) so .toString() works on ObjectIds
    const space = await Space.findById(id);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    if (!isHostOrCoHost(space, userId))
        return c.json({ error: "Only host or co-host can invite" }, 403);
    // Add to invitedUsers
    const targetId = new mongoose.Types.ObjectId(targetUserId);
    if (!space.invitedUsers.some((u) => u.toString() === targetUserId)) {
        space.invitedUsers.push(targetId);
        await space.save();
    }
    // Fetch host info for the notification
    const hostUser = await User.findById(space.host).select("username displayName").lean();
    // Push real-time invite notification to the invited user's personal socket room
    if (_io) {
        const room = _io.sockets.adapter.rooms.get(`user:${targetUserId}`);
        console.log(`📨 Invite: emitting to user:${targetUserId}, room size: ${room?.size ?? 0}`);
        _io.to(`user:${targetUserId}`).emit("space_invite", {
            spaceId: id,
            spaceTitle: space.title,
            host: hostUser,
        });
        _io.to(`user:${targetUserId}`).emit("spaces_refresh");
    }
    else {
        console.log("⚠️ _io is null — setIo() not called yet");
    }
    return c.json({ message: "Invited" });
});
// ─── POST /spaces/:id/request — join request (invite-only) ───────────────────
spaces.post("/:id/request", async (c) => {
    const userId = c.get("userId");
    const space = await Space.findById(c.req.param("id"));
    if (!space)
        return c.json({ error: "Not found" }, 404);
    if (!space.inviteOnly)
        return c.json({ error: "Space is open" }, 400);
    const myId = new mongoose.Types.ObjectId(userId);
    const alreadyRequested = space.joinRequests.some((r) => r.user.toString() === userId);
    if (alreadyRequested)
        return c.json({ error: "Already requested" }, 409);
    space.joinRequests.push({ user: myId, requestedAt: new Date(), status: "pending" });
    await space.save();
    return c.json({ message: "Request sent" });
});
// ─── POST /spaces/:id/request/:requestId/approve ─────────────────────────────
spaces.post("/:id/request/:requestId/approve", async (c) => {
    const userId = c.get("userId");
    const { id, requestId } = c.req.param();
    const space = await Space.findById(id);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    if (space.host.toString() !== userId)
        return c.json({ error: "Only host can approve" }, 403);
    const req = space.joinRequests.find((r) => r._id?.toString() === requestId);
    if (!req)
        return c.json({ error: "Request not found" }, 404);
    req.status = "approved";
    space.invitedUsers.push(req.user);
    space.participants.push({ user: req.user, role: "listener", micOn: false, handRaised: false, joinedAt: new Date() });
    await space.save();
    pushSpaceState(id);
    return c.json({ message: "Approved" });
});
// ─── POST /spaces/:id/request/:requestId/deny ────────────────────────────────
spaces.post("/:id/request/:requestId/deny", async (c) => {
    const userId = c.get("userId");
    const { id, requestId } = c.req.param();
    const space = await Space.findById(id);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    if (space.host.toString() !== userId)
        return c.json({ error: "Only host can deny" }, 403);
    const req = space.joinRequests.find((r) => r._id?.toString() === requestId);
    if (req)
        req.status = "denied";
    await space.save();
    pushSpaceState(id);
    return c.json({ message: "Denied" });
});
// ─── POST /spaces/:id/speak-request — listener requests to speak ─────────────
spaces.post("/:id/speak-request", async (c) => {
    const userId = c.get("userId");
    const spaceId = c.req.param("id");
    const space = await Space.findById(spaceId);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    const participant = space.participants.find((p) => p.user.toString() === userId);
    if (!participant)
        return c.json({ error: "Not in this space" }, 403);
    if (participant.role !== "listener")
        return c.json({ error: "Only listeners can request to speak" }, 400);
    participant.handRaised = true;
    await space.save();
    // Push to host in real-time directly from backend (don't rely on frontend socket)
    pushSpaceState(spaceId);
    return c.json({ message: "Speak request sent" });
});
// ─── DELETE /spaces/:id/speak-request — cancel speak request ─────────────────
spaces.delete("/:id/speak-request", async (c) => {
    const userId = c.get("userId");
    const spaceId = c.req.param("id");
    const space = await Space.findById(spaceId);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    const participant = space.participants.find((p) => p.user.toString() === userId);
    if (participant) {
        participant.handRaised = false;
        await space.save();
    }
    pushSpaceState(spaceId);
    return c.json({ message: "Request cancelled" });
});
// ─── PATCH /spaces/:id/participant/:targetUserId/role ────────────────────────
// Host can assign: cohost, speaker, listener
// Co-host can assign: speaker, listener (cannot make co-hosts)
spaces.patch("/:id/participant/:targetUserId/role", async (c) => {
    const userId = c.get("userId");
    const { id, targetUserId } = c.req.param();
    const { role } = await c.req.json();
    const space = await Space.findById(id);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    const isHost = space.host.toString() === userId;
    const myRole = space.participants.find((p) => p.user.toString() === userId)?.role;
    const isCoHost = myRole === "cohost";
    // Permission check
    if (!isHost && !isCoHost)
        return c.json({ error: "Only host or co-host can assign roles" }, 403);
    // Co-hosts cannot assign co-host role — only host can
    if (!isHost && role === "cohost")
        return c.json({ error: "Only host can assign co-host role" }, 403);
    // Nobody can change the host's own role
    if (targetUserId === space.host.toString())
        return c.json({ error: "Cannot change host role" }, 403);
    if (!["cohost", "speaker", "listener"].includes(role))
        return c.json({ error: "Invalid role" }, 400);
    // Enforce limits BEFORE assigning
    if (role === "cohost") {
        const currentCohosts = space.participants.filter((p) => p.role === "cohost" && p.user.toString() !== targetUserId).length;
        if (currentCohosts >= COHOST_LIMIT)
            return c.json({ error: `Co-host limit reached (max ${COHOST_LIMIT})` }, 400);
    }
    if (role === "speaker") {
        const currentSpeakers = space.participants.filter((p) => p.role === "speaker" && p.user.toString() !== targetUserId).length;
        if (currentSpeakers >= SPEAKER_LIMIT)
            return c.json({ error: `Speaker limit reached (max ${SPEAKER_LIMIT})` }, 400);
    }
    const participant = space.participants.find((p) => p.user.toString() === targetUserId);
    if (!participant)
        return c.json({ error: "Participant not found" }, 404);
    // If demoted from speaker/cohost, lower hand
    if (role === "listener")
        participant.handRaised = false;
    participant.role = role;
    await updateLivekitPerms(space.livekitRoomName, targetUserId, role === "cohost" || role === "speaker");
    await space.save();
    // Push to all in room immediately — frontend no longer fetches after setRole
    pushSpaceState(id);
    return c.json({ message: "Role updated", limits: { speakers: SPEAKER_LIMIT, cohosts: COHOST_LIMIT } });
});
// ─── PATCH /spaces/:id/participant/:targetUserId/mic ─────────────────────────
spaces.patch("/:id/participant/:targetUserId/mic", async (c) => {
    const userId = c.get("userId");
    const { id, targetUserId } = c.req.param();
    const { micOn } = await c.req.json();
    const space = await Space.findById(id);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    const isSelf = userId === targetUserId;
    if (!isHostOrCoHost(space, userId) && !isSelf)
        return c.json({ error: "Unauthorized" }, 403);
    // Host/cohost can only MUTE others (not unmute) — speaker controls their own unmute
    if (!isSelf && micOn === true)
        return c.json({ error: "Cannot unmute others" }, 403);
    const participant = space.participants.find((p) => p.user.toString() === targetUserId);
    if (participant)
        participant.micOn = micOn;
    await space.save();
    // Push to all in room so speaker's mic updates in real-time
    pushSpaceState(id);
    return c.json({ message: "Mic updated" });
});
// ─── PATCH /spaces/:id/hand — toggle own hand ────────────────────────────────
spaces.patch("/:id/hand", async (c) => {
    const userId = c.get("userId");
    const space = await Space.findById(c.req.param("id"));
    if (!space)
        return c.json({ error: "Not found" }, 404);
    const participant = space.participants.find((p) => p.user.toString() === userId);
    if (participant)
        participant.handRaised = !participant.handRaised;
    await space.save();
    return c.json({ handRaised: participant?.handRaised });
});
// ─── PATCH /spaces/:id/participant/:targetUserId/hand — host/cohost lower hand
spaces.patch("/:id/participant/:targetUserId/hand", async (c) => {
    const userId = c.get("userId");
    const { id, targetUserId } = c.req.param();
    const space = await Space.findById(id);
    if (!space)
        return c.json({ error: "Not found" }, 404);
    if (!isHostOrCoHost(space, userId))
        return c.json({ error: "Only host or co-host can lower hands" }, 403);
    const participant = space.participants.find((p) => p.user.toString() === targetUserId);
    if (participant)
        participant.handRaised = false;
    await space.save();
    pushSpaceState(id);
    return c.json({ message: "Hand lowered" });
});
export default spaces;
