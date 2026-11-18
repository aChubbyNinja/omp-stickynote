import { randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import {
  decodeOfficePacket, encodeOfficePacket, normalizeOfficeSnapshot, officeLabel, OfficeReplayWindow,
  OFFICE_GROUP, OFFICE_PORT, OFFICE_HEARTBEAT_MS, OFFICE_MAX_PEERS, OFFICE_PEER_TTL_MS,
  type OfficePacket,
} from "./office-wire.ts";

export interface OfficeSnapshot {
  title: string;
  tasks: { text: string; done: boolean }[];
  attention: "idle" | "working" | "waiting" | "finished";
}

export interface OfficeSession {
  id: string;
  name: string;
  snapshot: OfficeSnapshot;
  self: boolean;
}

interface Peer {
  name: string;
  snapshot: OfficeSnapshot;
  seen: number;
}

interface Run {
  socket: Socket;
  key: Buffer;
  address: string;
  port: number;
  id: string;
  name: string;
  active: boolean;
  dirty: boolean;
  lastSnapshot: number;
  lastWave: number;
  replay: OfficeReplayWindow;
  peers: Map<string, Peer>;
  timer?: NodeJS.Timeout;
  ready: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function configuration(): { key: Buffer; address: string; port: number; name: string } {
  const secret = process.env.OMP_STICKY_OFFICE_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error("Office requires OMP_STICKY_OFFICE_KEY: generate 32 random bytes with `openssl rand -hex 32` and privately share that 64-hex key with intended peers. Never paste the key into chat.");
  }
  const address = process.env.OMP_STICKY_OFFICE_INTERFACE ?? "";
  const local = Object.values(networkInterfaces()).flat().some(entry => entry?.family === "IPv4" && entry.address === address);
  if (!isIPv4(address) || !local) {
    throw new Error("Office requires OMP_STICKY_OFFICE_INTERFACE set to an IPv4 address assigned to the intended local LAN interface (loopback is allowed for local testing).");
  }
  let port = OFFICE_PORT;
  const testPort = process.env.OMP_STICKY_OFFICE_TEST_PORT;
  if (testPort !== undefined) {
    if (!address.startsWith("127.") || !/^\d{4,5}$/.test(testPort) || Number(testPort) < 1024 || Number(testPort) > 65535) {
      throw new Error("OMP_STICKY_OFFICE_TEST_PORT is a loopback-only test override (1024–65535); unset it for LAN use.");
    }
    port = Number(testPort);
  }
  return { key: Buffer.from(secret, "hex"), address, port,
    name: officeLabel(process.env.OMP_STICKY_OFFICE_NAME ?? hostname(), 64) || "device" };
}

/**
 * Session-only, opt-in mission control. No discovery service, DNS, TCP, Internet
 * destination, unicast reply, prompt, working directory, or environment is sent.
 * All packets go to 239.255.77.80:47831, TTL 1, on the explicitly chosen IPv4
 * interface. Only approved snapshot fields and a sanitized device name travel.
 * A shared random key authenticates a trusted LAN group, not individual people.
 */
export class Office {
  private run?: Run;
  private readonly id = randomBytes(16).toString("hex");
  private readonly replay = new OfficeReplayWindow();
  private sequence = 0;
  private readonly onWave: () => void;
  private readonly onError: (message: string) => void;
  private snapshot: OfficeSnapshot = { title: "Ready to begin", tasks: [], attention: "idle" };

  constructor(onWave: () => void, onError: (message: string) => void) {
    this.onWave = onWave;
    this.onError = onError;
  }

  async start(): Promise<void> {
    if (this.run) return this.run.ready;
    const config = configuration();
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
    const run: Run = { ...config, socket, id: this.id,
      active: false, dirty: true, lastSnapshot: 0, lastWave: 0,
      replay: this.replay, peers: new Map(), ready, resolve, reject };
    this.run = run;
    socket.on("message", data => this.receive(run, data));
    socket.on("error", () => {
      if (this.run !== run) return;
      const active = run.active;
      this.dispose(run);
      if (active) this.onError("Office LAN transport failed; sharing has stopped. Check the selected interface and multicast permissions before enabling it again.");
      else run.reject(new Error("Office could not join the selected LAN multicast interface. Check the address, port availability, and multicast permissions."));
    });
    socket.once("listening", () => {
      if (this.run !== run) { this.closeSocket(socket); return; }
      try {
        socket.setMulticastInterface(run.address);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true); // separate sessions on the same machine are peers
        socket.addMembership(OFFICE_GROUP, run.address);
        socket.unref();
        run.active = true;
        this.sendSnapshot(run);
        if (this.run !== run) {
          run.reject(new Error("Office could not send its initial snapshot. Sharing is off."));
          return;
        }
        // Coalesce rapid title/task changes; at most one snapshot per second,
        // with a five-second heartbeat when the note has not changed.
        run.timer = setInterval(() => {
          if (this.run !== run) return;
          this.expire(run);
          if (run.dirty || Date.now() - run.lastSnapshot >= OFFICE_HEARTBEAT_MS) this.sendSnapshot(run);
        }, 1000);
        run.timer.unref();
        run.resolve();
      } catch {
        this.dispose(run);
        run.reject(new Error("Office could not configure multicast on the selected LAN interface. Sharing is off."));
      }
    });
    try {
      // Binding the multicast destination (rather than a wildcard) also keeps
      // unicast datagrams out. Membership and outbound routing select the LAN.
      socket.bind(run.port, OFFICE_GROUP);
    } catch {
      this.dispose(run);
      run.reject(new Error("Office could not bind its local multicast port. Sharing is off."));
    }
    return ready;
  }

  update(snapshot: OfficeSnapshot): void {
    this.snapshot = normalizeOfficeSnapshot(snapshot);
    if (this.run) this.run.dirty = true;
  }

  /** Explicit releases only. Receiving a wave never sends another wave. */
  release(): void {
    const run = this.run;
    if (!run?.active) return;
    const now = Date.now();
    if (now - run.lastWave < 1000) return;
    run.lastWave = now;
    this.send(run, { id: run.id, seq: ++this.sequence, at: now, kind: "wave" });
  }

  sessions(): readonly OfficeSession[] {
    const run = this.run;
    if (!run?.active) return [];
    this.expire(run);
    const sessions: OfficeSession[] = [{
      id: run.id, name: run.name, self: true,
      snapshot: { ...this.snapshot, tasks: this.snapshot.tasks.map(task => ({ ...task })) },
    }];
    for (const [id, peer] of run.peers) {
      sessions.push({
        id, name: peer.name, self: false,
        snapshot: { ...peer.snapshot, tasks: peer.snapshot.tasks.map(task => ({ ...task })) },
      });
    }
    return sessions;
  }

  stop(): void {
    const run = this.run;
    if (!run) return;
    if (!run.active) {
      run.reject(new Error("Office start cancelled; sharing is off."));
      this.dispose(run);
      return;
    }
    let leave: Buffer;
    try {
      leave = encodeOfficePacket({ id: run.id, seq: ++this.sequence, at: Date.now(), kind: "leave" }, run.key);
    } catch {
      this.dispose(run);
      return;
    }
    // Detach the generation and wipe its state immediately, but keep the
    // already-bound transport alive until its final encrypted datagram flushes.
    this.deactivate(run);
    try {
      run.socket.send(leave, run.port, OFFICE_GROUP, () => this.closeTransport(run));
    } catch {
      this.closeTransport(run);
    }
  }

  private sendSnapshot(run: Run): void {
    run.dirty = false;
    run.lastSnapshot = Date.now();
    this.send(run, { id: run.id, seq: ++this.sequence, at: run.lastSnapshot,
      kind: "snapshot", name: run.name, snapshot: this.snapshot });
  }

  private send(run: Run, packet: OfficePacket): void {
    if (this.run !== run || !run.active) return;
    try {
      const data = encodeOfficePacket(packet, run.key);
      run.socket.send(data, run.port, OFFICE_GROUP, error => {
        if (error && this.run === run) {
          this.dispose(run);
          this.onError("Office could not send on the selected LAN interface; sharing has stopped.");
        }
      });
    } catch {
      this.dispose(run);
      this.onError("Office could not send its bounded encrypted snapshot; sharing has stopped.");
    }
  }

  private receive(run: Run, data: Buffer): void {
    if (this.run !== run || !run.active) return;
    const packet = decodeOfficePacket(data, run.key);
    if (!packet || packet.id === run.id || !run.replay.accept(packet, Date.now())) return;
    this.expire(run);
    if (packet.kind === "snapshot") {
      if (!run.peers.has(packet.id) && run.peers.size >= OFFICE_MAX_PEERS) return;
      run.peers.set(packet.id, { name: packet.name, snapshot: packet.snapshot, seen: Date.now() });
    } else if (packet.kind === "leave") {
      run.peers.delete(packet.id);
    } else {
      this.onWave();
    }
  }

  private expire(run: Run): void {
    const cutoff = Date.now() - OFFICE_PEER_TTL_MS;
    for (const [id, peer] of run.peers) if (peer.seen < cutoff) run.peers.delete(id);
  }

  private dispose(run: Run): void {
    this.deactivate(run);
    this.closeTransport(run);
  }

  private deactivate(run: Run): void {
    if (this.run === run) this.run = undefined;
    run.active = false;
    clearInterval(run.timer);
    run.timer = undefined;
    run.peers.clear();
    run.key.fill(0);
  }

  private closeTransport(run: Run): void {
    try { run.socket.dropMembership(OFFICE_GROUP, run.address); } catch { /* not joined yet */ }
    this.closeSocket(run.socket);
  }

  private closeSocket(socket: Socket): void {
    try { socket.close(); } catch { /* already closed, or cancelled before binding */ }
  }
}
