import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { cleanLabel } from "./state.ts";
import type { OfficeSnapshot } from "./office.ts";

// Administratively scoped IPv4 multicast, never a public rendezvous service.
export const OFFICE_GROUP = "239.255.77.80";
export const OFFICE_PORT = 47831;
export const OFFICE_MAX_PACKET = 4096;
export const OFFICE_FRESH_MS = 30_000;
export const OFFICE_CLOCK_SKEW_MS = 5_000;
export const OFFICE_MAX_PEERS = 128;
export const OFFICE_PEER_TTL_MS = 20_000;
export const OFFICE_HEARTBEAT_MS = 5_000;
const MAGIC = Buffer.from("OSO1");
const HEADER_BYTES = 32; // magic + 96-bit nonce + 128-bit authentication tag
const ID = /^[0-9a-f]{32}$/;
const ATTENTION: Record<string, true | undefined> = { idle: true, working: true, waiting: true, finished: true };

export type OfficePacket = {
  id: string;
  seq: number;
  at: number;
} & ({ kind: "snapshot"; name: string; snapshot: OfficeSnapshot } | { kind: "wave" | "leave" });

/** Bounded UTF-8, plain terminal text; neither ANSI nor bidi formatting survives. */
export function officeLabel(value: string, maxBytes: number): string {
  const text = cleanLabel(value.slice(0, 4096).toWellFormed().replace(/\p{Cf}/gu, ""));
  let bytes = 0;
  let result = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    result += character;
  }
  return result.trimEnd();
}

export function normalizeOfficeSnapshot(snapshot: OfficeSnapshot): OfficeSnapshot {
  return {
    title: officeLabel(snapshot.title, 160),
    tasks: snapshot.tasks.slice(0, 3).map(task => ({ text: officeLabel(task.text, 160), done: task.done === true })),
    attention: ATTENTION[snapshot.attention] === true ? snapshot.attention : "idle",
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLabel(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value === officeLabel(value, maxBytes);
}

/** Whitelist the wire schema instead of spreading arbitrary decoded properties. */
function parsePacket(value: unknown): OfficePacket | undefined {
  if (!record(value) || typeof value.id !== "string" || !ID.test(value.id)
    || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
    || !Number.isSafeInteger(value.at) || (value.at as number) < 0) return;
  const base = { id: value.id, seq: value.seq as number, at: value.at as number };
  if (value.kind === "wave" || value.kind === "leave") return { ...base, kind: value.kind };
  if (value.kind !== "snapshot" || !validLabel(value.name, 64) || !value.name || !record(value.snapshot)) return;
  const snapshot = value.snapshot;
  if (!validLabel(snapshot.title, 160) || !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 3
    || typeof snapshot.attention !== "string" || ATTENTION[snapshot.attention] !== true) return;
  const tasks: OfficeSnapshot["tasks"] = [];
  for (const task of snapshot.tasks) {
    if (!record(task) || !validLabel(task.text, 160) || typeof task.done !== "boolean") return;
    tasks.push({ text: task.text, done: task.done });
  }
  return { ...base, kind: "snapshot", name: value.name, snapshot: {
    title: snapshot.title, tasks, attention: snapshot.attention as OfficeSnapshot["attention"],
  } };
}

export function encodeOfficePacket(packet: OfficePacket, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("Invalid office encryption parameters");
  const nonce = randomBytes(12);
  const plain = Buffer.from(JSON.stringify(packet), "utf8");
  if (plain.length + HEADER_BYTES > OFFICE_MAX_PACKET) throw new Error("Office packet exceeds its size limit");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function decodeOfficePacket(data: Buffer, key: Buffer): OfficePacket | undefined {
  if (key.length !== 32 || data.length <= HEADER_BYTES || data.length > OFFICE_MAX_PACKET
    || !data.subarray(0, 4).equals(MAGIC)) return;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(4, 16));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(data.subarray(16, HEADER_BYTES));
    const plain = Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
    return parsePacket(JSON.parse(text));
  } catch {
    // Unauthenticated LAN traffic is expected; never expose its contents or key material.
    return;
  }
}

/** Tombstones outlive visible peers so leaving/expiring does not permit a replay. */
export class OfficeReplayWindow {
  private readonly sessions = new Map<string, { seq: number; until: number }>();

  accept(packet: OfficePacket, now: number): boolean {
    if (packet.at < now - OFFICE_FRESH_MS || packet.at > now + OFFICE_CLOCK_SKEW_MS) return false;
    for (const [id, seen] of this.sessions) if (seen.until < now) this.sessions.delete(id);
    const seen = this.sessions.get(packet.id);
    if (seen && packet.seq <= seen.seq) return false;
    if (!seen && this.sessions.size >= OFFICE_MAX_PEERS) return false;
    this.sessions.set(packet.id, { seq: packet.seq, until: Math.max(seen?.until ?? 0, packet.at + OFFICE_FRESH_MS) });
    return true;
  }
}
