import express from "express";
import { requireAuth } from "./auth-middleware.js";
import { signupRouter } from "./signup.js";
import { resetRouter } from "./reset.js";
import { purgeRouter } from "./purge.js";

export const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/signup", signupRouter);
app.use("/reset", resetRouter);
app.use("/bookings", requireAuth, purgeRouter);
