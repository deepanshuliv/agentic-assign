import { one, run } from "./db.js";
import { linkedinHandle, instagramHandle } from "./scrape.js";
import { hashPassword } from "./auth.js";

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const SEXES = ["male", "female"];
const ORIENTATIONS = ["straight", "gay", "bisexual", "unspecified"];

/** Validate + insert a person. With `account` it also becomes a login (email + password). */
export async function createUser(p, { account = false } = {}) {
  const name = String(p.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw new HttpError(400, "Enter a name between 2 and 80 characters", { field: "name" });
  if (!SEXES.includes(p.sex)) throw new HttpError(400, "Choose male or female", { field: "sex" });
  const orientation = p.orientation || "unspecified";
  if (!ORIENTATIONS.includes(orientation)) throw new HttpError(400, "Choose an orientation", { field: "orientation" });
  let age = null;
  if (p.age !== undefined && p.age !== null && String(p.age).trim() !== "") {
    age = Number(p.age);
    if (!Number.isInteger(age) || age < 18 || age > 100) throw new HttpError(400, "Age must be a whole number from 18 to 100", { field: "age" });
  }
  let li, ig;
  try { li = linkedinHandle(p.linkedin_url); } catch (e) { throw new HttpError(400, e.message, { field: "linkedin_url" }); }
  try { ig = instagramHandle(p.instagram_url); } catch (e) { throw new HttpError(400, e.message, { field: "instagram_url" }); }

  let email = null, password_hash = null;
  if (account) {
    email = String(p.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Enter a valid email", { field: "email" });
    if (String(p.password || "").length < 8) throw new HttpError(400, "Password must be at least 8 characters", { field: "password" });
    if (await one("SELECT id FROM users WHERE email = ?", [email])) throw new HttpError(409, "An account with this email already exists. Log in instead.", { field: "email" });
    password_hash = hashPassword(String(p.password));
  }

  const existing = await one("SELECT id, email FROM users WHERE linkedin_handle = ? OR instagram_handle = ?", [li, ig]);
  if (existing)
    throw new HttpError(409, existing.email ? "These profiles already belong to an account. Log in instead." : "This person is already in the pool.", {
      field: "linkedin_url", existing_id: existing.id,
    });

  const r = await run(
    `INSERT INTO users (name, age, sex, orientation, instagram_handle, linkedin_handle, linkedin_url, instagram_url, email, password_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, age, p.sex, orientation, ig, li, `https://www.linkedin.com/in/${li}/`, `https://www.instagram.com/${ig}/`, email, password_hash]
  );
  return r.id;
}
