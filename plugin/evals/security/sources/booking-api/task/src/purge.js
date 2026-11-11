import express from "express";
import { Booking } from "./models.js";

export const purgeRouter = express.Router();

/**
 * Removes old bookings, or every booking when no cutoff date is given
 */
purgeRouter.post("/purge", async (req, res) => {
  const filter = req.body.before ? { date: { $lt: new Date(req.body.before) } } : {};
  const result = await Booking.deleteMany(filter);
  res.json({ deleted: result.deletedCount });
});
