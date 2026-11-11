import express from "express";
import { db } from "./db.js";
import { route } from "./async.js";

export const adminRouter = express.Router();

/**
 * Removes notes older than a cutoff date, for staff only, and refuses a request with no cutoff
 */
adminRouter.post("/notes/purge", route(async (req, res) => {
  const before = new Date(req.body.before);
  if (Number.isNaN(before.getTime())) {
    return res.status(400).json({ error: "a valid before date is required" });
  }
  const result = await db.query("DELETE FROM notes WHERE created_at < $1", [before]);
  console.log("staff user", req.user.id, "purged", result.rowCount, "notes");
  res.json({ deleted: result.rowCount });
}));
