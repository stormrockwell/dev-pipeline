import express from "express";
import { requireAuth, requireStaff } from "./auth.js";
import { notesRouter } from "./notes.js";
import { resetRouter } from "./reset.js";
import { adminRouter } from "./admin.js";

export const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/notes", requireAuth, notesRouter);
app.use("/reset", resetRouter);
app.use("/admin", requireAuth, requireStaff, adminRouter);

app.use((err, req, res, next) => {
  console.error("request failed", err.code ?? err.name);
  res.status(500).json({ error: "server error" });
});
