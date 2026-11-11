import express from "express";

export const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});
