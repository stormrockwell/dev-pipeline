import express from "express";
import { handleShipped, verifyWebhookSignature } from "./orders.js";

export const router = express.Router();

router.post("/webhooks/acme", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifyWebhookSignature(req.body, req.get("X-Acme-Signature"))) return res.sendStatus(401);
  handleShipped(JSON.parse(req.body));
  return res.sendStatus(204);
});
