import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";

const JWT_SECRET = process.env.JWT_SECRET || (process.env.FINWISE_DESKTOP === "true" ? "desktop-fallback-secret-key-12345" : undefined);
if (!JWT_SECRET) throw new Error("JWT_SECRET environment variable is required");
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ─── Password hashing ─────────────────────────────────────────────────────────

function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

function hashPassword(password: string, salt: string): string {
  return crypto
    .pbkdf2Sync(password, salt, 100_000, 64, "sha512")
    .toString("hex");
}

// ─── JWT (pure Node crypto, no extra packages) ────────────────────────────────

function signToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", JWT_SECRET!)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET!)
    .update(`${header}.${body}`)
    .digest("base64url");
  if (sig !== expected) return null;
  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString()
  ) as Record<string, unknown>;
  if (
    typeof payload.exp === "number" &&
    payload.exp < Math.floor(Date.now() / 1000)
  )
    return null;
  return payload;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function needsSetup(): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(users);
  return Number(row?.n ?? 0) === 0;
}

export async function register(
  username: string,
  password: string
): Promise<string> {
  if (!(await needsSetup()))
    throw Object.assign(new Error("Setup already complete"), { status: 409 });
  if (password.length < 8)
    throw Object.assign(new Error("Password must be at least 8 characters"), {
      status: 400,
    });

  const db = getDb();
  const salt = generateSalt();
  const hash = hashPassword(password, salt);
  const [user] = await db
    .insert(users)
    .values({ username, password_hash: hash, salt })
    .returning();
  return signToken({ sub: user.id, username: user.username });
}

export async function login(
  username: string,
  password: string
): Promise<string> {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  if (!user)
    throw Object.assign(new Error("Invalid credentials"), { status: 401 });

  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash)
    throw Object.assign(new Error("Invalid credentials"), { status: 401 });

  return signToken({ sub: user.id, username: user.username });
}
