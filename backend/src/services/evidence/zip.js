// Minimal ZIP writer/reader for evidence packs. Stored entries only (no
// compression: the pack is mostly video, which doesn't compress), streamed to
// disk with a data descriptor, so a 30-minute clip never sits in memory. Each
// entry's SHA-256 is computed while it is written. Any unzip tool opens it.
//
// Limits: classic ZIP (no ZIP64), so each entry and the whole pack must stay
// under 4 GiB — a 30-minute clip is far below that.
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const LIMIT = 0xffffffff;
const LOCAL_SIG = 0x04034b50;
const DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const FLAGS = 0x0808;           // bit 3: sizes in data descriptor · bit 11: UTF-8 names

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor(outPath) {
    this.path = outPath;
    this.fd = fs.openSync(outPath, 'w');
    this.offset = 0;
    this.entries = [];
    this.when = dosTime(new Date());
  }

  _write(buf) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
    if (this.offset > LIMIT) throw new Error('evidence pack larger than 4 GiB');
  }

  _local(name) {
    const n = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(LOCAL_SIG, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(FLAGS, 6);
    h.writeUInt16LE(0, 8);                       // stored
    h.writeUInt16LE(this.when.time, 10);
    h.writeUInt16LE(this.when.date, 12);
    h.writeUInt16LE(n.length, 26);
    const at = this.offset;
    this._write(h);
    this._write(n);
    return at;
  }

  _finish(name, at, crc, size, sha256) {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(DESC_SIG, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(size, 8);
    d.writeUInt32LE(size, 12);
    this._write(d);
    this.entries.push({ name, at, crc: crc >>> 0, size, sha256 });
    return { path: name, size, sha256 };
  }

  /** Add a Buffer. Returns { path, size, sha256 }. */
  addBuffer(name, buf) {
    if (buf.length > LIMIT) throw new Error(`${name} larger than 4 GiB`);
    const at = this._local(name);
    this._write(buf);
    return this._finish(name, at, zlib.crc32(buf), buf.length,
      crypto.createHash('sha256').update(buf).digest('hex'));
  }

  /** Stream a file in. Returns { path, size, sha256 }. */
  async addFile(name, srcPath) {
    const at = this._local(name);
    let crc = 0;
    let size = 0;
    const hash = crypto.createHash('sha256');
    const fd = this.fd;
    const self = this;
    await pipeline(fs.createReadStream(srcPath, { highWaterMark: 1 << 20 }), new Transform({
      transform(chunk, _enc, cb) {
        try {
          crc = zlib.crc32(chunk, crc);
          size += chunk.length;
          hash.update(chunk);
          fs.writeSync(fd, chunk);
          self.offset += chunk.length;
          if (size > LIMIT || self.offset > LIMIT) throw new Error(`${name} makes the pack larger than 4 GiB`);
          cb();
        } catch (e) { cb(e); }
      },
    }));
    return this._finish(name, at, crc, size, hash.digest('hex'));
  }

  /** Write the central directory and close. Returns { size }. */
  close() {
    const start = this.offset;
    for (const e of this.entries) {
      const n = Buffer.from(e.name, 'utf8');
      const c = Buffer.alloc(46);
      c.writeUInt32LE(CENTRAL_SIG, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(FLAGS, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(this.when.time, 12);
      c.writeUInt16LE(this.when.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(n.length, 28);
      c.writeUInt32LE(e.at, 42);
      this._write(c);
      this._write(n);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIG, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this._write(end);
    fs.closeSync(this.fd);
    return { size: this.offset };
  }
}

/**
 * Read a stored-only ZIP's entries: [{ name, offset (of data), size, crc }].
 * Throws on anything that isn't a well-formed stored ZIP.
 */
function listEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let endAt = -1;
    for (let i = tailLen - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === END_SIG) { endAt = i; break; }
    if (endAt < 0) throw new Error('not a ZIP file');
    const count = tail.readUInt16LE(endAt + 10);
    const cdSize = tail.readUInt32LE(endAt + 12);
    const cdOff = tail.readUInt32LE(endAt + 16);
    if (cdOff + cdSize > size) throw new Error('ZIP central directory out of range');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (cd.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('ZIP central directory is damaged');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      p += 46 + nlen + xlen + clen;
      if (method !== 0 || csize !== usize) throw new Error(`${name}: compressed entries are not expected in an evidence pack`);
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, local);
      if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`${name}: local header is damaged`);
      const offset = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      out.push({ name, offset, size: usize, crc });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** SHA-256 (hex) of an entry's bytes, streamed. */
async function entrySha256(zipPath, entry) {
  const hash = crypto.createHash('sha256');
  if (entry.size === 0) return hash.digest('hex');
  await pipeline(
    fs.createReadStream(zipPath, { start: entry.offset, end: entry.offset + entry.size - 1, highWaterMark: 1 << 20 }),
    new Transform({ transform(c, _e, cb) { hash.update(c); cb(); } }),
  );
  return hash.digest('hex');
}

function readEntry(zipPath, entry, max = 1 << 20) {
  if (entry.size > max) throw new Error(`${entry.name} is unexpectedly large`);
  const buf = Buffer.alloc(entry.size);
  const fd = fs.openSync(zipPath, 'r');
  try { fs.readSync(fd, buf, 0, entry.size, entry.offset); } finally { fs.closeSync(fd); }
  return buf;
}

async function sha256File(p) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p, { highWaterMark: 1 << 20 }), new Transform({ transform(c, _e, cb) { hash.update(c); cb(); } }));
  return hash.digest('hex');
}

module.exports = { ZipWriter, listEntries, entrySha256, readEntry, sha256File };
