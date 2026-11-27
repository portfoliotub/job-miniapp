# html-to-video-render

Free render worker for the html-to-video Telegram bot.

The Cloudflare Worker (`html-to-video-bot`) takes HTML from Telegram and queues a render job. This repo's GitHub Action (cron, every 5 minutes) picks up queued jobs, renders them with headless Chrome + FFmpeg, and uploads the MP4 back to the Worker, which delivers it to the user.

## Output

- **1920x1080, 30 fps, H.264 MP4**, up to 20 seconds
- **Sound effects matched to the scene** — no background music, no speech. The converter watches the page's animations and builds a soundtrack from what actually happens: a thud where something bounces or lands, a whoosh where something moves fast, a pop where something appears, a rising sweep where a bar fills. If the job includes user audio it is used as the soundtrack instead. HTML authors can force a sound with `data-sfx="pop|whoosh|thud|ding|swish|sweep"` on any element (optionally `data-sfx-time="1.2"` in seconds).

## Capture modes

`convert.mjs` picks the mode automatically (`--mode auto|seek|realtime` to override):

- **seek** — for CSS / Web Animations pages: animations are paused and scrubbed frame by frame. Pixel-perfect.
- **realtime** ("screen recording") — auto-selected for GSAP pages (`window.gsap`) and for any page with a continuous `requestAnimationFrame` or fast `setInterval` animation loop. Those animations run on the browser's real-time clock and cannot be scrubbed, so the page is recorded with a CDP screencast while it plays for exactly the video duration. Note: scene sound effects are not auto-detected for such pages (only `data-sfx` attributes work); use `--audio` or `data-sfx` for sound there.

## Files

- `convert.mjs` — HTML to MP4 converter (headless Chrome frame-by-frame + FFmpeg)
- `render-job.mjs` — picks one queued job, renders it, uploads the result
- `.github/workflows/render.yml` — cron every 5 minutes + manual dispatch

## Run locally

```bash
npm install
node render-job.mjs
```
