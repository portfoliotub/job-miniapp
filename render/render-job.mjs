// Job runner: picks ONE queued job from the Cloudflare Worker, renders it
// at 1920x1080 with sound effects, and uploads the MP4 back.
// Runs on GitHub Actions (cron every 5 min) — free for public repos.
// Can also run locally for testing: node render-job.mjs
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const WORKER = process.env.WORKER_URL || 'https://html-to-video-bot.1ravixo.workers.dev';
// workers.dev blocks some non-browser user agents (e.g. Python urllib),
// so identify as a browser on every request.
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };

async function main() {
  const queueRes = await fetch(`${WORKER}/queue`, { headers: HEADERS });
  if (!queueRes.ok) throw new Error('queue fetch failed: ' + queueRes.status);
  const queue = await queueRes.json();
  const job = (queue.jobs || []).find((j) => j.status === 'queued');
  if (!job) {
    console.log('No queued jobs.');
    return;
  }
  console.log('Claiming job', job.id);
  const claim = await fetch(`${WORKER}/job/${job.id}/claim`, { method: 'POST', headers: HEADERS });
  if (!claim.ok) {
    console.log('Claim failed (already taken?):', claim.status);
    return;
  }
  const meta = await (await fetch(`${WORKER}/job/${job.id}`, { headers: HEADERS })).json();
  const duration = meta.duration || 5;

  const html = await (await fetch(`${WORKER}/job/${job.id}/html`, { headers: HEADERS })).text();
  fs.writeFileSync('job.html', html);

  // Sound: user-provided audio if the job has one, else built-in sound effects.
  let audioArg = [];
  const audioRes = await fetch(`${WORKER}/job/${job.id}/audio`, { headers: HEADERS });
  if (audioRes.ok) {
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length > 0) {
      fs.writeFileSync('job-audio.mp3', buf);
      audioArg = ['--audio', 'job-audio.mp3'];
      console.log('Using user-provided audio (' + buf.length + ' bytes)');
    }
  }
  if (audioArg.length === 0) {
    makeDefaultSfx(duration);
    audioArg = ['--audio', 'sfx.mp3'];
    console.log('Using default sound effects (no music, no speech)');
  }

  console.log(`Rendering ${duration}s at 1920x1080...`);
  const r = spawnSync('node', [
    'convert.mjs', '--input', 'job.html', '--output', 'job.mp4',
    '--duration', String(duration), '--fps', '30',
    '--width', '1920', '--height', '1080', ...audioArg,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('convert failed');

  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync('job.mp4')], { type: 'video/mp4' }), 'job.mp4');
  const up = await fetch(`${WORKER}/job/${job.id}/result`, { method: 'POST', body: form, headers: HEADERS });
  if (!up.ok) throw new Error('result upload failed: ' + up.status);
  const nt = await fetch(`${WORKER}/job/${job.id}/notify`, { method: 'POST', headers: HEADERS });
  console.log('Notified worker:', nt.status);
  console.log('Done:', job.id);
}

// Soft sound effects only: a gentle pop at the start and a soft chime near
// the end. No background music, no speech.
function makeDefaultSfx(duration) {
  const endDelay = Math.max(0, Math.round((duration - 0.6) * 1000));
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=0.25',
    '-f', 'lavfi', '-i', 'sine=frequency=780:duration=0.4',
    '-filter_complex',
    `[0]afade=t=in:st=0:d=0.02,afade=t=out:st=0.2:d=0.05,adelay=300:all=1[t1];[1]afade=t=in:st=0:d=0.02,afade=t=out:st=0.35:d=0.05,adelay=${endDelay}:all=1[t2];[t1][t2]amix=inputs=2:duration=longest,volume=0.5,apad,atrim=0:${duration}`,
    'sfx.mp3'], { stdio: 'inherit' });
}

main().catch((e) => { console.error(e); process.exit(1); });
