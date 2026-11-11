import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { route } from "./async.js";

export const resetRouter = express.Router();

/**
 * Creates a single use reset token that expires in an hour, and stores only its hash
 */
resetRouter.post("/request", route(async (req, res) => {
  const { rows } = await db.query("SELECT id, email FROM users WHERE email = $1", [String(req.body.email)]);
  if (rows.length > 0) {
    const token = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    await db.query("UPDATE users SET reset_hash = $1, reset_expires = now() + interval '1 hour' WHERE id = $2", [hash, rows[0].id]);
    console.log("reset requested for user", rows[0].id);
    await sendResetMail(rows[0].email, token);
  }
  res.json({ ok: true });
}));

/**
 * Hands the reset link to the mail queue
 */
async function sendResetMail(email, token) {
  await db.query("INSERT INTO mail_queue (recipient, template, token) VALUES ($1, 'reset', $2)", [email, token]);
}
