#!/usr/bin/env node
// html-to-video — converts an HTML file (with CSS/JS animations) to MP4.
// Method: headless Chrome renders the page frame by frame (animations are
// paused and seeked to each frame's exact time), screenshots are piped to
// FFmpeg, which encodes them as H.264 MP4. No dropped frames, no screen
// recording — the output is pixel-perfect for the given time.
//
// Usage:
//   node convert.mjs --input page.html --output video.mp4 --duration 5 --fps 30
//   node convert.mjs --input page.html                       (output: page.mp4)
// Options:
//   --input     HTML file (required)
//   --output    MP4 path (default: same name as input, .mp4)
//   --duration  seconds (default: 5)
//   --fps       frames per second (default: 30)
//   --width     video width (default: 1280)
//   --height    video height (default: 720)
//   --wait      ms to wait after page load before rendering (default: 1000)
//   --audio     sound file to mix in (overrides auto sound effects)
//   --sfx       auto|off — scene-based sound effects (default: auto)
//
// Sound effects: by default the converter watches the page's animations and
// builds a matching soundtrack — a thud where something bounces, a whoosh
// where something moves fast, a pop where something appears, a sweep where
// a bar fills. No background music, no speech. Authors can force a sound
// with data-sfx="pop|whoosh|thud|ding|swish|sweep" on any element
// (optionally data-sfx-time="1.2" in seconds).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const input = opt('--input');
const duration = Number(opt('--duration', '5'));
const fps = Number(opt('--fps', '30'));
const width = Number(opt('--width', '1280'));
const height = Number(opt('--height', '720'));
const waitMs = Number(opt('--wait', '1000'));
const sfxMode = opt('--sfx', 'auto');
let audio = opt('--audio');
if (audio && !fs.existsSync(path.resolve(audio))) {
  console.error(`Audio file not found: ${audio}`);
  process.exit(2);
}

// ---- Scene-based sound effects -------------------------------------------
// Watch the page's animations and turn movements/events into sounds:
// bounce -> thud, fast move -> whoosh, appear/scale-in -> pop,
// rotate -> swish, bar fill -> rising sweep. Plus explicit
// data-sfx="..." attributes on any element. Returns [{t, type, dur}] with
// t in seconds. Runs in the page, where the animation data lives.
async function detectSfxEvents(page, duration) {
  const raw = await page.evaluate((durSec) => {
    const evs = [];
    const num = (s) => {
      const m = String(s ?? '').match(/-?[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    };
    const anims = document.getAnimations({ subtree: true });
    for (const a of anims) {
      let timing = null;
      try { timing = a.effect.getTiming(); } catch { continue; }
      if (!timing) continue;
      let cycleMs = typeof timing.duration === 'number' ? timing.duration : 1000;
      if (!cycleMs || cycleMs <= 0 || !Number.isFinite(cycleMs)) cycleMs = 1000;
      const delayMs = Math.max(0, timing.delay || 0);
      const iters = timing.iterations === Infinity ? Infinity : (timing.iterations || 1);
      let kfs = [];
      try { kfs = a.effect.getKeyframes(); } catch { continue; }
      if (!kfs.length) continue;
      const props = new Set();
      kfs.forEach((k) => Object.keys(k).forEach((p) => {
        if (!['offset', 'easing', 'composite'].includes(p)) props.add(p);
      }));
      const physical = ['transform', 'top', 'left', 'right', 'bottom', 'width', 'height', 'opacity', 'scale'].some((p) => props.has(p));
      if (!physical) continue;

      const pushCycle = (type, offsetFrac, spanSec) => {
        const cycles = iters === Infinity
          ? Math.max(1, Math.ceil((durSec * 1000 - delayMs) / cycleMs))
          : iters;
        for (let k = 0; k < cycles; k++) {
          const t = (delayMs + k * cycleMs + offsetFrac * cycleMs) / 1000;
          if (t >= 0 && t <= durSec) evs.push({ t, type, dur: spanSec });
        }
      };

      // Movement series for a property: [{offset, v}] sorted by offset.
      const series = (prop) => kfs.map((k) => {
        let v = null;
        if (prop === 'transform') {
          const t = k.transform || '';
          const m = t.match(/translate(?:3d|X|Y)?\(\s*(-?[\d.]+)px(?:\s*,\s*(-?[\d.]+)px)?/);
          if (m) v = parseFloat(m[2] ?? m[1]);
        } else {
          v = num(k[prop]);
        }
        return { offset: k.offset ?? 0, v };
      }).filter((p) => p.v !== null).sort((x, y) => x.offset - y.offset);

      // 1) Scale-in / fade-in -> pop at the start.
      const firstKf = kfs[0];
      const scaleIn = (firstKf.transform || '').match(/scale(?:3d|X|Y)?\(\s*(-?[\d.]+)/);
      const fadeIn = num(firstKf.opacity) === 0;
      if ((scaleIn && parseFloat(scaleIn[1]) < 0.5) || fadeIn) {
        pushCycle('pop', 0);
        continue;
      }
      // 2) Bounce: a movement property reverses direction at a middle
      //    keyframe (the impact point) -> thud there, every cycle.
      let bounced = false;
      for (const prop of ['transform', 'top', 'left']) {
        const s = series(prop);
        if (s.length < 3) continue;
        for (let i = 1; i < s.length - 1; i++) {
          const d1 = s[i].v - s[i - 1].v;
          const d2 = s[i + 1].v - s[i].v;
          if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2) && Math.abs(d1) >= 40) {
            pushCycle('thud', s[i].offset);
            bounced = true;
          }
        }
        if (bounced) break;
      }
      if (bounced) continue;
      // 3) Big move over 2 keyframes. Vertical (a fall / a bounce with
      //    "alternate"): the object lands at each cycle boundary -> thud.
      //    Horizontal: it sweeps across -> whoosh at each start.
      const xy = { x: 0, y: 0 };
      kfs.forEach((k) => {
        const t = k.transform || '';
        const tx = t.match(/translateX\(\s*(-?[\d.]+)px/) || t.match(/translate\(\s*(-?[\d.]+)px/);
        const ty = t.match(/translateY\(\s*(-?[\d.]+)px/) || t.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/);
        if (tx) xy.x = Math.max(xy.x, Math.abs(parseFloat(tx[1])));
        if (ty) xy.y = Math.max(xy.y, Math.abs(parseFloat(ty[2] ?? ty[1])));
      });
      const topS = series('top');
      const leftS = series('left');
      if (topS.length >= 2) xy.y = Math.max(xy.y, Math.abs(topS[topS.length - 1].v - topS[0].v));
      if (leftS.length >= 2) xy.x = Math.max(xy.x, Math.abs(leftS[leftS.length - 1].v - leftS[0].v));
      const maxMove = Math.max(xy.x, xy.y);
      if (maxMove >= 80) {
        if (xy.y >= xy.x) pushCycle('thud', 1);
        else pushCycle('whoosh', 0);
        continue;
      }
      // 4) Rotation -> swish at the start.
      if (kfs.some((k) => /rotate\(/.test(k.transform || ''))) { pushCycle('swish', 0); continue; }
      // 5) Bar fill (width/height 0 -> ~100%) -> rising sweep.
      for (const prop of ['width', 'height']) {
        const s = series(prop);
        if (s.length >= 2 && s[0].v === 0 && s[s.length - 1].v >= 90) {
          pushCycle('sweep', 0, Math.min(cycleMs / 1000, durSec));
          break;
        }
      }
      if (evs.length && evs[evs.length - 1].type === 'sweep') continue;
      // 6) Any other opacity change -> pop at the start.
      if (props.has('opacity')) pushCycle('pop', 0);
    }
    // Explicit author overrides: data-sfx="pop|whoosh|thud|ding|swish|sweep"
    // data-sfx-time="1.2" (seconds), data-sfx-dur for sweeps.
    document.querySelectorAll('[data-sfx]').forEach((el) => {
      const type = el.getAttribute('data-sfx');
      if (!['pop', 'whoosh', 'thud', 'ding', 'swish', 'sweep'].includes(type)) return;
      const t = parseFloat(el.getAttribute('data-sfx-time') || 'NaN');
      evs.push({
        t: Number.isFinite(t) ? t : 0,
        type,
        dur: parseFloat(el.getAttribute('data-sfx-dur') || '0') || undefined,
      });
    });
    return evs;
  }, duration);
  // Clean up: sort, keep inside the video, drop near-duplicates, cap count.
  raw.sort((a, b) => a.t - b.t);
  const events = [];
  for (const e of raw) {
    if (e.t < 0 || e.t > duration) continue;
    if (events.some((p) => p.type === e.type && Math.abs(p.t - e.t) < 0.1)) continue;
    events.push(e);
    if (events.length >= 24) break;
  }
  return events;
}

// Synthesize the soundtrack for the detected events with FFmpeg (all
// generated tones/noise — no music, no speech) and write it to outPath.
function buildSfxTrack(events, duration, outPath) {
  const inputs = [];
  const filters = [];
  const labels = [];
  events.forEach((e, i) => {
    const tMs = Math.round(e.t * 1000);
    const idx = inputs.length / 4;
    const L = `s${i}`;
    let src;
    let chain;
    switch (e.type) {
      case 'pop':
        src = `aevalsrc=sin(2*PI*750*t)*exp(-t*28):duration=0.16`;
        chain = `volume=0.6,adelay=${tMs}:all=1`;
        break;
      case 'thud':
        src = `aevalsrc=sin(2*PI*85*t)*exp(-t*22):duration=0.25`;
        chain = `volume=0.9,adelay=${tMs}:all=1`;
        break;
      case 'ding':
        src = `aevalsrc=(0.6*sin(2*PI*880*t)+0.4*sin(2*PI*1318*t))*exp(-t*6):duration=0.6`;
        chain = `volume=0.4,adelay=${tMs}:all=1`;
        break;
      case 'whoosh':
        src = `anoisesrc=duration=0.5:color=pink`;
        chain = `bandpass=f=700:width_type=h:width=1.2,afade=t=in:st=0:d=0.15,afade=t=out:st=0.3:d=0.2,volume=0.5,adelay=${tMs}:all=1`;
        break;
      case 'swish':
        src = `anoisesrc=duration=0.35:color=white`;
        chain = `highpass=f=1800,afade=t=in:st=0:d=0.08,afade=t=out:st=0.2:d=0.15,volume=0.4,adelay=${tMs}:all=1`;
        break;
      case 'sweep': {
        const d = Math.max(0.3, Math.min(e.dur || 1, duration - e.t));
        src = `aevalsrc=sin(2*PI*(280*t+320*t*t/${d.toFixed(2)})):duration=${d.toFixed(2)}`;
        chain = `volume=0.22,afade=t=in:st=0:d=0.1,afade=t=out:st=${Math.max(0, d - 0.15).toFixed(2)}:d=0.15,adelay=${tMs}:all=1`;
        break;
      }
      default:
        return;
    }
    inputs.push('-f', 'lavfi', '-i', src);
    filters.push(`[${idx}:a]${chain}[${L}]`);
    labels.push(`[${L}]`);
  });
  if (!labels.length) return null;
  const filter = `${filters.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0,volume=1,apad,atrim=0:${duration}`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-c:a', 'libmp3lame', '-q:a', '4', outPath], { stdio: 'pipe' });
  return outPath;
}

if (!input) {
  console.error('Usage: node convert.mjs --input page.html [--output video.mp4] [--duration 5] [--fps 30] [--width 1280] [--height 720]');
  process.exit(2);
}
const inputPath = path.resolve(input);
if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(2);
}
const output = path.resolve(opt('--output', inputPath.replace(/\.html?$/i, '') + '.mp4'));
const totalFrames = Math.max(1, Math.round(duration * fps));

// Load the file directly via file:// — this sandbox's Chromium has no
// network access, not even to localhost, so a local HTTP server won't work.
// Relative images, fonts and scripts still load fine over file://.
const fileUrl = 'file://' + inputPath;

const browser = await puppeteer.launch({
  headless: true,
  pipe: true, // this sandbox blocks the remote-debugging TCP port
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'],
});
let sfxPath = null;
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, waitMs));

  // Scene-based sound effects (unless the user supplied audio or disabled
  // them): detect what the animations do, synthesize matching sounds.
  if (!audio && sfxMode === 'auto') {
    try {
      const events = await detectSfxEvents(page, duration);
      if (events.length) {
        sfxPath = output + '.sfx.mp3';
        buildSfxTrack(events, duration, sfxPath);
        audio = sfxPath;
        console.log('Sound effects:', events.map((e) => `${e.type}@${e.t.toFixed(1)}s`).join(', '));
      } else {
        console.log('Sound effects: none detected in the scene');
      }
    } catch (err) {
      console.log('Sound effects: skipped (' + String(err.message || err).slice(0, 1500) + ')');
    }
  }

  // Freeze the page clock: pause every CSS / Web Animations API animation.
  const animCount = await page.evaluate(() => {
    const anims = document.getAnimations();
    anims.forEach((a) => a.pause());
    return anims.length;
  });
  console.log(`Animations found: ${animCount} — rendering ${totalFrames} frames (${duration}s @ ${fps}fps, ${width}x${height})`);

  const ffArgs = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  if (audio) ffArgs.push('-i', path.resolve(audio));
  ffArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium');
  if (audio) ffArgs.push('-c:a', 'aac', '-b:a', '128k');
  ffArgs.push('-movflags', '+faststart', output);
  const ffmpeg = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffmpegErr = '';
  ffmpeg.stderr.on('data', (d) => { ffmpegErr += d.toString(); });
  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}\n${ffmpegErr.slice(-2000)}`))));
  });

  for (let i = 0; i < totalFrames; i++) {
    const t = (i / fps) * 1000;
    await page.evaluate((ms) => {
      document.getAnimations().forEach((a) => { a.currentTime = ms; });
    }, t);
    const shot = await page.screenshot({ type: 'png' });
    if (!ffmpeg.stdin.write(shot)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if ((i + 1) % 30 === 0 || i === totalFrames - 1) {
      process.stdout.write(`\rFrame ${i + 1}/${totalFrames}`);
    }
  }
  console.log('');
  ffmpeg.stdin.end();
  await ffmpegDone;

  const sizeMB = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
  console.log(`Done: ${output} (${sizeMB} MB, ${duration}s, ${width}x${height}, ${fps}fps${audio ? ', with sound' : ''})`);
} finally {
  await browser.close();
  if (sfxPath) { try { fs.unlinkSync(sfxPath); } catch {} }
}
