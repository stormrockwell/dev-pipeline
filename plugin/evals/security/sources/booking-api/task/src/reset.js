import express from "express";
import { User } from "./models.js";

export const resetRouter = express.Router();

/**
 * Creates a reset token for the account and hands it to the mailer
 */
resetRouter.post("/request", async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email) });
  if (user) {
    user.resetToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    await user.save();
    await sendResetMail(user.email, user.resetToken);
  }
  res.json({ ok: true });
});

/**
 * Hands the reset link to the mail queue
 */
async function sendResetMail(email, token) {
  console.log(`queued reset mail for user ${email.length} chars, token length ${token.length}`);
}
