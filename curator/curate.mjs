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

const blocked = (title) => config.blockedTitleWords.some((w) => title.toLowerCase().includes(w.toLowerCase()));

async function collectFeeds(section) {
  const out = [];
  const sources = [
    ...section.channels.map((c) => ({ ref: c, kind: "channel" })),
    ...(section.playlists || []).map((p) => ({ ref: p, kind: "playlist" })),
  ];
  for (const src of sources) {
    try {
      const q = src.kind === "channel"
        ? `channel_id=${await resolveChannelId(src.ref)}`
        : `playlist_id=${src.ref.match(/list=([\w-]+)/)?.[1] || src.ref}`;
      const entries = (await readFeed(q)).filter((v) => !blocked(v.title));
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
async function merge(existing, incoming, { maxTotal, maxNew = Infinity }) {
  const byId = new Map(existing.map((v) => [v.id, v]));
  let added = 0;
  for (const v of incoming) {
    if (byId.has(v.id) || added >= maxNew) continue;
    if (await isShort(v.id)) { seen.add(v.id); continue; }
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

// ---------- run ----------

const beatsIn = [...(await manualVideos(config.beats.videos)), ...(await collectFeeds(config.beats))];
const beats = await merge(library.beats || [], beatsIn, config.beats);

const learnFeed = [...(await manualVideos(config.learn.videos)), ...(await collectFeeds(config.learn))];
const learnSubs = await merge(library.learn || [], learnFeed, {
  maxTotal: Infinity,
  // first run seeds the library; after that, cap how much the feed can add per day
  maxNew: (library.learn || []).length ? config.learn.maxNewPerRun : Infinity,
});
let discovered = [];
try {
  discovered = await discover(config.learn.discovery, new Set(learnSubs.items.map((v) => v.id)));
} catch (e) {
  log("discovery failed:", e.message);
}
const learn = await merge(learnSubs.items, discovered, { maxTotal: config.learn.maxTotal });

await writeFile(OUT_PATH, JSON.stringify({ updatedAt: now, beats: beats.items, learn: learn.items }, null, 1) + "\n");
state.seen = [...seen].slice(-5000);
await writeFile(STATE_PATH, JSON.stringify(state, null, 1) + "\n");
log(`beats: ${beats.items.length} (+${beats.added}), learn: ${learn.items.length} (+${learnSubs.added + learn.added})`);
