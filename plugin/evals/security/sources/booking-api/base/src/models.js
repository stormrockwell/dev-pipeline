import mongoose from "mongoose";

export const User = mongoose.model(
  "User",
  new mongoose.Schema({
    email: { type: String, unique: true },
    passwordHash: String,
    role: { type: String, enum: ["customer", "staff"], default: "customer" },
    resetToken: String,
  }),
);

export const Booking = mongoose.model(
  "Booking",
  new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    date: Date,
    room: String,
  }),
);
