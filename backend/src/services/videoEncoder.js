/**
 * videoEncoder — which H.264 encoder can this machine actually run?
 *
 * The live transcoder turns H.265 cameras into H.264 for browsers that can't
 * decode H.265. A hardware encoder does that at a fraction of the CPU, but
 * which one exists depends on the host: NVIDIA (NVENC), Intel or AMD on Linux
 * (VAAPI), Intel Quick Sync (QSV), AMD on Windows (AMF), or none at all.
 *
 * `ffmpeg -encoders` only says what ffmpeg was BUILT with, not whether the
 * hardware and driver are there: the backend image lists h264_nvenc on every
 * host. Picking from that list meant a host without an NVIDIA GPU (or a
 * container without GPU access) started every transcoder on NVENC, watched it
 * fail twice, and only then fell back to the CPU.
 *
 * So each candidate is TRIED: a short encode of a generated test clip, and the
 * first one that succeeds is used. libx264 (CPU) is the fallback everywhere.
 *
 * Pure apart from the injected `run` / `listDir`, so it is unit-tested without
 * ffmpeg or a GPU (test/videoEncoder.test.js).
 */

const SOFTWARE = Object.freeze({
  name: 'libx264',
  inputArgs: [],
  args: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'],
  hwUpload: null,
});

// Use the most universally-compatible args for each hardware encoder.
// Newer NVENC/QSV/AMF have richer options (-tune ll, -rc cbr, p1-p7 presets,
// -low_power, -usage lowlatency) but those break on older drivers/hardware
// with "-22 Invalid argument". The args below work on every generation we
// care about; we trade ~5% quality for not crashing.
// GOP/keyframe interval is NOT set here: buildFfmpegArgs owns it.
function hardwareCandidates({ vaapiDevice } = {}) {
  const list = [
    { name: 'h264_nvenc', inputArgs: [], args: ['-c:v', 'h264_nvenc', '-preset', 'fast', '-bf', '0'], hwUpload: null },
  ];
  // VAAPI (Intel/AMD graphics on Linux) encodes from GPU surfaces: the
  // decoded frames are converted to NV12 and uploaded at the end of the
  // filter chain, on the device given here.
  if (vaapiDevice) {
    list.push({
      name: 'h264_vaapi',
      inputArgs: ['-vaapi_device', vaapiDevice],
      args: ['-c:v', 'h264_vaapi', '-bf', '0'],
      hwUpload: 'format=nv12,hwupload',
    });
  }
  list.push(
    { name: 'h264_qsv', inputArgs: [], args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-bf', '0'], hwUpload: null },
    { name: 'h264_amf', inputArgs: [], args: ['-c:v', 'h264_amf', '-quality', 'speed', '-bf', '0'], hwUpload: null },
  );
  return list;
}

/**
 * The VAAPI device to use: TRANSCODER_VAAPI_DEVICE if set, else the first
 * /dev/dri render node. Null when none is visible (no /dev/dri in the
 * container: see docker-compose.vaapi.yml).
 */
function findVaapiDevice({ envDevice, listDir }) {
  if (envDevice) return envDevice;
  let names = [];
  try { names = listDir('/dev/dri') || []; } catch { return null; }
  const node = names.filter((n) => /^renderD\d+$/.test(n)).sort()[0];
  return node ? `/dev/dri/${node}` : null;
}

/** ffmpeg args for a ~0.4 s test encode of a generated clip, output discarded. */
function testEncodeArgs(enc) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...enc.inputArgs,
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-frames:v', '10',
    ...(enc.hwUpload ? ['-vf', enc.hwUpload] : ['-pix_fmt', 'yuv420p']),
    ...enc.args,
    '-f', 'null', '-',
  ];
}

/**
 * Pick the first encoder that passes a test encode.
 *
 * @param {object} o
 * @param {boolean} o.allowHw             TRANSCODER_ALLOW_HW: false → libx264 without trying
 * @param {(args: string[]) => Promise<boolean>} o.run   runs ffmpeg, true on exit 0
 * @param {string|null} [o.vaapiDevice]
 * @param {Set<string>} [o.skip]          encoders demoted at runtime
 * @param {(msg: string, meta?: object) => void} [o.log]
 * @returns {Promise<{name, inputArgs, args, hwUpload}>}
 */
async function selectEncoder({ allowHw, run, vaapiDevice = null, skip = new Set(), log = () => {} }) {
  if (!allowHw) return SOFTWARE;
  const rejected = [];
  for (const enc of hardwareCandidates({ vaapiDevice })) {
    if (skip.has(enc.name)) continue;
    let ok = false;
    try { ok = await run(testEncodeArgs(enc)); } catch { ok = false; }
    if (ok) {
      log('hardware encoder selected', { name: enc.name, ...(enc.name === 'h264_vaapi' ? { device: vaapiDevice } : {}), rejected });
      return enc;
    }
    rejected.push(enc.name);
  }
  log('no hardware encoder passed a test encode; using libx264', { rejected });
  return SOFTWARE;
}

/**
 * Accepts an encoder object, or the bare args array older callers passed, and
 * returns the encoder object.
 */
function asEncoder(encoder) {
  if (Array.isArray(encoder)) {
    const i = encoder.indexOf('-c:v');
    return { name: i >= 0 ? encoder[i + 1] : 'unknown', inputArgs: [], args: encoder, hwUpload: null };
  }
  return encoder || SOFTWARE;
}

module.exports = {
  SOFTWARE,
  hardwareCandidates,
  findVaapiDevice,
  testEncodeArgs,
  selectEncoder,
  asEncoder,
};
