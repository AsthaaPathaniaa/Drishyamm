// ffmpeg output args that carry a camera's sound into anything a browser plays.
//
// Cameras and NVRs send G.711 (pcm_alaw / pcm_mulaw). MP4, HLS and MediaSource
// can't hold it, which is why playback, export and backfill used to drop audio
// with `-an` (so recordings had no sound). G.711 at 8 kHz mono costs next to
// nothing to re-encode, so re-encode it to AAC-LC instead.
//
//   • `0:a:0?`  a camera without a microphone just has no audio track; ffmpeg
//               does not fail on the missing stream.
//   • aresample=async=1  fills gaps in the NVR's audio with silence (and trims
//               overlaps), so the audio track stays continuous. MediaSource
//               only plays where EVERY track is buffered; a hole in the audio
//               would otherwise stall the picture.
//
// Callers must map video explicitly (`-map 0:v:0`): once one `-map` is given,
// ffmpeg selects only what is mapped.
const AAC_AUDIO_ARGS = Object.freeze([
  '-map', '0:a:0?',
  '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '64k',
  '-af', 'aresample=async=1',
]);

module.exports = { AAC_AUDIO_ARGS };
