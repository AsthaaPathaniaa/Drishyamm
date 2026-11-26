// H.264 encode arguments for one-off jobs (Recordings › Export as MP4, the
// evidence pack's H.264 copy): the hardware encoder the transcoder already
// probed (NVENC on an NVIDIA host, else VAAPI/QSV/AMF), libx264 only when none
// passed its test encode. With NVENC the decode runs on the GPU too.
const logger = require('../config/logger');

const CPU = { name: 'libx264', input: [], video: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] };

async function h264Encode() {
  try {
    const { encoder } = await require('./transcoder.service')._internals.detectEncoder();
    if (!encoder || encoder.name === 'libx264') return CPU;
    const input = [...(encoder.inputArgs || [])];
    if (encoder.name === 'h264_nvenc') input.push('-hwaccel', 'cuda');
    const video = [...encoder.args];
    if (encoder.hwUpload) video.unshift('-vf', encoder.hwUpload);
    else video.push('-pix_fmt', 'yuv420p');
    return { name: encoder.name, input, video };
  } catch (e) {
    logger.warn('h264 encode: encoder probe failed, using libx264', { error: e.message });
    return CPU;
  }
}

module.exports = { h264Encode, CPU };
