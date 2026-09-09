/**
 * Who may use the panel.
 *
 * One password, stored in runtime/panel.json, and no username. A single shared
 * account gains nothing from a name that is always the same: it is not a second
 * secret, it is a second thing to mistype. The password is generated on first
 * boot rather than defaulted to something like "admin", so a server that is
 * reachable before anyone has configured it is not trivially open; deploy.sh
 * prints the generated password once, at the end of its run.
 *
 * Passwords are stored as scrypt hashes with a per-password salt. Sessions are
 * HMAC-signed cookies rather than server-side state, so a restart - which this
 * panel asks for after every settings change - does not log the operator out
 * mid-edit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

type PanelState = {
  passwordHash: string;
  passwordSalt: string;
  /** Signs session cookies. Rotating it invalidates every existing login. */
  sessionSecret: string;
  /** True until the operator changes the generated password. */
  mustChangePassword: boolean;
  createdAt: string;
};

let cached: PanelState | undefined;

function hash(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function write(state: PanelState): void {
  mkdirSync(path.dirname(config.panel.store), { recursive: true });
  const tmp = `${config.panel.store}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, config.panel.store);
  cached = state;
}

/**
 * A readable generated password. Hex would be safe too, but this gets read off
 * a terminal and typed into a browser, so the alphabet omits the characters
 * that are indistinguishable in most fonts.
 */
export function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** The generated password is returned exactly once: on the boot that creates it. */
let firstRunPassword: string | undefined;

export function loadPanel(): PanelState {
  if (cached) return cached;
  if (existsSync(config.panel.store)) {
    try {
      const parsed = JSON.parse(readFileSync(config.panel.store, "utf8")) as PanelState;
      if (parsed?.passwordHash) {
        cached = parsed;
        return parsed;
      }
    } catch {
      // Fall through and re-initialise rather than refuse to boot: losing the
      // admin password is recoverable by deleting the file, but a server that
      // will not start is not.
    }
  }

  const password = generatePassword();
  const salt = randomBytes(16).toString("hex");
  const state: PanelState = {
    passwordHash: hash(password, salt),
    passwordSalt: salt,
    sessionSecret: randomBytes(32).toString("hex"),
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  };
  write(state);
  firstRunPassword = password;
  return state;
}

/** Non-empty only on the very first boot, for deploy.sh to print. */
export function takeFirstRunPassword(): string | undefined {
  const value = firstRunPassword;
  firstRunPassword = undefined;
  return value;
}

export function verifyLogin(password: string): boolean {
  const state = loadPanel();
  const candidate = Buffer.from(hash(password, state.passwordSalt));
  const expected = Buffer.from(state.passwordHash);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function changePassword(next: string): void {
  const state = loadPanel();
  const salt = randomBytes(16).toString("hex");
  write({
    ...state,
    passwordSalt: salt,
    passwordHash: hash(next, salt),
    mustChangePassword: false,
  });
}

export function mustChangePassword(): boolean {
  return loadPanel().mustChangePassword;
}

export const SESSION_COOKIE = "malformedmcp_session";

/** expiry.signature - expiry 0 means no expiry; restart-safe either way. */
export function issueSession(): string {
  const state = loadPanel();
  const expiry = String(
    config.panel.sessionHours === 0 ? 0 : Date.now() + config.panel.sessionHours * 3_600_000,
  );
  const signature = createHmac("sha256", state.sessionSecret).update(expiry).digest("hex");
  return `${expiry}.${signature}`;
}

export function validSession(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 2) return false;
  const [expiry, signature] = parts as [string, string];
  const state = loadPanel();
  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs) || (expiryMs !== 0 && expiryMs < Date.now())) return false;

  const expected = createHmac("sha256", state.sessionSecret).update(expiry).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read one cookie without adding a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
