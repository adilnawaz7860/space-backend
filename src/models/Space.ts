import mongoose, { Schema, Document } from "mongoose";

export type SpaceStatus = "live" | "ended" | "scheduled";
export type ParticipantRole = "host" | "cohost" | "speaker" | "listener";

export interface IParticipant {
  user: mongoose.Types.ObjectId;
  role: ParticipantRole;
  micOn: boolean;
  handRaised: boolean;
  joinedAt: Date;
}

export interface IJoinRequest {
  _id?: mongoose.Types.ObjectId; // ← add this line
  user: mongoose.Types.ObjectId;
  requestedAt: Date;
  status: "pending" | "approved" | "denied";
}

export interface ISpace extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  topic: string;
  host: mongoose.Types.ObjectId;
  participants: IParticipant[];
  inviteOnly: boolean;
  invitedUsers: mongoose.Types.ObjectId[];
  joinRequests: IJoinRequest[];
  status: SpaceStatus;
  recordingEnabled: boolean;
  livekitRoomName: string;
  startedAt: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ParticipantSchema = new Schema<IParticipant>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: ["host", "cohost", "speaker", "listener"], required: true },
  micOn: { type: Boolean, default: true },
  handRaised: { type: Boolean, default: false },
  joinedAt: { type: Date, default: Date.now },
});

const JoinRequestSchema = new Schema<IJoinRequest>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  requestedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ["pending", "approved", "denied"], default: "pending" },
});

const SpaceSchema = new Schema<ISpace>(
  {
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
  },
  { timestamps: true }
);

SpaceSchema.index({ status: 1, startedAt: -1 });
SpaceSchema.index({ host: 1 });

export const Space = mongoose.model<ISpace>("Space", SpaceSchema);
