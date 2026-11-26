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

import { spawn } from 'node:child_process';
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
const audio = opt('--audio');
if (audio && !fs.existsSync(path.resolve(audio))) {
  console.error(`Audio file not found: ${audio}`);
  process.exit(2);
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
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, waitMs));

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
  console.log(`Done: ${output} (${sizeMB} MB, ${duration}s, ${width}x${height}, ${fps}fps)`);
} finally {
  await browser.close();
}
