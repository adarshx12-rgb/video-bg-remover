// Compares an exported file against its source with ffprobe: stream layout, duration,
// per-frame video timestamps and audio start/duration. Usage:
//   node scripts/verify-output.mjs <source> <output> [--fps N] [--alpha]
import { execFileSync } from 'node:child_process';

const [source, output, ...flags] = process.argv.slice(2);
const expectFps = flags.includes('--fps') ? Number(flags[flags.indexOf('--fps') + 1]) : null;
const expectAlpha = flags.includes('--alpha');
const probe = (file, args) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file], { maxBuffer: 1 << 28 }).toString());

const streams = (f) => probe(f, ['-show_streams', '-show_format']);
const frameTimes = (f) =>
  probe(f, ['-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-read_intervals', '%+60']).frames.map((x) => Number(x.best_effort_timestamp_time));

const src = streams(source);
const out = streams(output);
const sv = src.streams.find((s) => s.codec_type === 'video');
const sa = src.streams.find((s) => s.codec_type === 'audio');
const ov = out.streams.find((s) => s.codec_type === 'video');
const oa = out.streams.find((s) => s.codec_type === 'audio');
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };

const dur = (f) => Number(f.format.duration);
check(Math.abs(dur(src) - dur(out)) < 0.1, `container duration ${dur(out).toFixed(3)}s vs source ${dur(src).toFixed(3)}s`);

const rot = (s) => (s.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation ?? 0;
const displaySize = (s) => (Math.abs(rot(s)) % 180 === 90 ? [s.height, s.width] : [s.width, s.height]);
const [sw, sh] = displaySize(sv);
const [ow, oh] = displaySize(ov);
check(rot(ov) === 0, `output has no rotation metadata (rotation baked into pixels): ${rot(ov)}`);
check(Math.abs(sw / sh - ow / oh) < 0.01, `aspect ratio ${ow}x${oh} (${(ow / oh).toFixed(4)}) vs source display ${sw}x${sh} (${(sw / sh).toFixed(4)})`);
check(Math.max(ow, oh) <= 1280 && ow <= sw && oh <= sh, `fits 1280 box and never upscales`);

const st = frameTimes(source);
const ot = frameTimes(output);
if (expectFps) {
  check(Math.abs(ot.length - Math.round(dur(src) * expectFps)) <= 1, `frame count ${ot.length} ≈ ${dur(src)}s × ${expectFps} fps`);
} else {
  check(st.length === ot.length, `frame count ${ot.length} vs source ${st.length}`);
  const maxDelta = Math.max(...st.map((t, i) => Math.abs(t - (ot[i] ?? Infinity))));
  check(maxDelta < 0.002, `per-frame timestamps match source (max delta ${(maxDelta * 1000).toFixed(2)} ms)`);
}

if (sa) {
  check(!!oa, `audio present (${oa?.codec_name ?? 'missing'}; source ${sa.codec_name})`);
  if (oa) {
    const sStart = Number(sa.start_time), oStart = Number(oa.start_time);
    check(Math.abs(sStart - oStart) < 0.03, `audio start ${oStart.toFixed(3)}s vs source ${sStart.toFixed(3)}s`);
    const vStartDelta = Math.abs((Number(sa.start_time) - Number(sv.start_time)) - (Number(oa.start_time) - Number(ov.start_time)));
    check(vStartDelta < 0.03, `audio/video relative offset preserved (delta ${(vStartDelta * 1000).toFixed(1)} ms)`);
    const sDur = Number(sa.duration || src.format.duration), oDur = Number(oa.duration || out.format.duration);
    check(Math.abs(sDur - oDur) < 0.1, `audio duration ${oDur.toFixed(3)}s vs source ${sDur.toFixed(3)}s`);
  }
} else {
  check(!oa, `no audio track in output for silent source`);
}

if (expectAlpha) {
  const alphaTag = ov.tags?.alpha_mode ?? ov.tags?.ALPHA_MODE;
  check(alphaTag === '1', `WebM alpha_mode tag = ${alphaTag}`);
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
