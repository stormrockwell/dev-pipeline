import express from "express";
import { Booking } from "./models.js";

export const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});
