const secret = process.env.JWT_SECRET;

if (!secret || secret.length < 32) {
  throw new Error("JWT_SECRET must be set to at least 32 characters");
}

export const jwtSecret = secret;
