// case_report.pdf for an evidence pack: what was exported, from where, by
// whom and why, every file's SHA-256, how to verify the pack, and a DRAFT
// certificate under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 for
// the person in charge of the system to complete and sign. The software does
// not certify anything itself: the draft says so.
const PDFDocument = require('pdfkit');

const fmt = (d, tz) => new Date(d).toLocaleString('en-IN', {
  timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/**
 * @returns {Promise<Buffer>}
 */
function renderReport(r) {
  const tz = r.timeZone || 'Asia/Kolkata';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Evidence report ${r.exportId}`, Producer: 'Drishyam' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const h = (t) => { doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#111').text(t).moveDown(0.3); };
    const row = (k, v) => {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#444').text(`${k}: `, { continued: true })
        .font('Helvetica').fillColor('#111').text(String(v ?? '—'));
    };

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Evidence report');
    doc.font('Helvetica').fontSize(9).fillColor('#666').text(`Export ${r.exportId} · generated ${fmt(r.createdAt, tz)} (${tz})`);

    h('Export');
    row('Exported by', r.createdBy);
    row('Reason given', r.reason);
    row('Exported at', `${fmt(r.createdAt, tz)} (${tz}) · ${new Date(r.createdAt).toISOString()}`);

    h('Footage');
    row('Camera', `${r.camera.name || r.camera.monitorId} (id ${r.camera.monitorId})`);
    row('Recorder', r.camera.recorder || '—');
    row('From', `${fmt(r.range.start, tz)} (${tz}) · ${new Date(r.range.start).toISOString()}`);
    row('To', `${fmt(r.range.end, tz)} (${tz}) · ${new Date(r.range.end).toISOString()}`);
    row('Source', 'Replayed from the recorder (NVR) over RTSP at export time; "original" is a stream copy, not re-encoded.');
    row('Clock', r.clockNote || 'The recorder\'s clock offset was not measured for this export. Times are as recorded by the recorder; the timestamp burned into the picture is the evidence clock.');

    if (r.tracks?.length) {
      h('People this export is about (Smart Search)');
      doc.font('Helvetica').fontSize(9).fillColor('#444')
        .text('Search matches are leads, not identifications. Each was chosen by the person exporting.');
      for (const t of r.tracks) {
        row(`Track ${t.track_id}`, `${t.camera_name || t.camera_code || ''}, ${fmt(t.first_seen, tz)} – ${fmt(t.last_seen, tz)}`
          + (t.score != null ? ` · match ${Math.round(t.score * 100)}%` : ''));
      }
    }

    h('Files and SHA-256 hashes');
    for (const f of r.files) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(`${f.path}  (${f.size.toLocaleString('en-IN')} bytes)`);
      doc.font('Courier').fontSize(8).fillColor('#333').text(f.sha256);
    }
    doc.font('Helvetica').fontSize(8.5).fillColor('#444').moveDown(0.3)
      .text('manifest.json lists these hashes and is signed (Ed25519) in manifest.sig with the key in public_key.pem. '
        + `Signing key fingerprint (SHA-256): ${r.keyFingerprint}. README.txt in the pack says how to check it.`);
    row('Software', r.software);

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111')
      .text('Certificate under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#b00020').text('DRAFT — to be completed, checked and signed by the person in charge of the system. Not legal advice.');
    doc.moveDown(0.6).font('Helvetica').fontSize(10).fillColor('#111');
    const para = (t) => doc.text(t, { align: 'justify' }).moveDown(0.5);
    para('I, ______________________________ (name), ______________________________ (designation), being in charge of the '
      + 'video surveillance system described below and of the management of the relevant activities, state as follows:');
    para(`1. The electronic records in this evidence pack (export ${r.exportId}) were produced from the video surveillance system `
      + `comprising the recorder "${r.camera.recorder || '________'}" and the camera "${r.camera.name || r.camera.monitorId}", `
      + 'which was used regularly during the relevant period to record video of the area it covers, by a person having lawful control over its use.');
    para('2. During that period, information of the kind contained in these records was regularly fed into the system in the ordinary course of those activities.');
    para('3. Throughout the material part of that period the system was operating properly, or, if it was not, any such period did not affect the electronic records or their accuracy: ______________________________.');
    para('4. The records were exported from the system by the Drishyam software on the date stated above and are identified by the following SHA-256 hash values:');
    for (const f of r.files) doc.font('Courier').fontSize(8).text(`${f.path}: ${f.sha256}`);
    doc.font('Helvetica').fontSize(10).moveDown(0.5);
    para('5. The contents of this certificate are true to the best of my knowledge and belief.');
    doc.moveDown(1.5);
    doc.text('Signature: ______________________________          Date: ______________');
    doc.moveDown(0.8).text('Name: _________________________________          Place: _____________');
    doc.moveDown(0.8).text('Expert verification (Part B), where required: ______________________________');
    doc.end();
  });
}

function readme(r) {
  return `Drishyam evidence pack ${r.exportId}

Camera: ${r.camera.name || r.camera.monitorId}
From:   ${new Date(r.range.start).toISOString()}
To:     ${new Date(r.range.end).toISOString()}
Reason: ${r.reason}

WHAT IS IN HERE
  video/original.mp4   the recorder's own stream, copied without re-encoding
  video/h264.mp4       the same footage re-encoded to H.264 so any player opens it
  report/case_report.pdf  details, hashes, and a draft Section 63 certificate
  photos/              the Smart Search photos this export is about (if any)
  manifest.json        every file above with its SHA-256 and size
  manifest.sig         Ed25519 signature over manifest.json (base64)
  public_key.pem       the key to check the signature with

HOW TO CHECK IT
  1. Every file's hash must match manifest.json, for example:
       sha256sum video/original.mp4
  2. The signature must match the manifest:
       base64 -d manifest.sig > manifest.sig.bin
       openssl pkeyutl -verify -pubin -inkey public_key.pem -rawin -in manifest.json -sigfile manifest.sig.bin
     It prints "Signature Verified Successfully".
  3. Or upload the ZIP to Drishyam > Smart Search > Evidence > Verify a pack.
Any changed byte in any file makes one of these checks fail.

Signing key fingerprint (SHA-256 of the public key): ${r.keyFingerprint}
`;
}

module.exports = { renderReport, readme };
