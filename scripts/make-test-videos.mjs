// Generates short local test videos with ffmpeg (must be on PATH).
// Usage: npm run make-test-videos
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'test-media');
const srcDir = join(dir, 'src');
mkdirSync(srcDir, { recursive: true });

const images = {
  person: ['woman-with-afro_medium.jpg', 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/woman-with-afro_medium.jpg'],
  cats: ['cats.jpg', 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg'],
};
for (const [file, url] of Object.values(images)) {
  const path = join(srcDir, file);
  if (!existsSync(path)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${url}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
}

const ff = (...args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
const person = join(srcDir, images.person[0]);
const cats = join(srcDir, images.cats[0]);

// Slow pan/zoom over a still photo so every frame differs (gives motion for RVM).
const motion = (w, h, frames) =>
  `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='1.15+0.1*sin(on/15)':x='iw/2-(iw/zoom/2)+40*sin(on/10)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30,format=yuv420p`;
// Tone with a short louder beep at every whole second (useful for listening to sync).
const beeps = (seconds) => `sine=frequency=440:sample_rate=48000:duration=${seconds},volume='if(lt(mod(t,1),0.1),0.9,0.15)':eval=frame`;

console.log('person-audio.mp4 (1280x720, 6 s, H.264 + AAC)');
ff('-loop', '1', '-i', person, '-f', 'lavfi', '-i', beeps(6), '-vf', motion(1280, 720, 180), '-t', '6',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest', join(dir, 'person-audio.mp4'));

console.log('person-silent.mp4 (960x540, 4 s, no audio)');
ff('-loop', '1', '-i', person, '-vf', motion(960, 540, 120), '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-an',
  join(dir, 'person-silent.mp4'));

console.log('person-portrait-rotated.mp4 (stored 1280x720 + 90° rotation metadata, displays 720x1280)');
const portrait = join(dir, 'tmp-portrait.mp4');
ff('-loop', '1', '-i', person, '-f', 'lavfi', '-i', beeps(4), '-vf', motion(720, 1280, 120), '-t', '4',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-shortest', portrait);
// Store sideways pixels and add display rotation metadata, like a phone camera does.
ff('-i', portrait, '-vf', 'transpose=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', '-metadata:s:v:0', 'rotate=0',
  join(dir, 'tmp-sideways.mp4'));
ff('-display_rotation', '90', '-i', join(dir, 'tmp-sideways.mp4'), '-c', 'copy', join(dir, 'person-portrait-rotated.mp4'));

console.log('person-audio-offset.mp4 (audio starts 0.5 s after video)');
ff('-loop', '1', '-i', person, '-itsoffset', '0.5', '-f', 'lavfi', '-i', beeps(3), '-vf', motion(640, 360, 120), '-t', '4',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', join(dir, 'person-audio-offset.mp4'));

console.log('cats-audio.webm (VP9 + Opus, non-person subject)');
ff('-loop', '1', '-i', cats, '-f', 'lavfi', '-i', beeps(4), '-vf', motion(854, 480, 120), '-t', '4',
  '-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', join(dir, 'cats-audio.webm'));

console.log('too-long.mp4 (35 s)');
ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '35', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'too-long.mp4'));

console.log('unsupported-codec.avi (MPEG-4 Part 2 in AVI)');
ff('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '2', '-c:v', 'mpeg4', join(dir, 'unsupported-codec.avi'));

console.log('cats-1s.webm (first second of cats-audio.webm, for the slow BEN2 test)');
ff('-i', join(dir, 'cats-audio.webm'), '-t', '1', '-c', 'copy', join(dir, 'cats-1s.webm'));

console.log('Done. Files are in test-media/.');
