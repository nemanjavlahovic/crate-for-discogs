// Embed engine: one long-lived YouTube embed, driven over the IFrame API's postMessage protocol.
// (Extension pages can't load the remote iframe_api script, so we speak its wire format directly.)
// Because this document belongs to the extension, which has youtube.com host access, Chrome
// treats the embed as first-party: it sees the user's normal YouTube sign-in.

const ORIGIN = 'https://www.youtube.com';
const STALL_MS = 6000;

let frame;
let ready = false;
let pending = [];
let handshake;
let wanted = null; // video we were asked to play
let current = { state: -1, t: 0, d: 0 };
let lastStatus = 0;
let stallTimer;

function boot() {
  frame = document.createElement('iframe');
  frame.allow = 'autoplay; encrypted-media';
  frame.src =
    `${ORIGIN}/embed/?enablejsapi=1&playsinline=1&controls=0&disablekb=1&widgetid=1` +
    `&origin=${encodeURIComponent(location.origin)}`;
  frame.addEventListener('load', () => {
    clearInterval(handshake);
    const listen = () => post({ event: 'listening', id: 1, channel: 'widget' });
    listen();
    handshake = setInterval(listen, 250);
  });
  document.body.append(frame);
}

function post(msg) {
  frame?.contentWindow?.postMessage(JSON.stringify(msg), ORIGIN);
}

function command(func, args = []) {
  if (!ready) return void pending.push([func, args]);
  post({ event: 'command', func, args, id: 1, channel: 'widget' });
}

addEventListener('message', (e) => {
  if (e.origin !== ORIGIN || e.source !== frame?.contentWindow) return;
  let data;
  try {
    data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  } catch {
    return;
  }
  switch (data.event) {
    case 'onReady':
      if (ready) return;
      ready = true;
      clearInterval(handshake);
      pending.splice(0).forEach(([func, args]) => command(func, args));
      return;
    case 'infoDelivery':
      return onInfo(data.info ?? {});
    case 'onStateChange':
      return onInfo({ playerState: data.info });
    case 'onError':
      clearTimeout(stallTimer);
      return report({ type: 'error', code: data.info });
  }
});

function onInfo(info) {
  if (!wanted) return;
  // While switching tracks the player still reports the previous video for a moment.
  if (info.videoData?.video_id && info.videoData.video_id !== wanted) return;
  if (info.duration) current.d = info.duration;

  if (typeof info.playerState === 'number' && info.playerState !== current.state) {
    current.state = info.playerState;
    if (current.state === 0) return report({ type: 'ended' });
    if (current.state === 1) {
      clearTimeout(stallTimer);
      current.ad = 0;
    }
    if (typeof info.currentTime === 'number' && current.state !== -1) current.t = info.currentTime;
    return status();
  }
  if (typeof info.currentTime !== 'number') return;

  // Pre-roll ad (signed out, or no Premium): the clock runs while the video itself is still unstarted.
  if (current.state === -1 && info.currentTime > 0) {
    clearTimeout(stallTimer);
    const p = info.progressState;
    current.ad = p ? Math.max(1, Math.ceil(p.duration - p.current)) : 1;
    if (Date.now() - lastStatus > 1000) status();
    return;
  }
  current.t = info.currentTime;
  if (current.state === 1 && Date.now() - lastStatus > 1000) status();
}

function status() {
  lastStatus = Date.now();
  report({
    type: 'status',
    t: current.t,
    d: current.d,
    playing: current.state === 1,
    buffering: !current.ad && (current.state === 3 || current.state === -1),
    ad: current.ad || 0,
  });
}

function report(msg) {
  chrome.runtime.sendMessage({ target: 'bg', from: 'embed', videoId: wanted, ...msg }).catch(() => {});
}

// Autoplay blocked or a silent failure: say so, and the background falls back to the tab engine.
function armStall() {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (current.state !== 1 && current.state !== 3) report({ type: 'error', code: 'stalled' });
  }, STALL_MS);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.cmd) {
    case 'load':
      wanted = msg.videoId;
      current = { state: -1, t: msg.start || 0, d: 0 };
      command('loadVideoById', [{ videoId: msg.videoId, startSeconds: msg.start || 0 }]);
      armStall();
      break;
    case 'play':
      command('playVideo');
      armStall();
      break;
    case 'pause':
      clearTimeout(stallTimer);
      command('pauseVideo');
      break;
    case 'seek':
      current.t = msg.t;
      command('seekTo', [msg.t, true]);
      break;
  }
});

boot();
