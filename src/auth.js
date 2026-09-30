import crypto from "node:crypto";

const SECRET = () => process.env.SESSION_SECRET || "dev-only-secret";
const COOKIE = "ph_session";
const MAX_AGE = 30 * 24 * 3600;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, "hex");
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

const sign = (v) => crypto.createHmac("sha256", SECRET()).update(v).digest("base64url");

export function setSession(res, userId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const v = `${userId}.${exp}`;
  const secure = process.env.VERCEL ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
}
export function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Express middleware: req.userId from a valid signed cookie. */
export function session(req, _res, next) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [uid, exp, sig] = (raw || "").split(".");
  if (uid && exp && sig) {
    const good = sign(`${uid}.${exp}`);
    if (sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) && Number(exp) > Date.now() / 1000)
      req.userId = Number(uid);
  }
  next();
}
