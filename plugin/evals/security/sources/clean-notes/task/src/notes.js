import express from "express";
import { db } from "./db.js";
import { route } from "./async.js";

export const notesRouter = express.Router();

/**
 * Lists the signed in user's own notes that hold a search phrase
 */
notesRouter.get("/", route(async (req, res) => {
  const phrase = `%${String(req.query.q ?? "").replace(/[\\%_]/g, "\\$&")}%`;
  const { rows } = await db.query("SELECT id, title FROM notes WHERE owner_id = $1 AND title ILIKE $2 ORDER BY id DESC LIMIT 50", [req.user.id, phrase]);
  res.json(rows);
}));

/**
 * Deletes one of the signed in user's own notes
 */
notesRouter.delete("/:id", route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: "a numeric note id is required" });
  }
  const result = await db.query("DELETE FROM notes WHERE id = $1 AND owner_id = $2", [id, req.user.id]);
  res.json({ deleted: result.rowCount });
}));
