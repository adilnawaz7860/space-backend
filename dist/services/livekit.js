import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
export function getRoomServiceClient() {
    return new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
}
export async function generateLivekitToken(opts) {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: opts.participantIdentity,
        name: opts.participantName,
        ttl: "4h",
    });
    at.addGrant({
        room: opts.roomName,
        roomJoin: true,
        canPublish: opts.canPublish,
        canSubscribe: opts.canSubscribe,
        canPublishData: opts.canPublishData,
    });
    return at.toJwt();
}
export async function createLivekitRoom(roomName) {
    const svc = getRoomServiceClient();
    await svc.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 500 });
}
export async function deleteLivekitRoom(roomName) {
    try {
        const svc = getRoomServiceClient();
        await svc.deleteRoom(roomName);
    }
    catch {
        // Room may already be gone
    }
}
export function generateRoomName() {
    return `space_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
