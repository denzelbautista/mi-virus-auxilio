import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const token = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codes (
        id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, hint TEXT NOT NULL, label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('room','limited','full')), expires_at INTEGER NOT NULL,
        max_rooms INTEGER, room_id TEXT, room_code TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS code_rooms (
        code_id TEXT NOT NULL REFERENCES codes(id), room_id TEXT NOT NULL, room_code TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(code_id,room_id)
      );
      CREATE TABLE IF NOT EXISTS access_sessions (
        token_hash TEXT PRIMARY KEY, code_id TEXT NOT NULL REFERENCES codes(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_secrets (code_id TEXT PRIMARY KEY REFERENCES codes(id), encrypted TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS code_aliases (secret_hash TEXT PRIMARY KEY, code_id TEXT NOT NULL REFERENCES codes(id));
      CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, room_code TEXT NOT NULL, room_name TEXT NOT NULL,
        number INTEGER NOT NULL, practice INTEGER NOT NULL, players TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER, result TEXT,
        winner_id TEXT, winner_name TEXT, rounds INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS matches_started ON matches(started_at DESC);
    `);
    const keyFile = resolve(dirname(file), 'access-code.key');
    if (!existsSync(keyFile)) {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM code_secrets').get().n) throw new Error('Falta access-code.key. Restaura la clave junto con la base de datos.');
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(keyFile, 0o600); this.secretKey = readFileSync(keyFile);
    if (this.secretKey.length !== 32) throw new Error('access-code.key no es válida. Restaura la clave original.');
    const savedCodes = resolve(dirname(file), 'accesos-locales.txt');
    if (existsSync(savedCodes)) this.importSecrets(readFileSync(savedCodes, 'utf8'));
  }
  encrypt(id, secret) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secretKey, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
  }
  decrypt(id, value) {
    const [iv, tag, encrypted] = value.split('.').map(s => Buffer.from(s, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', this.secretKey, iv); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
  }
  importSecrets(text) {
    for (const secret of new Set(text.match(/VIR-(?:[A-F0-9]{6}-){3}[A-F0-9]{6}/g) || [])) {
      const code = this.db.prepare('SELECT id FROM codes WHERE secret_hash=?').get(hash(secret));
      if (code) this.db.prepare('INSERT OR IGNORE INTO code_secrets VALUES (?,?)').run(code.id, this.encrypt(code.id, secret));
    }
  }
  issue({ kind, label, expiresAt, maxRooms = null, roomId = null, roomCode = null }) {
    const secret = `VIR-${randomBytes(12).toString('hex').toUpperCase().match(/.{6}/g).join('-')}`;
    const id = token();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO codes VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(id, hash(secret), secret.slice(-6), label, kind, expiresAt, maxRooms, roomId, roomCode, Date.now());
      this.db.prepare('INSERT INTO code_secrets VALUES (?,?)').run(id, this.encrypt(id, secret));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { id, code: secret, kind, label, expiresAt, maxRooms, roomCode };
  }
  redeem(secret) {
    if (typeof secret !== 'string' || secret.length > 100) throw new Error('Código de acceso inválido.');
    const code = this.db.prepare('SELECT * FROM codes WHERE secret_hash=? OR id IN (SELECT code_id FROM code_aliases WHERE secret_hash=?)').get(...Array(2).fill(hash(secret.trim().toUpperCase())));
    this.valid(code);
    const session = token();
    this.db.prepare('INSERT INTO access_sessions VALUES (?,?,?)').run(hash(session), code.id, Date.now());
    return { token: session, access: this.view(code) };
  }
  valid(code) {
    if (!code) throw new Error('Ingresa un código de acceso válido.');
    if (code.revoked_at) throw new Error('Este código fue revocado.');
    if (code.expires_at <= Date.now()) throw new Error('Este código de acceso ha vencido.');
    return code;
  }
  access(session) {
    if (typeof session !== 'string' || session.length > 100) throw new Error('Ingresa tu código de acceso para continuar.');
    const code = this.db.prepare('SELECT c.* FROM codes c JOIN access_sessions s ON s.code_id=c.id WHERE s.token_hash=?').get(hash(session));
    return this.valid(code);
  }
  byId(id) { return this.valid(this.db.prepare('SELECT * FROM codes WHERE id=?').get(id)); }
  view(code) {
    return { kind: code.kind, label: code.label, expiresAt: code.expires_at, maxRooms: code.max_rooms,
      roomCode: code.room_code, rooms: this.db.prepare('SELECT room_code AS code FROM code_rooms WHERE code_id=? ORDER BY created_at').all(code.id).map(r => r.code) };
  }
  // The distinct-room quota belongs to the code, across every device and redemption.
  bind(code, room) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.byId(code.id);
      if (code.kind === 'room' && code.room_id !== room.id) throw new Error('Este acceso pertenece a otra sala.');
      const exists = this.db.prepare('SELECT 1 FROM code_rooms WHERE code_id=? AND room_id=?').get(code.id, room.id);
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM code_rooms WHERE code_id=?').get(code.id).n;
      if (!exists && code.max_rooms !== null && used >= code.max_rooms) throw new Error('Este código ya alcanzó su límite de salas distintas.');
      this.db.prepare('INSERT OR IGNORE INTO code_rooms VALUES (?,?,?,?)').run(code.id, room.id, room.code, Date.now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  codes() {
    return this.db.prepare(`SELECT c.id,c.hint,c.label,c.kind,c.expires_at AS expiresAt,c.max_rooms AS maxRooms,
      c.room_code AS roomCode,c.room_id AS roomId,c.created_at AS createdAt,c.revoked_at AS revokedAt,
      EXISTS(SELECT 1 FROM code_secrets s WHERE s.code_id=c.id) AS canReveal,
      (SELECT json_group_array(room_id) FROM code_rooms b WHERE b.code_id=c.id) AS roomIds,
      (SELECT COUNT(*) FROM code_rooms b WHERE b.code_id=c.id) AS usedRooms FROM codes c ORDER BY c.created_at DESC`).all().map(c => ({ ...c, roomIds: JSON.parse(c.roomIds) }));
  }
  reveal(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some(id => typeof id !== 'string' || id.length > 100)) throw new Error('Selecciona de uno a ocho códigos válidos.');
    return [...new Set(ids)].map(id => {
      const c = this.byId(id), saved = this.db.prepare('SELECT encrypted FROM code_secrets WHERE code_id=?').get(id);
      return { id, label: c.label, kind: c.kind, roomCode: c.room_code, expiresAt: c.expires_at,
        code: saved ? this.decrypt(id, saved.encrypted) : null };
    });
  }
  recoverSecret(id) {
    const c = this.byId(id);
    if (this.db.prepare('SELECT 1 FROM code_secrets WHERE code_id=?').get(id)) return this.reveal([id])[0];
    // Legacy hashes are irreversible. An alias shares the SAME entitlement ID,
    // so the original, active sessions and all accumulated quotas stay valid.
    const secret = `VIR-${randomBytes(12).toString('hex').toUpperCase().match(/.{6}/g).join('-')}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO code_aliases VALUES (?,?)').run(hash(secret), id);
      this.db.prepare('INSERT INTO code_secrets VALUES (?,?)').run(id, this.encrypt(id, secret));
      this.db.prepare('UPDATE codes SET hint=? WHERE id=?').run(secret.slice(-6), id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { id, code: secret, label: c.label, kind: c.kind, roomCode: c.room_code, expiresAt: c.expires_at };
  }
  revoke(id) { if (!this.db.prepare('UPDATE codes SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), id).changes) throw new Error('Código no encontrado o ya revocado.'); }
  revokeRoom(id) {
    if (typeof id !== 'string' || !id.length || id.length > 100) throw new Error('Selecciona un acceso individual de la sala.');
    const c = this.db.prepare("SELECT room_id FROM codes WHERE id=? AND kind='room'").get(id);
    if (!c?.room_id) throw new Error('Este acceso no pertenece a una sala con cupos individuales.');
    const result = this.db.prepare("UPDATE codes SET revoked_at=? WHERE kind='room' AND room_id=? AND revoked_at IS NULL").run(Date.now(), c.room_id);
    if (!result.changes) throw new Error('Los accesos de esta sala ya fueron revocados.');
    return result.changes;
  }
  adminSession() {
    const value = token(), expires = Date.now() + 12 * 3600_000;
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO admin_sessions VALUES (?,?)').run(hash(value), expires);
    return value;
  }
  isAdmin(value) { return typeof value === 'string' && !!this.db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(hash(value), Date.now()); }
  logout(value) { if (typeof value === 'string') this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash(value)); }
  startMatch(room) {
    this.db.prepare('INSERT INTO matches (id,room_id,room_code,room_name,number,practice,players,started_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(room.matchId, room.id, room.code, room.name, room.matchNumber, Number(!!room.practice), JSON.stringify(room.game.players.map(p => ({ id: p.id, name: p.name, bot: !!p.bot }))), room.startedAt);
  }
  endMatch(room, result = 'interrupted') {
    if (!room.matchId) return;
    const winner = room.game?.players.find(p => p.id === room.game.winnerId), now = Date.now();
    this.db.prepare('UPDATE matches SET ended_at=?,duration_ms=MAX(0,?-started_at),result=?,winner_id=?,winner_name=?,rounds=? WHERE id=? AND ended_at IS NULL')
      .run(now, now, result, winner?.id || null, winner?.name || null, room.game?.round || 1, room.matchId);
  }
  recover(rooms) {
    const ids = new Set();
    for (const r of rooms.values()) if (r.game) {
      // Legacy saves have no reliable start/end timestamps. Track ongoing games
      // from this upgrade onward; do not invent durations for old completed games.
      if (r.status !== 'playing' && !r.matchId) continue;
      r.matchId ||= token(); r.matchNumber ||= 1; r.startedAt ||= Date.now();
      this.startMatch(r); ids.add(r.matchId);
      if (r.status !== 'playing') this.endMatch(r, r.game.winnerReason || (r.game.winnerId ? 'victory' : 'abandoned'));
    }
    for (const m of this.db.prepare('SELECT id FROM matches WHERE ended_at IS NULL').all()) if (!ids.has(m.id)) this.db.prepare("UPDATE matches SET ended_at=?,duration_ms=MAX(0,?-started_at),result='interrupted' WHERE id=?").run(Date.now(), Date.now(), m.id);
  }
  history(limit = 50, offset = 0) {
    return this.db.prepare('SELECT id,room_code AS roomCode,room_name AS roomName,number,practice,players,started_at AS startedAt,ended_at AS endedAt,duration_ms AS durationMs,result,winner_name AS winnerName,rounds FROM matches WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset).map(m => ({ ...m, players: JSON.parse(m.players) }));
  }
  summary() {
    return this.db.prepare('SELECT COUNT(*) AS completed,COALESCE(AVG(duration_ms),0) AS averageDurationMs FROM matches WHERE ended_at IS NOT NULL').get();
  }
  close() { this.db.close(); }
}
