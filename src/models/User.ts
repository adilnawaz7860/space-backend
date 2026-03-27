import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  username: string;
  displayName: string;
  email: string;
  password: string;
  avatar?: string;
  bio?: string;
  friends: mongoose.Types.ObjectId[];
  friendRequests: {
    from: mongoose.Types.ObjectId;
    sentAt: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 20 },
    displayName: { type: String, required: true, trim: true, maxlength: 50 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    avatar: { type: String },
    bio: { type: String, maxlength: 160 },
    friends: [{ type: Schema.Types.ObjectId, ref: "User" }],
    friendRequests: [
      {
        from: { type: Schema.Types.ObjectId, ref: "User" },
        sentAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

UserSchema.index({ username: "text", displayName: "text" });

export const User = mongoose.model<IUser>("User", UserSchema);
