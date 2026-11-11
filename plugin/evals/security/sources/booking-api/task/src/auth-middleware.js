import jwt from "jsonwebtoken";
import { User } from "./models.js";

/**
 * Loads the signed in user from the bearer token on the request
 */
export async function requireAuth(req, res, next) {
  const token = (req.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!token) {
    return res.status(401).json({ error: "sign in first" });
  }
  const claims = jwt.decode(token);
  const user = claims ? await User.findById(claims.sub) : null;
  if (!user) {
    return res.status(401).json({ error: "unknown user" });
  }
  req.user = user;
  next();
}
