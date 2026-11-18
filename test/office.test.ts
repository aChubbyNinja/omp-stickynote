import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Office, type OfficeSnapshot } from "../src/office.ts";
import {
  decodeOfficePacket, encodeOfficePacket, normalizeOfficeSnapshot, officeLabel, OfficeReplayWindow,
  OFFICE_CLOCK_SKEW_MS, OFFICE_FRESH_MS, OFFICE_GROUP, OFFICE_MAX_PACKET, OFFICE_MAX_PEERS,
  OFFICE_PEER_TTL_MS, type OfficePacket,
} from "../src/office-wire.ts";

const KEY = Buffer.from("819e7ab352c9486305f78efbc8dba224d66e2874961d84356990ec73520fba18", "hex");
const SNAPSHOT: OfficeSnapshot = { title: "Ship mission control", tasks: [{ text: "Verify LAN", done: false }], attention: "working" };
const PACKET: OfficePacket = { id: "0a".repeat(16), seq: 1, at: 1_000_000,
  kind: "snapshot", name: "Build desk", snapshot: SNAPSHOT };

function encrypted(packet: OfficePacket): Buffer {
  return encodeOfficePacket(packet, KEY);
}

test("authenticated wire round trips with fresh random nonces and no plaintext labels", () => {
  const data = encrypted(PACKET);
  assert.deepEqual(decodeOfficePacket(data, KEY), PACKET);
  const second = encrypted(PACKET);
  assert.deepEqual(decodeOfficePacket(second, KEY), PACKET);
  assert.notDeepEqual(data.subarray(4, 16), second.subarray(4, 16));
  assert.equal(data.includes(Buffer.from(SNAPSHOT.title)), false);
  assert.equal(data.includes(Buffer.from("Build desk")), false);
  assert.equal(decodeOfficePacket(data, Buffer.alloc(32)), undefined);
  assert.notDeepEqual(encodeOfficePacket(PACKET, KEY), encodeOfficePacket(PACKET, KEY));
  for (const position of [0, 4, 16, 32, data.length - 1]) {
    const changed = Buffer.from(data);
    changed[position] ^= 1;
    assert.equal(decodeOfficePacket(changed, KEY), undefined);
  }
  assert.equal(decodeOfficePacket(data.subarray(0, 31), KEY), undefined);
  assert.equal(decodeOfficePacket(Buffer.alloc(OFFICE_MAX_PACKET + 1), KEY), undefined);
  assert.throws(() => encodeOfficePacket({ ...PACKET, kind: "snapshot", name: "desk", snapshot: { ...SNAPSHOT, title: "x".repeat(OFFICE_MAX_PACKET) } }, KEY));
});

test("only bounded typed terminal-safe snapshots decode", () => {
  const bad = [
    { ...PACKET, id: "not-an-id" }, { ...PACKET, seq: 0 }, { ...PACKET, seq: 1.5 },
    { ...PACKET, at: -1 }, { ...PACKET, kind: "complete" },
    { ...PACKET, name: "\x1b[31mDesk" }, { ...PACKET, name: "x".repeat(65) },
    { ...PACKET, snapshot: { ...SNAPSHOT, attention: "constructor" } },
    { ...PACKET, snapshot: { ...SNAPSHOT, title: "x".repeat(161) } },
    { ...PACKET, snapshot: { ...SNAPSHOT, tasks: Array(4).fill({ text: "x", done: false }) } },
    { ...PACKET, snapshot: { ...SNAPSHOT, tasks: [{ text: "bad", done: "yes" }] } },
  ];
  for (const packet of bad) assert.equal(decodeOfficePacket(encrypted(packet as OfficePacket), KEY), undefined);
  const withPrivateExtras = { ...PACKET, prompt: "private", cwd: "/private", settings: { key: "private" } };
  assert.deepEqual(decodeOfficePacket(encrypted(withPrivateExtras), KEY), PACKET);
  assert.equal(officeLabel("\x1b]8;;https://example.com\x07Desk\x1b]8;;\x07\n\u202e\x1b[31mLAN", 64), "Desk LAN");
  assert.equal(officeLabel("🙂".repeat(100), 9), "🙂🙂");
  assert.equal(officeLabel("x\ud800", 64), "x�");
  const normalized = normalizeOfficeSnapshot({ title: "🙂".repeat(1000), tasks: Array(100).fill({ text: "a".repeat(1000), done: true }), attention: "finished" });
  assert.equal(Buffer.byteLength(normalized.title), 160);
  assert.equal(normalized.tasks.length, 3);
  assert.equal(Buffer.byteLength(normalized.tasks[0].text), 160);
  assert.ok(encrypted({ ...PACKET, kind: "snapshot", name: "desk", snapshot: normalized }).length <= OFFICE_MAX_PACKET);
});

test("UTF-8 cutoffs stay normalized and decodable after truncating at whitespace", () => {
  const title = `${"a".repeat(159)} 🙂 tail`;
  const task = `${"b".repeat(159)} 🙂 tail`;
  const name = officeLabel(`${"c".repeat(63)} 🙂 tail`, 64);
  const snapshot = normalizeOfficeSnapshot({ title, tasks: [{ text: task, done: false }], attention: "working" });
  assert.equal(snapshot.title, "a".repeat(159));
  assert.equal(snapshot.tasks[0].text, "b".repeat(159));
  assert.equal(name, "c".repeat(63));
  assert.deepEqual(normalizeOfficeSnapshot(snapshot), snapshot);
  assert.equal(officeLabel("a \u200b b", 64), "a b");
  const packet: OfficePacket = { ...PACKET, kind: "snapshot", name, snapshot };
  assert.deepEqual(decodeOfficePacket(encrypted(packet), KEY), packet);
});

test("freshness and bounded tombstones reject duplicate, reordered, expired, and future waves", () => {
  const now = PACKET.at;
  const replay = new OfficeReplayWindow();
  const wave: OfficePacket = { id: PACKET.id, seq: 4, at: now, kind: "wave" };
  assert.equal(replay.accept(wave, now), true);
  assert.equal(replay.accept(wave, now), false);
  assert.equal(replay.accept({ ...wave, seq: 3 }, now), false);
  assert.equal(replay.accept({ ...wave, seq: 5 }, now), true);
  assert.equal(replay.accept({ ...wave, seq: 6, at: now - OFFICE_FRESH_MS - 1 }, now), false);
  assert.equal(replay.accept({ ...wave, seq: 6, at: now + OFFICE_CLOCK_SKEW_MS + 1 }, now), false);
  assert.equal(replay.accept(wave, now + OFFICE_PEER_TTL_MS + 1), false);
  assert.equal(replay.accept(wave, now + OFFICE_FRESH_MS + 1), false);
  assert.equal(replay.accept({ ...wave, seq: 6, at: now + OFFICE_FRESH_MS + 1 }, now + OFFICE_FRESH_MS + 1), true);

  const bounded = new OfficeReplayWindow();
  for (let i = 0; i < OFFICE_MAX_PEERS; i++) {
    assert.equal(bounded.accept({ ...wave, id: i.toString(16).padStart(32, "0") }, now), true);
  }
  const extra = { ...wave, id: "ff".repeat(16) };
  assert.equal(bounded.accept(extra, now), false);
  assert.equal(bounded.accept({ ...extra, at: now + OFFICE_FRESH_MS + 1 }, now + OFFICE_FRESH_MS + 1), true);
});

const ENV_KEYS = ["OMP_STICKY_OFFICE_KEY", "OMP_STICKY_OFFICE_INTERFACE", "OMP_STICKY_OFFICE_TEST_PORT", "OMP_STICKY_OFFICE_NAME"] as const;

function environment(): () => void {
  const saved = ENV_KEYS.map(key => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("office stays inert until explicit start and reports setup without secrets", async () => {
  const restore = environment();
  const errors: string[] = [];
  const office = new Office(() => assert.fail("no wave while off"), message => errors.push(message));
  try {
    office.update(SNAPSHOT);
    office.release();
    office.stop();
    office.stop();
    assert.deepEqual(office.sessions(), []);
    await assert.rejects(office.start(), /OMP_STICKY_OFFICE_KEY.*32 random bytes/);
    process.env.OMP_STICKY_OFFICE_KEY = KEY.toString("hex");
    await assert.rejects(office.start(), error => error instanceof Error && /OMP_STICKY_OFFICE_INTERFACE/.test(error.message) && !error.message.includes(KEY.toString("hex")));
    process.env.OMP_STICKY_OFFICE_INTERFACE = "example.com";
    await assert.rejects(office.start(), /IPv4/);
    process.env.OMP_STICKY_OFFICE_INTERFACE = "192.0.2.123";
    await assert.rejects(office.start(), /intended local LAN interface/);
    process.env.OMP_STICKY_OFFICE_INTERFACE = "127.0.0.1";
    process.env.OMP_STICKY_OFFICE_TEST_PORT = "80";
    await assert.rejects(office.start(), /loopback-only test override/);
    assert.deepEqual(errors, []);
  } finally {
    office.stop();
    restore();
  }
});

async function freePort(): Promise<number> {
  const socket = createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  const closed = once(socket, "close");
  socket.close();
  await closed;
  return address.port;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 4000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "timed out waiting for loopback multicast");
    await delay(20);
  }
}

async function transmit(socket: Socket, packet: OfficePacket, port: number, key = KEY, destination = OFFICE_GROUP): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.send(encodeOfficePacket(packet, key), port, destination, error => error ? reject(error) : resolve());
  return promise;
}

// This test uses only 239.255.77.80 on 127.0.0.1, TTL 1, a fresh local
// test port, and the fixed non-production key above. No LAN interface is used.
test("two loopback sessions share structured snapshots, one-time waves, clean leave and restart", async t => {
  const port = await freePort();
  const restore = environment();
  process.env.OMP_STICKY_OFFICE_KEY = KEY.toString("hex");
  process.env.OMP_STICKY_OFFICE_INTERFACE = "127.0.0.1";
  process.env.OMP_STICKY_OFFICE_TEST_PORT = String(port);
  const errors: string[] = [];
  let aWaves = 0;
  let bWaves = 0;
  const a = new Office(() => aWaves++, message => errors.push(message));
  const b = new Office(() => bWaves++, message => errors.push(message));
  const sender = createSocket("udp4");
  try {
    process.env.OMP_STICKY_OFFICE_NAME = "\x1b[31mSame desk\x1b[0m\u202e";
    a.update(SNAPSHOT);
    await a.start();
    await a.start(); // idempotent, without another session/socket
    b.update({ title: "\x1b[31mSecond session\x1b[0m", tasks: [{ text: "\u202eReview\n", done: false }], attention: "waiting" });
    await b.start();
    a.update({ ...SNAPSHOT, tasks: [{ text: "Verified", done: true }], attention: "finished" });
    await eventually(() => a.sessions().some(session => !session.self) && b.sessions().some(session => !session.self));
    assert.deepEqual(b.sessions().find(session => !session.self)?.snapshot, {
      title: SNAPSHOT.title, tasks: [{ text: "Verified", done: true }], attention: "finished",
    });
    assert.deepEqual(a.sessions().find(session => !session.self)?.snapshot, {
      title: "Second session", tasks: [{ text: "Review", done: false }], attention: "waiting",
    });
    assert.equal(aWaves + bWaves, 0, "completing tasks must not emit waves");
    const sessions = b.sessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter(session => session.self).length, 1);
    assert.ok(sessions.every(session => session.name === "Same desk" && /^[0-9a-f]{32}$/.test(session.id)));
    assert.equal(JSON.stringify(sessions).includes(KEY.toString("hex")), false);
    assert.equal(JSON.stringify(sessions).includes("\\u001b"), false);
    assert.equal(new Set(sessions.map(session => session.id)).size, 2, "same-host sessions have distinct identifiers");
    // UI consumers cannot mutate the note subsequently shared on the wire.
    sessions[0].snapshot.tasks[0].text = "changed by caller";
    assert.equal(b.sessions()[0].snapshot.tasks[0].text, "Review");

    a.release();
    a.release(); // explicit duplicate release within the one-second limit
    await eventually(() => bWaves === 1);
    await delay(50);
    assert.equal(aWaves, 0, "sender must ignore its multicast loopback");
    assert.equal(bWaves, 1, "receiving a wave must not rebroadcast it");

    sender.bind(0, "127.0.0.1");
    await once(sender, "listening");
    sender.setMulticastInterface("127.0.0.1");
    sender.setMulticastTTL(1);
    sender.setMulticastLoopback(true);
    const wave: OfficePacket = { id: "cd".repeat(16), seq: 1, at: Date.now(), kind: "wave" };
    await transmit(sender, wave, port, Buffer.alloc(32)); // unrelated office key
    await transmit(sender, { ...wave, at: Date.now() - OFFICE_FRESH_MS - 1000 }, port);
    await transmit(sender, { ...wave, id: "ef".repeat(16) }, port, KEY, "127.0.0.1");
    await delay(50);
    assert.equal(aWaves, 0, "wrong keys, stale packets, and unicast must not trigger waves");
    assert.equal(bWaves, 1);
    await transmit(sender, wave, port);
    await transmit(sender, wave, port);
    await eventually(() => aWaves === 1 && bWaves === 2);
    await delay(50);
    assert.equal(aWaves, 1);
    assert.equal(bWaves, 2);

    const clock = t.mock.method(Date, "now", () => wave.at + OFFICE_PEER_TTL_MS + 1);
    assert.equal(b.sessions().some(session => !session.self), false, "missing heartbeats expire visible peers");
    clock.mock.restore();
    a.update(SNAPSHOT);
    await eventually(() => b.sessions().some(session => !session.self));
    a.stop();
    a.stop();
    assert.deepEqual(a.sessions(), [], "local sharing stops before the leave send finishes");
    a.release();
    await eventually(() => b.sessions().every(session => session.self));
    assert.equal(aWaves, 1);
    assert.equal(bWaves, 2, "stopping a session cannot emit another wave");
    await a.start();
    await eventually(() => b.sessions().some(session => !session.self));
    assert.deepEqual(errors, []);

    // Cancel an asynchronous bind, then immediately start a fresh generation.
    a.stop();
    const cancelled = a.start();
    const rejected = assert.rejects(cancelled, /cancelled/);
    a.stop();
    await a.start();
    await rejected;
    a.update({ ...SNAPSHOT, title: "Restarted" });
    await eventually(() => b.sessions().some(session => !session.self && session.snapshot.title === "Restarted"));
    await transmit(sender, wave, port);
    await delay(50);
    assert.equal(aWaves, 1, "restart must retain replay tombstones");
    assert.equal(bWaves, 2);
    assert.deepEqual(errors, []);
  } finally {
    a.stop();
    b.stop();
    try { sender.close(); } catch { /* test can fail before sender binds */ }
    restore();
  }
});
