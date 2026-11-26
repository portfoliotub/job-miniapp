# html-to-video-render

Free render worker for the html-to-video Telegram bot.

The Cloudflare Worker (`html-to-video-bot`) takes HTML from Telegram and queues a render job. This repo's GitHub Action (cron, every 5 minutes) picks up queued jobs, renders them with headless Chrome + FFmpeg, and uploads the MP4 back to the Worker, which delivers it to the user.

## Output

- **1920x1080, 30 fps, H.264 MP4**, up to 5 seconds
- **Sound effects only** — no background music, no speech. If the job includes user audio it is used as the soundtrack; otherwise a default soft pop + chime is generated with FFmpeg.

## Files

- `convert.mjs` — HTML to MP4 converter (headless Chrome frame-by-frame + FFmpeg)
- `render-job.mjs` — picks one queued job, renders it, uploads the result
- `.github/workflows/render.yml` — cron every 5 minutes + manual dispatch

## Run locally

```bash
npm install
node render-job.mjs
```
