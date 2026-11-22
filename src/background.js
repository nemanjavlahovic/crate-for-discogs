// Crate background worker.
// Owns the queue, resolves Discogs releases to YouTube videos, and drives two playback engines:
//   embed: a YouTube embed inside an offscreen extension document (default, instant, survives navigation)
//   tab:   a pinned youtube.com tab, for videos whose owners disabled embedding

const API = 'https://api.discogs.com';
// Discogs' API terms: nothing shown may be more than 6 hours older than discogs.com, and nothing is
// kept longer than needed. Releases (with their videos) and have/want counts both follow this.
const FRESH_FOR = 6 * 60 * 60 * 1000;
const EMBED_REFUSED = new Set([101, 150, 152, 153, 'stalled']);

const state = {
  queue: [], // { uid, videoId, title, duration, embed, release: { key, title, artist, thumb, url } }
  index: -1,
  playing: false,
  buffering: false,
  ad: 0, // seconds left in a YouTube ad, 0 when none
  position: 0, // seconds, as of `at`
  duration: 0,
  at: 0,
  engine: 'embed',
  loaded: false, // the engine has the current track loaded
  loadingKey: null,
  status: null, // what's still loading, shown above the bar
  wanted: {}, // release/master key -> { id } of the version added to the Discogs wantlist
};
let tabId = null; // pinned YouTube tab used by the tab engine
const uiTabs = new Set(); // Discogs tabs showing the player

const ready = (async () => {
  const [{ session, wanted }, runtime] = await Promise.all([
    chrome.storage.local.get(['session', 'wanted']),
    chrome.storage.session.get(['runtime']).then((r) => r.runtime),
  ]);
  if (session) Object.assign(state, session, { playing: false, at: Date.now() });
  if (wanted) state.wanted = wanted;
  if (runtime) {
    state.loaded = runtime.loaded;
    state.engine = runtime.engine;
    tabId = runtime.tabId;
    runtime.uiTabs.forEach((id) => uiTabs.add(id));
  }
})();

// YouTube refuses embeds that arrive without a Referer (error 153). Extension pages send none,
// so attach one to embed requests that come from outside any tab (our offscreen document).
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.discogs.com/' }],
      },
      condition: {
        urlFilter: '||youtube.com/embed/',
        resourceTypes: ['sub_frame'],
        tabIds: [chrome.tabs.TAB_ID_NONE],
      },
    },
  ],
});

// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'bg') return;
  ready.then(async () => {
    if (msg.from === 'ui') {
      if (sender.tab && !uiTabs.has(sender.tab.id)) {
        uiTabs.add(sender.tab.id);
        persist();
      }
      if (msg.type === 'hello') return sendResponse({ state: snapshot() });
      await handleUi({ ...msg, tab: sender.tab?.id });
      sendResponse({});
    } else if (msg.from === 'tab') {
      if (msg.type === 'hello') return sendResponse({ player: sender.tab?.id === tabId });
      if (sender.tab?.id === tabId) onEngine('tab', msg);
    } else if (msg.from === 'embed') {
      onEngine('embed', msg);
    }
  }).catch((err) => {
    console.error('[crate]', err);
    sendResponse({ error: String(err) });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  uiTabs.delete(id);
  if (id !== tabId) return;
  tabId = null;
  if (state.engine === 'tab') {
    pauseLocal();
    state.loaded = false;
    broadcast();
  }
  persist();
});

function snapshot() {
  return { ...state, position: livePosition(), at: Date.now() };
}

function send(tab, msg) {
  try {
    chrome.tabs.sendMessage(tab, msg).catch(() => uiTabs.delete(tab));
  } catch {
    uiTabs.delete(tab); // closed tab or a bad id: drop it, never break the caller
  }
}

function broadcast() {
  const msg = { nd: 'state', state: snapshot() };
  uiTabs.forEach((tab) => send(tab, msg));
}

function tick() {
  const msg = {
    nd: 'tick',
    tick: { position: state.position, duration: state.duration, at: state.at, playing: state.playing, buffering: state.buffering, ad: state.ad },
  };
  uiTabs.forEach((tab) => send(tab, msg));
}

function notice(text) {
  uiTabs.forEach((tab) => send(tab, { nd: 'notice', text }));
}

// ---------- UI commands ----------

async function handleUi(msg) {
  switch (msg.type) {
    case 'warm':
      return ensureOffscreen();
    case 'prefetch':
      return getRelease(msg.release, 'prefetch').catch(() => {});
    case 'stats':
      return requestStats(msg.refs, msg.tab);
    case 'want':
      return toggleWant(msg.release);
    case 'play':
      return playRelease(msg.release);
    case 'queue':
      return queueRelease(msg.release);
    case 'toggle':
      return toggle();
    case 'next':
      return step(1);
    case 'prev':
      return prev();
    case 'seek':
      return seek(msg.position);
    case 'jump':
      return playIndex(msg.index, 0);
    case 'remove':
      return removeWhere((t) => t.uid === msg.uid);
    case 'removeRelease':
      return removeWhere((t) => t.release.key === msg.key);
    case 'clear':
      return clear();
  }
}

let playToken = 0;

async function playRelease(ref) {
  const key = keyOf(ref);
  const existing = state.queue.findIndex((t) => t.release.key === key);
  if (existing !== -1) return playIndex(existing, 0);

  const token = ++playToken;
  setLoading(key);
  const slow = setTimeout(() => setStatus('Loading release…'), 350);
  try {
    const release = await getRelease(ref, 'play');
    if (!release.tracks.length) return notice(`No videos on “${release.title}”`);
    const at = state.index + 1;
    state.queue.splice(at, 0, ...toItems(release));
    // A later click won the race: keep this release queued, but don't steal playback.
    if (token !== playToken) {
      broadcast();
      return persist();
    }
    await playIndex(at, 0);
  } catch (err) {
    notice(failure(err));
  } finally {
    clearTimeout(slow);
    if (state.loadingKey === key) setLoading(null);
  }
}

async function queueRelease(ref) {
  const key = keyOf(ref);
  if (state.queue.some((t) => t.release.key === key)) return notice('Already in your queue');
  setLoading(key);
  const slow = setTimeout(() => setStatus('Loading release…'), 350);
  try {
    const release = await getRelease(ref, 'play');
    if (!release.tracks.length) return notice(`No videos on “${release.title}”`);
    state.queue.push(...toItems(release));
    if (state.index === -1) state.index = 0;
    const n = release.tracks.length;
    notice(`Queued ${n} ${n === 1 ? 'track' : 'tracks'} from “${release.title}”`);
    broadcast();
    persist();
  } catch (err) {
    notice(failure(err));
  } finally {
    clearTimeout(slow);
    if (state.loadingKey === key) setLoading(null);
  }
}

function setLoading(key) {
  state.loadingKey = key;
  if (!key) state.status = null;
  broadcast();
}

// A sticky line above the bar while something is still loading; null clears it.
function setStatus(text) {
  if (state.status === text) return;
  state.status = text;
  broadcast();
}

function failure(err) {
  switch (err.message) {
    case 'rate-limited':
      return token
        ? 'Discogs is still rate limiting. Give it a minute.'
        : 'Discogs is still rate limiting. Give it a minute, or add a token in the popup for a higher limit.';
    case 'offline':
      return 'Couldn’t reach Discogs. Check your connection.';
    case 'Discogs 404':
      return 'Discogs doesn’t have this release anymore.';
    default:
      return `Couldn’t load that release (${err.message}).`;
  }
}

async function playIndex(index, start = 0) {
  const track = state.queue[index];
  if (!track) return;
  Object.assign(state, {
    index,
    position: start,
    duration: track.duration,
    at: Date.now(),
    playing: true,
    buffering: true,
    ad: 0,
    loaded: true,
    engine: track.embed ? 'embed' : 'tab',
  });
  broadcast();
  persist();
  if (state.engine === 'embed') {
    toTab({ cmd: 'pause' });
    await toOffscreen({ cmd: 'load', videoId: track.videoId, start });
  } else {
    await toOffscreen({ cmd: 'pause' }, false);
    await loadInTab(track.videoId, start);
  }
}

async function toggle() {
  if (state.index < 0) return;
  if (state.playing) {
    pauseLocal();
    broadcast();
    persist();
    return engineCmd({ cmd: 'pause' });
  }
  if (!state.loaded || !(await engineAlive())) return playIndex(state.index, state.position);
  state.playing = true;
  state.at = Date.now();
  broadcast();
  return engineCmd({ cmd: 'play' });
}

function step(dir) {
  const next = state.index + dir;
  if (next >= 0 && next < state.queue.length) return playIndex(next, 0);
  if (next >= state.queue.length) {
    // End of the queue: park on the last track, rewound.
    pauseLocal();
    state.position = 0;
    state.loaded = false;
    engineCmd({ cmd: 'pause' });
    broadcast();
    persist();
  }
}

function prev() {
  if (livePosition() > 3 || state.index <= 0) return seek(0);
  return step(-1);
}

async function seek(position) {
  if (state.index < 0) return;
  state.position = Math.max(0, position);
  state.at = Date.now();
  broadcast();
  persist();
  if (state.loaded && (await engineAlive())) return engineCmd({ cmd: 'seek', t: state.position });
  if (state.playing) return playIndex(state.index, state.position);
}

function removeWhere(pred) {
  const wasCurrent = state.queue[state.index];
  const kept = [];
  let index = -1;
  state.queue.forEach((t, i) => {
    if (i === state.index) index = kept.length; // the next kept track takes the current slot
    if (!pred(t)) kept.push(t);
  });
  state.queue = kept;
  if (!kept.length) return clear();

  if (wasCurrent && pred(wasCurrent)) {
    if (state.playing && index < kept.length) return playIndex(index, 0);
    pauseLocal();
    engineCmd({ cmd: 'pause' });
    Object.assign(state, { index: Math.min(index, kept.length - 1), position: 0, loaded: false });
  } else {
    state.index = index;
  }
  broadcast();
  persist();
}

function clear() {
  engineCmd({ cmd: 'pause' });
  Object.assign(state, { queue: [], index: -1, playing: false, buffering: false, position: 0, duration: 0, loaded: false });
  broadcast();
  persist();
}

function pauseLocal() {
  state.position = livePosition();
  state.playing = false;
  state.buffering = false;
  state.at = Date.now();
}

function livePosition() {
  if (!state.playing || state.buffering || state.ad) return state.position;
  const pos = state.position + (Date.now() - state.at) / 1000;
  return state.duration ? Math.min(pos, state.duration) : pos;
}

// ---------- engine events ----------

let lastPersist = 0;

function onEngine(engine, msg) {
  if (engine !== state.engine) return;
  const track = state.queue[state.index];
  if (!track || (msg.videoId && msg.videoId !== track.videoId)) return; // stale event from a previous track

  switch (msg.type) {
    case 'status':
      state.position = msg.t;
      if (msg.d) state.duration = msg.d;
      state.playing = msg.playing || ((msg.buffering || msg.ad > 0) && state.playing);
      state.buffering = !!msg.buffering;
      state.ad = msg.ad || 0;
      state.at = Date.now();
      tick();
      if (Date.now() - lastPersist > 5000) persist();
      return;
    case 'ended':
      return step(1);
    case 'error':
      if (engine === 'embed' && EMBED_REFUSED.has(msg.code)) {
        track.embed = false;
        return playIndex(state.index, state.position);
      }
      notice(`Can’t play “${track.title}”. Skipping.`);
      return step(1);
    case 'blocked':
      // YouTube wants a person (consent, sign-in, autoplay). Show them the tab; playback picks up from there.
      pauseLocal();
      broadcast();
      notice('YouTube needs a click in its tab before this one can play');
      if (tabId != null) chrome.tabs.update(tabId, { active: true }).catch(() => {});
      return;
  }
}

// ---------- engines ----------

let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays the Discogs listening queue through the YouTube player.',
    })
    .finally(() => (creating = null));
  await creating;
}

async function toOffscreen(msg, create = true) {
  if (create) await ensureOffscreen();
  else if (!(await chrome.offscreen.hasDocument())) return;
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

function toTab(msg) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function loadInTab(videoId, start) {
  const url = `https://www.youtube.com/watch?v=${videoId}${start ? `&t=${Math.floor(start)}s` : ''}`;
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { url });
      return;
    } catch {
      tabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url, pinned: true, active: false });
  tabId = tab.id;
  persist();
  notice('This video can’t be embedded. Playing it in a pinned YouTube tab.');
}

function engineCmd(msg) {
  return state.engine === 'embed' ? toOffscreen(msg, false) : toTab(msg);
}

async function engineAlive() {
  if (state.engine === 'embed') return chrome.offscreen.hasDocument();
  if (tabId == null) return false;
  return chrome.tabs.get(tabId).then(() => true, () => false);
}

// ---------- Discogs data ----------
// Every API call has a priority: 'play' (a click) waits and retries, 'prefetch' (hover) is
// dropped when the budget runs low, 'stats' (have/want badges) waits politely behind both.

const memory = new Map(); // key -> Promise<release>
const docs = new Map(); // api path -> Promise<json>, so one response can serve several needs

function keyOf(ref) {
  return `${ref.kind}:${ref.id}`;
}

// Requests for the same thing share one in-flight promise. A failure is forgotten at once, and a
// click that joined a background request (prefetch, counts) retries on its own terms if that fails.
function shared(map, key, priority, make) {
  const start = () => {
    const p = make();
    map.set(key, p);
    p.catch(() => map.get(key) === p && map.delete(key));
    return p;
  };
  const pending = map.get(key);
  if (!pending) return start();
  return priority === 'play' ? pending.catch(() => start()) : pending;
}

function getRelease(ref, priority) {
  return shared(memory, keyOf(ref), priority, () => loadRelease(ref, priority)).then((release) =>
    ref.thumb ? { ...release, thumb: ref.thumb } : release,
  );
}

async function loadRelease(ref, priority) {
  const key = keyOf(ref);
  const cacheKey = `r:${key}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.ts < FRESH_FOR) return cached.release;

  const data = await doc(`/${ref.kind === 'master' ? 'masters' : 'releases'}/${ref.id}`, priority);
  let videos = data.videos ?? [];
  if (!videos.length) {
    const fallback =
      ref.kind === 'master'
        ? data.main_release && `/releases/${data.main_release}`
        : data.master_id && `/masters/${data.master_id}`;
    if (fallback) videos = (await doc(fallback, priority)).videos ?? [];
  }
  const release = {
    key,
    title: data.title,
    artist: artistsOf(data.artists),
    thumb: data.images?.[0]?.uri150 ?? '',
    url: ref.url || new URL(data.uri).pathname,
    tracks: toTracks(videos),
  };
  chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), release } });
  return release;
}

// A release response also carries its have/want counts: keep them whenever one passes through.
function doc(path, priority) {
  return shared(docs, path, priority, () => {
    const p = api(path, priority).then((data) => {
      const m = path.match(/^\/releases\/(\d+)$/);
      if (m && data.community) saveStats(`release:${m[1]}`, { have: data.community.have, want: data.community.want });
      return data;
    });
    p.then(() => setTimeout(() => docs.get(path) === p && docs.delete(path), 60_000), () => {});
    return p;
  });
}

// ---------- have / want ----------

const STATS_RESERVE = 8; // calls per minute background work never touches, so clicks always get through
const statsMemory = new Map(); // key -> { have, want, more }

function saveStats(key, stats) {
  statsMemory.set(key, stats);
  chrome.storage.local.set({ [`s:${key}`]: { ts: Date.now(), stats } });
}

// ---------- details for covers on screen ----------
// For every cover in view: its have/want counts, then its video list (so a click goes straight to
// YouTube with no Discogs lookup). Nearest covers first, five requests at a time, inside the rate
// budget, and everything pauses while a click is loading.

const POOL = 5;
let detailQueue = []; // [{ key, ref, tab, need: 'stats' | 'tracks' }]
let detailActive = 0;
let detailTimer = 0;

const fresh = (hit, ttl) => (hit && Date.now() - hit.ts < ttl ? hit : null);

// Forget what has gone stale, in memory and in storage. Memory is cleared outright: anything still
// fresh reloads from storage, which keeps its own timestamp.
async function dropStale() {
  memory.clear();
  statsMemory.clear();
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => /^[rs]:/.test(k) && !fresh(all[k], FRESH_FOR));
  if (stale.length) chrome.storage.local.remove(stale);
}
dropStale();
setInterval(dropStale, 15 * 60 * 1000);

// The UI sends the covers in view, nearest first. The newest request from a tab replaces its old one,
// so covers scrolled past are dropped.
async function requestStats(refs, tab) {
  const keys = refs.map(keyOf);
  const stored = await chrome.storage.local.get(keys.flatMap((k) => [`s:${k}`, `r:${k}`]));
  const found = {};
  const statsJobs = [];
  const trackJobs = [];
  refs.forEach((ref, i) => {
    const key = keys[i];
    const stats = statsMemory.get(key) ?? fresh(stored[`s:${key}`], FRESH_FOR)?.stats;
    if (stats) {
      statsMemory.set(key, stats);
      found[key] = stats;
    } else statsJobs.push({ key, ref, tab, need: 'stats' });
    if (!memory.has(key) && !fresh(stored[`r:${key}`], FRESH_FOR)) trackJobs.push({ key, ref, tab, need: 'tracks' });
  });
  if (Object.keys(found).length) send(tab, { nd: 'stats', stats: found });
  // What you can see first (counts), then what makes clicks instant (videos).
  const jobs = [...statsJobs, ...trackJobs];
  const mine = new Set(jobs.map((j) => j.need + j.key));
  detailQueue = [...jobs, ...detailQueue.filter((j) => j.tab !== tab && !mine.has(j.need + j.key))];
  pump();
}

function pump() {
  clearTimeout(detailTimer);
  while (detailActive < POOL && detailQueue.length) {
    // A click is loading: it gets the budget, details wait.
    if (clicksLoading > 0) return void (detailTimer = setTimeout(pump, 250));
    const limit = token ? 60 : 25;
    const left = Date.now() < budget.until ? budget.remaining : limit;
    // Jobs answered from what's already fetched cost nothing, so they never wait on the budget.
    const freeAt = detailQueue.findIndex(isFree);
    if (freeAt === -1 && left - detailActive <= STATS_RESERVE) return void (detailTimer = setTimeout(pump, 2000));
    const [job] = detailQueue.splice(freeAt === -1 ? 0 : freeAt, 1);
    detailActive++;
    runDetail(job).finally(() => {
      detailActive--;
      pump();
    });
  }
}

function isFree(job) {
  if (job.need === 'stats') return statsMemory.has(job.key);
  return memory.has(job.key) || (job.ref.kind === 'release' && docs.has(`/releases/${job.ref.id}`));
}

async function runDetail(job) {
  try {
    if (job.need === 'stats') {
      const stats = statsMemory.get(job.key) ?? (await fetchStats(job.ref));
      send(job.tab, { nd: 'stats', stats: { [job.key]: stats } });
    } else {
      await getRelease(job.ref, 'stats'); // a release's counts call already fetched this: no extra request
    }
  } catch {
    // Rate limited or offline: the UI asks again for anything still missing.
  }
}

async function fetchStats(ref) {
  const key = keyOf(ref);
  if (ref.kind === 'release') {
    await doc(`/releases/${ref.id}`, 'stats'); // doc() saves the counts
    return statsMemory.get(key) ?? { have: 0, want: 0 };
  }
  // Masters have no counts of their own: add up their versions (first 100 cover nearly all).
  const data = await api(`/masters/${ref.id}/versions?per_page=100`, 'stats');
  const stats = (data.versions ?? []).reduce(
    (sum, v) => ({
      have: sum.have + (v.stats?.community?.in_collection ?? 0),
      want: sum.want + (v.stats?.community?.in_wantlist ?? 0),
      more: sum.more,
    }),
    { have: 0, want: 0, more: (data.pagination?.pages ?? 1) > 1 },
  );
  saveStats(key, stats);
  return stats;
}

// ---------- wantlist ----------
// Writing to the wantlist needs the user's personal token (the API has no other way in).
// For a master we pick "the closest item": the key release, unless it's a promo or similar,
// in which case the earliest version that isn't.

const PASS_OVER = /\b(promo|test pressing|white label|unofficial|transcription|advance)\b/i;
let identity = null; // { token, username }

async function username() {
  if (!token) return null;
  if (identity?.token !== token) {
    const me = await api('/oauth/identity', 'play');
    identity = { token, username: me.username };
  }
  return identity.username;
}

async function pickVersion(ref) {
  if (ref.kind === 'release') {
    const d = await doc(`/releases/${ref.id}`, 'play');
    const format = (d.formats ?? []).map((f) => [f.name, ...(f.descriptions ?? [])].join(', ')).join(' + ');
    return { id: d.id, title: d.title, detail: [format, d.year || null, d.country].filter(Boolean).join(' · ') };
  }
  const [master, list] = await Promise.all([
    doc(`/masters/${ref.id}`, 'play'),
    api(`/masters/${ref.id}/versions?per_page=100&sort=released&sort_order=asc`, 'play'),
  ]);
  const pick = chooseVersion(list.versions ?? [], master.main_release);
  if (!pick) throw new Error('no versions');
  return { id: pick.id, title: pick.title, detail: [pick.format, pick.released, pick.country].filter(Boolean).join(' · ') };
}

// versions arrive oldest first. Key release if it's a proper issue, else the earliest one that is.
function chooseVersion(versions, mainRelease) {
  const fine = versions.filter((v) => !PASS_OVER.test(v.format ?? ''));
  return (
    fine.find((v) => v.id === mainRelease) ??
    fine[0] ??
    versions.find((v) => v.id === mainRelease) ??
    versions[0]
  );
}

async function toggleWant(ref) {
  try {
    await updateWantlist(ref);
  } finally {
    if (!state.loadingKey) setStatus(null);
  }
}

async function updateWantlist(ref) {
  const key = keyOf(ref);
  let user;
  try {
    user = await username();
  } catch {
    return notice('Your Discogs token was refused. Check it in the Crate popup.');
  }
  if (!user) {
    notice('Add your Discogs token in the Crate popup to use your wantlist');
    chrome.action.openPopup?.().catch(() => {});
    return;
  }
  const path = (id) => `/users/${encodeURIComponent(user)}/wants/${id}`;
  const had = state.wanted[key];

  // Optimistic: the heart changes on click, and goes back if Discogs says no.
  if (had) {
    if (had.pending) return;
    delete state.wanted[key];
    saveWanted();
    try {
      await api(path(had.id), 'play', 'DELETE');
      notice('Removed from your wantlist');
    } catch {
      state.wanted[key] = had;
      saveWanted();
      notice('Couldn’t remove it from your wantlist');
    }
    return;
  }
  state.wanted[key] = { pending: true };
  saveWanted();
  try {
    const pick = await pickVersion(ref);
    await api(path(pick.id), 'play', 'PUT');
    state.wanted[key] = { id: pick.id };
    saveWanted();
    notice(`Wanted “${pick.title}”${pick.detail ? ` · ${pick.detail}` : ''}`);
  } catch {
    delete state.wanted[key];
    saveWanted();
    notice('Couldn’t add it to your wantlist');
  }
}

function saveWanted() {
  const settled = Object.fromEntries(Object.entries(state.wanted).filter(([, v]) => !v.pending));
  chrome.storage.local.set({ wanted: settled });
  broadcast();
}

// ---------- API ----------
// Discogs allows 25 requests a minute without a token, 60 with one (moving window).

let budget = { remaining: 25, until: 0 };
let clicksLoading = 0;
let token = '';
chrome.storage.local.get('token').then((r) => (token = r.token ?? ''));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.token) token = changes.token.newValue ?? '';
});

async function api(path, priority, method = 'GET', attempt = 0) {
  if (priority === 'prefetch' && budget.remaining <= STATS_RESERVE && Date.now() < budget.until) throw new Error('skipped');
  if (priority === 'play') clicksLoading++;
  try {
    return await request(path, priority, method, attempt);
  } finally {
    if (priority === 'play' && --clicksLoading === 0) pump();
  }
}

async function request(path, priority, method, attempt) {
  let res;
  try {
    res = await fetch(API + path, { method, headers: token ? { Authorization: `Discogs token=${token}` } : {} });
  } catch {
    throw new Error('offline');
  }
  const remaining = res.headers.get('x-discogs-ratelimit-remaining');
  if (remaining != null) budget = { remaining: Number(remaining), until: Date.now() + 60_000 };
  if (res.status === 429) {
    budget = { remaining: 0, until: Date.now() + 60_000 };
    if (priority !== 'play' || attempt >= 5) throw new Error('rate-limited');
    const wait = Number(res.headers.get('retry-after')) || [3, 5, 8, 10, 12][attempt];
    for (let left = wait; left > 0; left--) {
      setStatus(`Discogs is rate limiting · retrying in ${left}s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setStatus('Loading release…');
    return request(path, priority, method, attempt + 1);
  }
  if (res.status === 401 && token) {
    notice('Your Discogs token was refused. Check it in the Crate popup.');
    throw new Error('Discogs 401');
  }
  if (!res.ok) throw new Error(`Discogs ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function toTracks(videos) {
  const seen = new Set();
  return videos.flatMap((v) => {
    const id = videoIdOf(v.uri);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ videoId: id, title: v.title, duration: v.duration || 0, embed: v.embed !== false }];
  });
}

function toItems(release) {
  const { tracks, ...meta } = release;
  return tracks.map((t) => ({ uid: crypto.randomUUID(), ...t, release: meta }));
}

function videoIdOf(uri) {
  try {
    const u = new URL(uri);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || null;
    return u.searchParams.get('v') || u.pathname.match(/\/(?:embed|shorts|v)\/([\w-]{11})/)?.[1] || null;
  } catch {
    return null;
  }
}

function artistsOf(list = []) {
  return list
    .map((a, i) => {
      const name = a.name.replace(/ \(\d+\)$/, '');
      if (i === list.length - 1) return name;
      return name + (a.join && a.join !== ',' ? ` ${a.join} ` : ', ');
    })
    .join('');
}

// Handy from the service worker's DevTools console.
self.crate = { state, handleUi, pickVersion, chooseVersion };

// ---------- persistence ----------

function persist() {
  lastPersist = Date.now();
  const { queue, index, duration } = state;
  chrome.storage.local.set({ session: { queue, index, duration, position: livePosition() } });
  chrome.storage.session.set({
    runtime: { loaded: state.loaded, engine: state.engine, tabId, uiTabs: [...uiTabs] },
  });
}
