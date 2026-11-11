import jwt from "jsonwebtoken";
import { db } from "./db.js";
import { jwtSecret } from "./config.js";
import { route } from "./async.js";

/**
 * Loads the signed in user from a bearer token whose signature and expiry check out
 */
export const requireAuth = route(async (req, res, next) => {
  const token = (req.get("authorization") ?? "").replace(/^Bearer /, "");
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ error: "sign in first" });
  }
  const { rows } = await db.query("SELECT id, role FROM users WHERE id = $1", [claims.sub]);
  if (rows.length === 0) {
    return res.status(401).json({ error: "unknown user" });
  }
  req.user = rows[0];
  next();
});

/**
 * Lets only staff accounts through
 */
export function requireStaff(req, res, next) {
  if (req.user.role !== "staff") {
    return res.status(403).json({ error: "staff only" });
  }
  next();
}
