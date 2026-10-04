// MeTube curator: builds docs/videos.json from whitelisted channels + optional AI discovery.
// Runs daily in GitHub Actions. No keys needed for channel feeds; discovery needs
// YOUTUBE_API_KEY and ANTHROPIC_API_KEY.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "curator/config.json");
const STATE_PATH = path.join(ROOT, "curator/state.json");
const OUT_PATH = path.join(ROOT, "docs/videos.json");
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) MeTubeCurator/1.0", "Accept-Language": "en-US" };

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};
const log = (...a) => console.log("[metube]", ...a);

const config = await readJson(CONFIG_PATH);
// Learn channels are grouped by topic ({ "History": ["@OverSimplified", ...] }); the app shows each topic as a shelf.
const topicOf = {};
for (const [topic, chans] of Object.entries(config.learn.topics || {})) chans.forEach((c) => (topicOf[c] = topic));
config.learn.channels = [...new Set([...(config.learn.channels || []), ...Object.keys(topicOf)])];
const state = await readJson(STATE_PATH, { channelIds: {}, seen: [] });
const library = await readJson(OUT_PATH, { beats: [], learn: [] });
const seen = new Set(state.seen);
const now = new Date().toISOString();

// ---------- helpers ----------

function parseVideoId(s) {
  const m = String(s).match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/) || String(s).match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

const decode = (s) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

async function resolveChannelId(ref) {
  if (/^UC[\w-]{22}$/.test(ref)) return ref;
  if (state.channelIds[ref]) return state.channelIds[ref];
  const url = ref.startsWith("http") ? ref : `https://www.youtube.com/${ref.startsWith("@") ? ref : "@" + ref}`;
  const html = await (await fetch(url, { headers: UA })).text();
  const id = html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] || html.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
  if (!id) throw new Error(`could not resolve channel ${ref}`);
  state.channelIds[ref] = id;
  return id;
}

async function readFeed(query) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?${query}`, { headers: UA });
  if (!res.ok) throw new Error(`feed ${query} -> ${res.status}`);
  const xml = await res.text();
  const feedTitle = decode(xml.match(/<author>\s*<name>([^<]*)<\/name>/)?.[1] || "");
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: e.match(/<yt:videoId>([^<]+)</)[1],
    title: decode(e.match(/<title>([^<]*)</)?.[1] || ""),
    channel: decode(e.match(/<name>([^<]*)</)?.[1] || feedTitle),
    published: e.match(/<published>([^<]+)</)?.[1],
  }));
}

// A Short answers 200 on /shorts/ID; a normal video redirects to /watch.
async function isShort(id) {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${id}`, { method: "HEAD", redirect: "manual", headers: UA });
    return res.status === 200;
  } catch { return false; }
}

const blocked = (title, isShortsFeed = false) => config.blockedTitleWords
  .filter((w) => !(isShortsFeed && w === "#shorts"))
  .some((w) => title.toLowerCase().includes(w.toLowerCase()));

async function collectFeeds(section, { list = "UULF" } = {}) {
  const out = [];
  const sources = [
    ...section.channels.map((c) => ({ ref: c, kind: "channel" })),
    ...(section.playlists || []).map((p) => ({ ref: p, kind: "playlist" })),
  ];
  for (const src of sources) {
    try {
      let entries;
      if (src.kind === "channel") {
        const id = await resolveChannelId(src.ref);
        // UULF… is the channel's long-form-only uploads list (no Shorts), UUSH… its Shorts-only list.
        entries = await readFeed(`playlist_id=${list}${id.slice(2)}`).catch((e) => (list === "UULF" ? readFeed(`channel_id=${id}`) : Promise.reject(e)));
      } else {
        entries = await readFeed(`playlist_id=${src.ref.match(/list=([\w-]+)/)?.[1] || src.ref}`);
      }
      entries = entries.filter((v) => !blocked(v.title, list === "UUSH"));
      out.push(...entries.slice(0, section.maxPerChannel).map((v) => ({ ...v, source: src.ref })));
    } catch (e) {
      log("skip", src.ref, e.message);
    }
  }
  return out;
}

async function youtubeApi(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`YouTube API ${endpoint} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const isoDurationToMin = (d) => {
  const [, h = 0, m = 0, s = 0] = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return +h * 60 + +m + +s / 60;
};

async function discover(disc, existingIds) {
  if (!disc?.enabled) return [];
  if (!process.env.YOUTUBE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    log("discovery skipped (set YOUTUBE_API_KEY and ANTHROPIC_API_KEY to enable)");
    return [];
  }
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const ids = new Set();
  for (const q of disc.queries) {
    const r = await youtubeApi("search", {
      part: "snippet", q, type: "video", maxResults: "15", order: "relevance",
      publishedAfter: since, relevanceLanguage: "en", safeSearch: "moderate", videoDuration: "any",
    });
    r.items.forEach((it) => ids.add(it.id.videoId));
  }
  const fresh = [...ids].filter((id) => !existingIds.has(id) && !seen.has(id));
  if (!fresh.length) return [];

  const details = [];
  for (let i = 0; i < fresh.length; i += 50) {
    const r = await youtubeApi("videos", { part: "snippet,contentDetails,statistics", id: fresh.slice(i, i + 50).join(",") });
    details.push(...r.items);
  }
  const candidates = details
    .map((v) => ({
      id: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      published: v.snippet.publishedAt,
      minutes: Math.round(isoDurationToMin(v.contentDetails.duration)),
      views: +v.statistics.viewCount || 0,
      description: v.snippet.description.slice(0, 400),
    }))
    .filter((v) => v.minutes >= disc.minMinutes && !blocked(v.title));
  candidates.forEach((c) => seen.add(c.id)); // never re-judge the same video
  if (!candidates.length) return [];

  const picks = await rankWithClaude(disc, candidates);
  log(`discovery: ${candidates.length} candidates -> ${picks.length} picked`);
  return picks.map((p) => {
    const c = candidates.find((x) => x.id === p.id);
    return { id: c.id, title: c.title, channel: c.channel, published: c.published, source: "discovery", why: p.reason };
  });
}

async function rankWithClaude(disc, candidates) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const schema = {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, reason: { type: "string" } },
          required: ["id", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["picks"],
    additionalProperties: false,
  };
  const response = await client.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system:
      "You curate a deliberately small video library for one person who wants YouTube only for learning. " +
      "Be picky: an empty list is better than a mediocre pick. Judge from title, channel, length and description.",
    messages: [{
      role: "user",
      content:
        `Taste profile:\n${disc.tasteProfile}\n\n` +
        `Pick at most ${disc.maxNewPerDay} videos that fit the profile best. ` +
        `Give a one-sentence reason for each (it is shown to the viewer).\n\nCandidates:\n` +
        JSON.stringify(candidates, null, 1),
    }],
  });
  if (response.stop_reason === "refusal") {
    log("Claude declined this batch; skipping discovery today");
    return [];
  }
  const text = response.content.find((b) => b.type === "text")?.text || '{"picks":[]}';
  const valid = new Set(candidates.map((c) => c.id));
  return JSON.parse(text).picks.filter((p) => valid.has(p.id)).slice(0, disc.maxNewPerDay);
}

// Merge new items into a section, dropping Shorts, keeping order newest-first.
async function merge(existing, incoming, { maxTotal, maxNew = Infinity, uncapped = () => false, allowShorts = false }) {
  const byId = new Map(existing.map((v) => [v.id, v]));
  let added = 0;
  for (const v of incoming) {
    if (byId.has(v.id) || (added >= maxNew && !uncapped(v))) continue;
    if (!allowShorts && (await isShort(v.id))) { seen.add(v.id); continue; }
    byId.set(v.id, { ...v, added: now });
    added++;
  }
  const all = [...byId.values()].sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  return { items: all.slice(0, maxTotal), added };
}

async function manualVideos(list) {
  const ids = list.map(parseVideoId).filter(Boolean);
  return Promise.all(ids.map(async (id) => {
    try {
      const r = await (await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { headers: UA })).json();
      return { id, title: r.title, channel: r.author_name, published: now, source: "manual" };
    } catch {
      return { id, title: "Video", channel: "", published: now, source: "manual" };
    }
  }));
}

// Video length in seconds, read from the watch page (the RSS feeds don't include it). Cached in videos.json.
async function fetchDuration(id) {
  try {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { ...UA, Cookie: "SOCS=CAI" } })).text();
    const m = html.match(/"lengthSeconds":"(\d+)"/);
    return m ? +m[1] : null;
  } catch { return null; }
}
async function fillDurations(items, known) {
  const todo = [];
  for (const v of items) {
    if (v.dur == null && known.has(v.id)) v.dur = known.get(v.id);
    if (v.dur == null) todo.push(v);
  }
  let i = 0, found = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < Math.min(todo.length, 600)) { const v = todo[i++]; v.dur = await fetchDuration(v.id); if (v.dur) found++; }
  }));
  if (todo.length) log(`durations: ${found}/${Math.min(todo.length, 600)} looked up`);
}

// Full playlist page (up to 100 videos, in playlist order). Used for series and channel back catalogs.
const toSec = (t) => t.split(":").reduce((a, n) => a * 60 + +n, 0);
async function readPlaylistPage(listId, tries = 3) {
  for (let t = 1; t < tries; t++) {
    try { const r = await readPlaylistOnce(listId); if (r.length) return r; } catch {}
    await new Promise((res) => setTimeout(res, 1500 * t));
  }
  return readPlaylistOnce(listId);
}
async function readPlaylistOnce(listId) {
  const html = await (await fetch(`https://www.youtube.com/playlist?list=${listId}`, { headers: { ...UA, Cookie: "SOCS=CAI" } })).text();
  const json = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!json) throw new Error(`playlist ${listId}: no data`);
  const out = [], ids = new Set();
  const push = (id, title, dur) => {
    if (!title || ids.has(id) || /^\[(deleted|private) video\]$/i.test(title)) return;
    ids.add(id); out.push({ id, title, dur });
  };
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const r = o.playlistVideoRenderer;
    if (r?.videoId) push(r.videoId, r.title?.runs?.map((x) => x.text).join(""), +r.lengthSeconds || null);
    const l = o.lockupViewModel;
    if (l?.contentId && /^[\w-]{11}$/.test(l.contentId)) {
      const badge = JSON.stringify(l.contentImage || {}).match(/"text":"(\d+(?::\d{2}){1,2})"/)?.[1];
      push(l.contentId, l.metadata?.lockupMetadataViewModel?.title?.content, badge ? toSec(badge) : null);
    }
    Object.values(o).forEach(walk);
  })(JSON.parse(json));
  return out;
}

// ---------- run ----------

// Liked beats are hand-picked: always kept, never trimmed, listed in your order.
const liked = (config.beats.liked || []).map((v) => ({ ...v, source: "liked", liked: true }));
const likedIds = new Set(liked.map((v) => v.id));
const beatsIn = [...(await manualVideos(config.beats.videos)), ...(await collectFeeds(config.beats))];
const feedBeats = await merge((library.beats || []).filter((v) => !v.liked), beatsIn.filter((v) => !likedIds.has(v.id)), config.beats);
const prevAdded = new Map((library.beats || []).map((v) => [v.id, v.added]));
const beats = {
  items: [...liked.map((v) => ({ ...v, added: prevAdded.get(v.id) || now })), ...feedBeats.items.filter((v) => !likedIds.has(v.id))],
  added: feedBeats.added,
};

// Drop videos from channels you've removed from the config, and rebuild series/collections fresh below.
const learnSources = new Set(config.learn.channels);
library.learn = (library.learn || []).filter((v) => !v.series && !v.collection && (learnSources.has(v.source) || ["discovery", "manual"].includes(v.source)));
library.shorts = (library.shorts || []).filter((v) => (config.shorts?.channels || []).includes(v.source));
const prevLearn = await readJson(OUT_PATH, { learn: [] }).then((d) => d.learn || []);

// Existing libraries predate seeding; treat their channels as already seeded.
const seededSources = new Set(state.seeded || ((library.learn || []).length ? config.learn.channels.filter((c) => (library.learn || []).some((v) => v.source === c)) : []));
const learnFeed = [...(await manualVideos(config.learn.videos)), ...(await collectFeeds(config.learn))];
const learnSubs = await merge(library.learn || [], learnFeed, {
  maxTotal: Infinity,
  // A channel's first run seeds its back catalog; after that, cap how much the feeds add per day.
  maxNew: config.learn.maxNewPerRun,
  uncapped: (v) => !seededSources.has(v.source),
});
config.learn.channels.forEach((c) => seededSources.add(c));
let discovered = [];
try {
  discovered = await discover(config.learn.discovery, new Set(learnSubs.items.map((v) => v.id)));
} catch (e) {
  log("discovery failed:", e.message);
}
const learn = await merge(learnSubs.items, discovered, { maxTotal: config.learn.maxTotal });

// Series (e.g. Crash Course Philosophy): every episode, in order, kept permanently.
const seriesItems = [], seriesMeta = [];
for (const se of config.learn.series || []) {
  let eps = [];
  try { eps = await readPlaylistPage(se.playlist); } catch (e) { log("series", se.name, e.message); }
  // pos = playlist order; ep = the episode number in the title ("#12"), if it has one.
  if (eps.length) eps = eps.map((v, i) => ({ ...v, channel: se.channel || "CrashCourse", series: se.name, pos: i + 1,
    ep: +(v.title.match(/#\s?(\d+)\b/)?.[1] || 0) || null, topic: se.topic, source: `series:${se.name}` }));
  if (eps.length && eps.filter((v) => v.ep).length < eps.length * 0.8) {
    // Titles don't carry numbers: count by playlist position, skipping previews/trailers.
    let n = 0;
    eps = eps.map((v) => ({ ...v, ep: /preview|trailer/i.test(v.title) ? null : ++n }));
  }
  if (!eps.length) eps = prevLearn.filter((v) => v.series === se.name); // scrape failed: keep yesterday's copy
  if (!eps.length) continue;
  seriesItems.push(...eps);
  seriesMeta.push({ name: se.name, topic: se.topic, count: eps.length, cover: eps[0].id });
}

// Collections: a channel's long-form back catalog (up to 100 videos), e.g. more Kurzgesagt.
const collectionItems = [];
for (const co of config.learn.collections || []) {
  let vids = [];
  try {
    const id = await resolveChannelId(co.channel);
    const name = (await readFeed(`playlist_id=UULF${id.slice(2)}`))[0]?.channel || co.channel;
    vids = (await readPlaylistPage(`UULF${id.slice(2)}`)).slice(0, co.max || 100)
      .map((v) => ({ ...v, channel: name, topic: co.topic, collection: co.channel, source: co.channel }));
  } catch (e) { log("collection", co.channel, e.message); }
  if (!vids.length) vids = prevLearn.filter((v) => v.collection === co.channel);
  collectionItems.push(...vids);
}

// Shorts: educational channels' Shorts-only feeds, for the swipe feed.
const shortsCfg = config.shorts || { channels: [] };
const shortsIn = await collectFeeds(shortsCfg, { list: "UUSH" });
const shorts = await merge(library.shorts || [], shortsIn, { maxTotal: shortsCfg.maxTotal || 300, allowShorts: true });

// Some channels upload the same episode twice (e.g. video + podcast version); keep one per channel+title.
const dedupe = (items) => { const seenKey = new Set(); return items.filter((v) => { const k = `${v.channel}|${v.title.toLowerCase().trim()}`; if (seenKey.has(k)) return false; seenKey.add(k); return true; }); };
beats.items = dedupe(beats.items);
{
  // Feed videos first (they have dates), then back-catalog extras, then series episodes in order.
  const have = new Set(learn.items.map((v) => v.id));
  const extras = collectionItems.filter((v) => !have.has(v.id) && have.add(v.id));
  const eps = seriesItems.filter((v) => !have.has(v.id) && have.add(v.id));
  learn.items = [...dedupe(learn.items), ...dedupe(extras), ...eps];
}
shorts.items = dedupe(shorts.items);
const knownDur = new Map([...(library.beats || []), ...(library.learn || []), ...prevLearn].filter((v) => v.dur != null).map((v) => [v.id, v.dur]));
await fillDurations([...beats.items, ...learn.items], knownDur);
const learnOut = learn.items.map((v) => (!v.topic && topicOf[v.source] ? { ...v, topic: topicOf[v.source] } : v));
await writeFile(OUT_PATH, JSON.stringify({ updatedAt: now, topics: Object.keys(config.learn.topics || {}), series: seriesMeta, beats: beats.items, learn: learnOut, shorts: shorts.items }, null, 1) + "\n");
state.seen = [...seen].slice(-5000);
state.seeded = [...seededSources];
await writeFile(STATE_PATH, JSON.stringify(state, null, 1) + "\n");
log(`beats: ${beats.items.length} (+${beats.added}), learn: ${learn.items.length} (+${learnSubs.added + learn.added}), shorts: ${shorts.items.length} (+${shorts.added})`);
