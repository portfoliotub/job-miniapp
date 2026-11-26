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

  // Sound: user-provided audio if the job has one. Otherwise convert.mjs
  // builds sound effects from the scene itself (thuds, whooshes, pops —
  // matched to the movements and events in the animation). No music, no speech.
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
  if (audioArg.length === 0) console.log('No user audio — using scene-based sound effects');

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

main().catch((e) => { console.error(e); process.exit(1); });
