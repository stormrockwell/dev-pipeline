import express from "express";
import { scryptSync, randomBytes } from "node:crypto";
import { User } from "./models.js";

export const signupRouter = express.Router();

/**
 * Creates a customer account from an email and password
 */
signupRouter.post("/", async (req, res) => {
  const { email, password } = req.body;
  console.log("signup attempt", { email, password });
  if (typeof email !== "string" || typeof password !== "string" || password.length < 10) {
    return res.status(400).json({ error: "an email and a password of 10 or more characters are required" });
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  await User.create({ email, passwordHash: `${salt}:${hash}` });
  res.status(201).json({ ok: true });
});
