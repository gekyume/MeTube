# MeTube

A two-lane YouTube for your iPhone: **Beats** and **Learn**. No YouTube search, no recommendations, no comments, no way out to YouTube.

- `docs/`: the phone app, a static web app you add to your home screen. Videos play in the youtube-nocookie embed with YouTube's controls hidden, and its title, logo, and end-screen links are covered.
- `curator/`: a daily job that fills `docs/videos.json`.
  - **Subscriptions** come from the channels in `curator/config.json`. They're read from YouTube's public RSS feeds, need no key, and skip Shorts.
  - **Discovery** (optional) searches your topics with the YouTube Data API. Claude then picks at most `maxNewPerDay` videos that match your `tasteProfile`. These show up with a **PICK** badge and a one-line reason.
- `.github/workflows/curate.yml`: runs the curator every day at 11:00 UTC and deploys to GitHub Pages.

## Setup (one time, about 10 minutes)

1. **Put it on GitHub.** Create a new repo on github.com (public, so Pages is free), then push this folder to it:
   ```bash
   git remote add origin https://github.com/<you>/metube.git && git push -u origin main
   ```
2. **Turn on Pages.** In the repo, go to Settings → Pages → Source and choose **GitHub Actions**.
3. **Run it once.** Go to Actions → "Curate and deploy" → Run workflow. When it finishes, your app is at `https://<you>.github.io/metube/`.
4. **On your iPhone,** open that URL in Safari, tap Share, then **Add to Home Screen**. From then on, open MeTube from the home screen icon. It runs full screen with no address bar.

### Optional: AI discovery
Add two secrets in Settings → Secrets and variables → Actions:
- `YOUTUBE_API_KEY`: in Google Cloud Console, create a project, enable "YouTube Data API v3", then go to Credentials and create an API key. The free quota is more than enough.
- `ANTHROPIC_API_KEY`: get one from console.anthropic.com. This costs cents per day.

Without these secrets, discovery is skipped and only your channels feed the app.

## Changing what's allowed in
Edit `curator/config.json` on github.com. The site redeploys automatically.
- `channels`: `@handles` or `UC…` channel IDs.
- `playlists`: playlist URLs or IDs. Good for a beat producer's "freestyle" playlist.
- `videos`: individual video URLs to pin.
- `learn.discovery.queries` and `tasteProfile`: what the curator hunts for, written in plain English.
- `maxNewPerRun` and `maxNewPerDay`: the scarcity dials.

The friction is deliberate. Adding a channel takes a laptop-ish edit, not a tap.

## Lockdown (this is what makes it stick)
On the iPhone, go to **Settings → Screen Time → Content & Privacy Restrictions**:
1. **Delete the YouTube app.** Then in App Store, Media, Web & Apps → **Installing Apps**, choose **Don't Allow**. You can flip this back briefly when you need other apps.
2. In App Store, Media, Web & Apps → **Web Content**, choose **Limit Adult Websites**. Under **Never Allow**, add `youtube.com`, `m.youtube.com`, and `youtu.be`.
   - Do **not** block `youtube-nocookie.com`, `googlevideo.com`, or `ytimg.com`. The player and thumbnails need them. The embed loads its code from youtube-nocookie.com and only uses youtube.com for its "watch on YouTube" links, so blocking youtube.com closes those links without breaking playback.
3. Set a **Screen Time passcode you don't know**. Have a friend type it in.

After step 2, open MeTube and play one Beat and one Learn video to confirm everything still works.

## Using it
- **Home:** Beats and Learn tabs. Beats opens on your **Liked** folder; Learn opens on **Browse**, which has shelves for Continue watching, New for you, and each topic (History, Science, Engineering & Tech, Society).
- **Watch page:** tap any video. The back arrow (or swipe back on iPhone, or Esc on a computer) returns you where you were. Tap the channel name for that channel's page, with Play all and Shuffle.
- **Mini player:** leave the watch page and the video keeps playing in a bar at the bottom. Tap it to return; ✕ closes it.
- The first video of a session: tap the video itself to start (iOS rule). After that, the buttons do everything.
- **Auto-next / Loop / Stop at end** is a button on the watch page; each tab remembers its own setting.
- **Not for me** on the watch page hides a video on this device. **♥** saves a beat to Liked.
- **Search** only looks through your MeTube library (titles, channels, topics), never all of YouTube.
- **Recent** lists what you've watched, newest first. Learn videos resume where you left off.
- **On a computer:** space plays or pauses, ←/→ skip 10s, `n` goes to the next video, `/` jumps to search.
- **Background / screen off (best effort):** iOS normally pauses web video when you leave the app or lock the screen. MeTube immediately asks the player to keep going. If it still pauses, press play on the lock screen or in Control Center's media player.
- **Topics:** edit `learn.topics` in `curator/config.json` to add a channel to a shelf, or to add a new shelf.

## Local dev
```bash
npm install && npm run curate && npm run serve
```
Then open http://localhost:8787.
