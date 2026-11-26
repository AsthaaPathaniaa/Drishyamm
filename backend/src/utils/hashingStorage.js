// multer storage engine that writes the upload to disk and computes its
// SHA-256 and size in the same pass (forensic rule 12: hash at write time,
// before anything else reads the file). file.sha256 / file.size / file.path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

function hashingStorage({ destination }) {
  return {
    _handleFile(req, file, cb) {
      let dest;
      try {
        dest = destination(req, file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
      } catch (e) {
        cb(e);
        return;
      }
      const hash = crypto.createHash('sha256');
      let size = 0;
      pipeline(
        file.stream,
        new Transform({ transform(chunk, _enc, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } }),
        fs.createWriteStream(dest, { flags: 'wx' }),
      ).then(() => cb(null, { path: dest, size, sha256: hash.digest('hex') }))
        .catch((e) => { fs.rm(dest, { force: true }, () => {}); cb(e); });
    },
    _removeFile(_req, file, cb) {
      fs.rm(file.path, { force: true }, cb);
    },
  };
}

module.exports = { hashingStorage };
