import mongoose, { Schema } from "mongoose";
const ParticipantSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["host", "cohost", "speaker", "listener"], required: true },
    micOn: { type: Boolean, default: true },
    handRaised: { type: Boolean, default: false },
    joinedAt: { type: Date, default: Date.now },
});
const JoinRequestSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requestedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["pending", "approved", "denied"], default: "pending" },
});
const SpaceSchema = new Schema({
    title: { type: String, required: true, trim: true, maxlength: 100 },
    topic: { type: String, trim: true, maxlength: 280 },
    host: { type: Schema.Types.ObjectId, ref: "User", required: true },
    participants: [ParticipantSchema],
    inviteOnly: { type: Boolean, default: false },
    invitedUsers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    joinRequests: [JoinRequestSchema],
    status: { type: String, enum: ["live", "ended", "scheduled"], default: "live" },
    recordingEnabled: { type: Boolean, default: false },
    livekitRoomName: { type: String, required: true, unique: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
}, { timestamps: true });
SpaceSchema.index({ status: 1, startedAt: -1 });
SpaceSchema.index({ host: 1 });
export const Space = mongoose.model("Space", SpaceSchema);
