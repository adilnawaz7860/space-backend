import { Hono } from "hono";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { authMiddleware } from "../middleware/auth.js";
const friends = new Hono();
friends.use("*", authMiddleware);
// GET /friends - list my friends
friends.get("/", async (c) => {
    const userId = c.get("userId");
    const user = await User.findById(userId)
        .populate("friends", "username displayName bio")
        .lean();
    if (!user)
        return c.json({ error: "Not found" }, 404);
    return c.json({ friends: user.friends });
});
// GET /friends/requests - list incoming requests
friends.get("/requests", async (c) => {
    const userId = c.get("userId");
    const user = await User.findById(userId)
        .populate("friendRequests.from", "username displayName")
        .lean();
    if (!user)
        return c.json({ error: "Not found" }, 404);
    const pending = user.friendRequests.filter((r) => true); // all requests shown
    return c.json({ requests: pending });
});
// GET /friends/search?q=query
friends.get("/search", async (c) => {
    const userId = c.get("userId");
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 2)
        return c.json({ users: [] });
    const users = await User.find({
        _id: { $ne: new mongoose.Types.ObjectId(userId) },
        $or: [
            { username: { $regex: q, $options: "i" } },
            { displayName: { $regex: q, $options: "i" } },
        ],
    })
        .select("username displayName bio")
        .limit(20)
        .lean();
    return c.json({ users });
});
// POST /friends/request/:targetId
friends.post("/request/:targetId", async (c) => {
    const userId = c.get("userId");
    const { targetId } = c.req.param();
    if (userId === targetId)
        return c.json({ error: "Cannot add yourself" }, 400);
    const target = await User.findById(targetId);
    if (!target)
        return c.json({ error: "User not found" }, 404);
    const myId = new mongoose.Types.ObjectId(userId);
    // Already friends?
    if (target.friends.some((f) => f.toString() === userId)) {
        return c.json({ error: "Already friends" }, 409);
    }
    // Already requested?
    if (target.friendRequests.some((r) => r.from.toString() === userId)) {
        return c.json({ error: "Request already sent" }, 409);
    }
    target.friendRequests.push({ from: myId, sentAt: new Date() });
    await target.save();
    return c.json({ message: "Friend request sent" });
});
// POST /friends/accept/:requesterId
friends.post("/accept/:requesterId", async (c) => {
    const userId = c.get("userId");
    const { requesterId } = c.req.param();
    const [me, requester] = await Promise.all([
        User.findById(userId),
        User.findById(requesterId),
    ]);
    if (!me || !requester)
        return c.json({ error: "User not found" }, 404);
    const myId = new mongoose.Types.ObjectId(userId);
    const reqId = new mongoose.Types.ObjectId(requesterId);
    // Remove the request
    me.friendRequests = me.friendRequests.filter((r) => r.from.toString() !== requesterId);
    // Add each other as friends (avoid duplicates)
    if (!me.friends.some((f) => f.toString() === requesterId))
        me.friends.push(reqId);
    if (!requester.friends.some((f) => f.toString() === userId))
        requester.friends.push(myId);
    await Promise.all([me.save(), requester.save()]);
    return c.json({ message: "Friend added" });
});
// POST /friends/decline/:requesterId
friends.post("/decline/:requesterId", async (c) => {
    const userId = c.get("userId");
    const { requesterId } = c.req.param();
    const me = await User.findById(userId);
    if (!me)
        return c.json({ error: "Not found" }, 404);
    me.friendRequests = me.friendRequests.filter((r) => r.from.toString() !== requesterId);
    await me.save();
    return c.json({ message: "Request declined" });
});
// DELETE /friends/:friendId
friends.delete("/:friendId", async (c) => {
    const userId = c.get("userId");
    const { friendId } = c.req.param();
    const [me, friend] = await Promise.all([User.findById(userId), User.findById(friendId)]);
    if (!me || !friend)
        return c.json({ error: "Not found" }, 404);
    me.friends = me.friends.filter((f) => f.toString() !== friendId);
    friend.friends = friend.friends.filter((f) => f.toString() !== userId);
    await Promise.all([me.save(), friend.save()]);
    return c.json({ message: "Friend removed" });
});
export default friends;
