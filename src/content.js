// Crate UI on discogs.com.
// Never touches Discogs' own DOM (a Next.js app that re-renders freely): every control lives in one
// shadow root and floats over the page, positioned against the cover being hovered.
// Cover overlays sit in page coordinates (the host is anchored to the document, not the window),
// so they ride along with the page, including the macOS rubber-band bounce at either end.
(() => {
  if (window.__crate) return;
  window.__crate = true;

  const ID_RE = /\/(release|master)\/(\d+)/;
  const MIN_COVER = 56; // px; smaller thumbnails don't get controls
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  let state = { queue: [], index: -1, playing: false, buffering: false, ad: 0, position: 0, duration: 0, at: 0, loadingKey: null };
  let dead = false;

  // ---------- messaging ----------

  function send(type, extra = {}) {
    if (!chrome.runtime?.id) return teardown(), Promise.resolve();
    return chrome.runtime.sendMessage({ target: 'bg', from: 'ui', type, ...extra }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (dead) return;
    if (msg.nd === 'state') applyState(msg.state);
    else if (msg.nd === 'tick') applyTick(msg.tick);
    else if (msg.nd === 'notice') toast(msg.text);
    else if (msg.nd === 'stats') applyStats(msg.stats);
  });

  const hello = () => send('hello').then((res) => res?.state && applyState(res.state));

  // ---------- DOM ----------

  const icon = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.7v12.6a1 1 0 0 0 1.53.85l10.04-6.3a1 1 0 0 0 0-1.7L9.53 4.85A1 1 0 0 0 8 5.7Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="3.8" height="14" rx="1.1"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.1"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5.5" width="2.4" height="13" rx="1"/><path d="M19 6.6v10.8a1 1 0 0 1-1.55.83l-8.1-5.4a1 1 0 0 1 0-1.66l8.1-5.4A1 1 0 0 1 19 6.6Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="16.6" y="5.5" width="2.4" height="13" rx="1"/><path d="M5 6.6v10.8a1 1 0 0 0 1.55.83l8.1-5.4a1 1 0 0 0 0-1.66l-8.1-5.4A1 1 0 0 0 5 6.6Z"/></svg>',
    queue: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><path d="M4 6.5h12M4 11.5h12M4 16.5h7"/><path d="M15.5 14.5v5.2"/><circle cx="17.8" cy="19.4" r="2.2" class="fill"/><path d="M15.5 14.5c1.4 0 3.4.6 4.5 1.8"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><path d="M12 5.5v13M5.5 12h13"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><path d="M5.5 12.5 10 17l8.5-9.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    have: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2" class="fill"/></svg>',
    want: '<svg viewBox="0 0 24 24" aria-hidden="true" class="stroke"><path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10Z"/></svg>',
  };
  const eq = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';

  const host = document.createElement('crate-root');
  host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>.layer { display: none; }</style>
    <link rel="stylesheet" href="${chrome.runtime.getURL('src/bar.css')}">
    <div class="layer">
      <div class="floater" data-show="false">
        <div class="fl-inner">
          <button class="fl-play" type="button" aria-label="Play release">
            <span class="i i-play">${icon.play}</span><span class="i i-pause">${icon.pause}</span><span class="spinner"></span>
          </button>
          <button class="fl-add" type="button" aria-label="Add to queue">
            <span class="i i-plus">${icon.plus}</span><span class="i i-check">${icon.check}</span>
          </button>
          <button class="fl-want heart" type="button" aria-label="Add to wantlist" aria-pressed="false">${icon.want}</button>
        </div>
      </div>
      <div class="stats"></div>
      <div class="badges"></div>
      <div class="dock">
        <section class="drawer" data-open="false" aria-label="Queue">
          <header class="drawer-head">
            <span class="drawer-title">Queue</span>
            <span class="drawer-count"></span>
            <button class="text-btn clear" type="button">Clear</button>
          </header>
          <ol class="list"></ol>
          <footer class="drawer-foot"><a class="credit" href="https://www.discogs.com/">Data provided by Discogs</a></footer>
        </section>
        <div class="toast" role="status" aria-live="polite" data-show="false"></div>
        <div class="bar" data-visible="false">
          <a class="art-link" tabindex="-1"><img class="art" alt=""></a>
          <div class="meta">
            <div class="title"></div>
            <a class="sub"></a>
          </div>
          <div class="controls">
            <button class="icon-btn prev" type="button" aria-label="Previous">${icon.prev}</button>
            <button class="play" type="button" aria-label="Play">
              <span class="i i-play">${icon.play}</span><span class="i i-pause">${icon.pause}</span>
            </button>
            <button class="icon-btn next" type="button" aria-label="Next">${icon.next}</button>
          </div>
          <div class="time"><span class="cur">0:00</span><span class="dur"></span></div>
          <button class="icon-btn want-btn heart" type="button" aria-label="Add to wantlist" aria-pressed="false">${icon.want}</button>
          <button class="icon-btn queue-btn" type="button" aria-label="Queue" aria-expanded="false">
            ${icon.queue}<span class="count"></span>
          </button>
          <div class="scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
            <div class="track"><div class="hover-fill"></div><div class="fill"></div></div>
            <div class="knob-rail"><div class="knob"></div></div>
          </div>
          <div class="scrub-tip" aria-hidden="true"></div>
        </div>
      </div>
    </div>`;
  document.documentElement.append(host);

  const $ = (sel) => root.querySelector(sel);
  const el = {
    floater: $('.floater'),
    flPlay: $('.fl-play'),
    flAdd: $('.fl-add'),
    flWant: $('.fl-want'),
    wantBtn: $('.want-btn'),
    badges: $('.badges'),
    stats: $('.stats'),
    scrubTip: $('.scrub-tip'),
    dock: $('.dock'),
    drawer: $('.drawer'),
    list: $('.list'),
    drawerCount: $('.drawer-count'),
    credit: $('.credit'),
    toast: $('.toast'),
    bar: $('.bar'),
    artLink: $('.art-link'),
    art: $('.art'),
    meta: $('.meta'),
    title: $('.title'),
    sub: $('.sub'),
    play: $('.play'),
    prev: $('.prev'),
    next: $('.next'),
    cur: $('.cur'),
    dur: $('.dur'),
    queueBtn: $('.queue-btn'),
    count: $('.queue-btn .count'),
    scrub: $('.scrub'),
    hoverFill: $('.hover-fill'),
  };

  // Artwork that fails to load falls back to the placeholder gradient behind it.
  root.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement) e.target.removeAttribute('src');
  }, true);

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v; // only ever our own icon markup
      else if (k.includes('-')) node.setAttribute(k, v);
      else node[k] = v;
    }
    node.append(...children.filter((c) => c != null));
    return node;
  }

  // ---------- helpers ----------

  const current = () => state.queue[state.index];
  const currentKey = () => current()?.release.key;
  const refOf = (key) => {
    const [kind, id] = key.split(':');
    return { kind, id };
  };

  // Heart buttons: filled once the release is on the wantlist, with a small pop when it lands.
  function paintHeart(btn, key) {
    const was = btn.dataset.wanted === 'true';
    const w = state.wanted?.[key];
    const now = !!w;
    btn.dataset.wanted = String(now);
    btn.dataset.pending = String(!!w?.pending);
    btn.setAttribute('aria-pressed', String(now));
    btn.setAttribute('aria-label', now ? 'Remove from wantlist' : 'Add to wantlist');
    if (now && !was && btn.dataset.key === key && !reducedMotion.matches) {
      btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }], {
        duration: 280,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      });
    }
    btn.dataset.key = key;
  }

  function livePosition() {
    if (!state.playing || state.buffering || state.ad) return state.position;
    const pos = state.position + (Date.now() - state.at) / 1000;
    return state.duration ? Math.min(pos, state.duration) : pos;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // "Fontaines D.C. - Marianne" under artist "Fontaines D.C." reads as "Marianne".
  function trackTitle(t) {
    const artist = t.release.artist?.toLowerCase();
    let title = t.title || 'Untitled';
    if (artist && title.toLowerCase().startsWith(artist)) {
      const rest = title.slice(artist.length).replace(/^\s*[-–—:|]\s*/, '');
      if (rest && rest !== title.slice(artist.length)) title = rest;
    }
    return title;
  }

  // ---------- state ----------

  let shownUid = null;

  let firstState = true;

  function applyState(next) {
    state = next;
    // The bar is already there when you land on a page: no entrance animation on every navigation.
    if (firstState) {
      firstState = false;
      el.bar.dataset.instant = 'true';
      requestAnimationFrame(() => requestAnimationFrame(() => delete el.bar.dataset.instant));
    }
    renderBar();
    renderFloater();
    renderStatus();
    layoutBadges();
    if (drawerOpen) renderDrawer();
  }

  function applyTick(tick) {
    Object.assign(state, tick);
    renderTransport();
  }

  // ---------- bar ----------

  function renderBar() {
    const has = state.queue.length > 0;
    el.bar.dataset.visible = String(has);
    document.documentElement.classList.toggle('nd-has-bar', has);
    if (!has) {
      shownUid = null;
      if (drawerOpen) setDrawer(false);
      return;
    }
    const t = current() ?? state.queue[0];
    if (t.uid !== shownUid) {
      const swapping = shownUid !== null;
      shownUid = t.uid;
      el.title.textContent = trackTitle(t);
      el.title.title = t.title;
      el.sub.textContent = [t.release.artist, t.release.title].filter(Boolean).join(' — ');
      el.sub.href = t.release.url;
      el.artLink.href = t.release.url;
      el.credit.href = t.release.url; // Discogs' API terms: credit links to the page the data came from
      if (t.release.thumb) el.art.src = t.release.thumb;
      else el.art.removeAttribute('src');
      if (swapping && !reducedMotion.matches) {
        el.meta.animate(
          [
            { opacity: 0, filter: 'blur(2px)', transform: 'translateY(3px)' },
            { opacity: 1, filter: 'blur(0)', transform: 'none' },
          ],
          { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
        );
      }
    }
    paintHeart(el.wantBtn, t.release.key);
    const upcoming = state.queue.length - state.index - 1;
    el.count.textContent = upcoming > 0 ? String(upcoming) : '';
    el.queueBtn.setAttribute('aria-label', upcoming > 0 ? `Queue, ${upcoming} up next` : 'Queue');
    el.next.disabled = state.index >= state.queue.length - 1;
    renderTransport();
  }

  let raf = 0;
  let scrubbing = false;

  function renderTransport() {
    el.play.dataset.playing = String(state.playing);
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el.bar.dataset.buffering = String(state.playing && state.buffering);
    el.bar.dataset.ad = String(state.ad > 0);
    el.scrub.setAttribute('aria-valuemax', String(Math.round(state.duration || 0)));
    paintProgress();
    if (state.playing && !raf) raf = requestAnimationFrame(loop);
  }

  function loop() {
    raf = 0;
    paintProgress();
    if (state.playing && !document.hidden) raf = requestAnimationFrame(loop);
  }

  let lastSecond = -1;

  function paintProgress() {
    if (scrubbing) return;
    const d = state.duration || 0;
    const p = livePosition();
    setProgress(d ? Math.min(1, p / d) : 0);
    const second = state.ad ? -2 - state.ad : Math.floor(p);
    if (second === lastSecond) return;
    lastSecond = second;
    if (state.ad) {
      el.cur.textContent = `Ad · ${state.ad}s`;
      el.dur.textContent = '';
    } else {
      el.cur.textContent = fmt(p);
      el.dur.textContent = d ? fmt(d) : '';
      el.scrub.setAttribute('aria-valuenow', String(Math.floor(p)));
      el.scrub.setAttribute('aria-valuetext', `${fmt(p)} of ${fmt(d)}`);
    }
  }

  el.play.addEventListener('click', () => send('toggle'));
  el.prev.addEventListener('click', () => send('prev'));
  el.next.addEventListener('click', () => send('next'));
  el.queueBtn.addEventListener('click', () => setDrawer(!drawerOpen));
  el.wantBtn.addEventListener('click', () => {
    const t = current() ?? state.queue[0];
    if (t) send('want', { release: refOf(t.release.key) });
  });

  // Scrubbing: drag anywhere along the bottom edge; release seeks.
  function ratioAt(e) {
    const r = el.scrub.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  // One variable drives both the fill and the knob, so they never drift apart.
  function setProgress(ratio) {
    el.scrub.style.setProperty('--p', String(ratio));
  }

  function previewSeek(ratio) {
    setProgress(ratio);
    el.cur.textContent = fmt(ratio * state.duration);
  }

  // Time under the cursor, so you know where a click lands before you make it.
  function showTip(e, ratio) {
    if (!state.duration || state.ad) return hideTip();
    const bar = el.bar.getBoundingClientRect();
    const x = Math.min(bar.width - 28, Math.max(28, e.clientX - bar.left));
    el.scrubTip.textContent = fmt(ratio * state.duration);
    el.scrubTip.style.transform = `translateX(${Math.round(x)}px) translateX(-50%)`;
    el.scrubTip.dataset.show = 'true';
  }

  function hideTip() {
    el.scrubTip.dataset.show = 'false';
  }

  function seekTo(position) {
    state.position = Math.max(0, Math.min(position, state.duration || position));
    state.at = Date.now();
    lastSecond = -1;
    paintProgress();
    send('seek', { position: state.position });
  }

  el.scrub.addEventListener('pointerdown', (e) => {
    if (!state.duration || state.ad || e.button !== 0) return; // YouTube ignores seeks during ads
    scrubbing = true;
    el.bar.dataset.scrubbing = 'true';
    el.scrub.setPointerCapture(e.pointerId);
    previewSeek(ratioAt(e));
  });
  el.scrub.addEventListener('pointermove', (e) => {
    const ratio = ratioAt(e);
    el.hoverFill.style.transform = `scaleX(${ratio})`;
    showTip(e, ratio);
    if (scrubbing) previewSeek(ratio);
  });
  el.scrub.addEventListener('pointerleave', () => !scrubbing && hideTip());
  const endScrub = (e, commit) => {
    if (!scrubbing) return;
    scrubbing = false;
    el.bar.dataset.scrubbing = 'false';
    if (!el.scrub.matches(':hover')) hideTip();
    if (commit) seekTo(ratioAt(e) * state.duration);
    else paintProgress();
  };
  el.scrub.addEventListener('pointerup', (e) => endScrub(e, true));
  el.scrub.addEventListener('pointercancel', (e) => endScrub(e, false));
  el.scrub.addEventListener('keydown', (e) => {
    const stepBy = { ArrowRight: 5, ArrowLeft: -5, PageUp: 30, PageDown: -30 }[e.key];
    if (stepBy == null || !state.duration) return;
    e.preventDefault();
    seekTo(livePosition() + stepBy);
  });

  // ---------- queue drawer ----------

  let drawerOpen = false;

  function setDrawer(open) {
    drawerOpen = open;
    el.drawer.dataset.open = String(open);
    el.queueBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    renderDrawer();
    const row = el.list.querySelector('[data-current="true"]');
    if (row) el.list.scrollTop = row.offsetTop - el.list.clientHeight / 2 + row.offsetHeight / 2;
  }

  function renderDrawer() {
    const n = state.queue.length;
    el.drawerCount.textContent = `${n} ${n === 1 ? 'track' : 'tracks'}`;
    const groups = [];
    let group;
    state.queue.forEach((t, i) => {
      if (!group || group.key !== t.release.key) {
        group = { key: t.release.key, release: t.release, rows: [] };
        groups.push(group);
      }
      const isCurrent = i === state.index;
      group.rows.push(
        h(
          'li',
          {
            class: 'row',
            'data-index': String(i),
            'data-current': String(isCurrent),
            'data-played': String(i < state.index),
            'data-playing': String(isCurrent && state.playing),
          },
          h('button', { class: 'row-main', type: 'button', title: t.title },
            h('span', { class: 'num', html: isCurrent ? eq : '' }, isCurrent ? null : String(group.rows.length + 1)),
            h('span', { class: 'row-title' }, trackTitle(t)),
            h('span', { class: 'row-dur' }, t.duration ? fmt(t.duration) : ''),
          ),
          h('button', { class: 'icon-btn tiny rm', type: 'button', 'aria-label': `Remove ${trackTitle(t)}`, html: icon.x }),
        ),
      );
    });
    el.list.replaceChildren(
      ...groups.map((g) =>
        h(
          'li',
          { class: 'group', 'data-key': g.key },
          h('div', { class: 'group-head' },
            h('a', { class: 'group-art-link', href: g.release.url, tabIndex: -1 }, h('img', { class: 'group-art', alt: '', ...(g.release.thumb ? { src: g.release.thumb } : {}) })),
            h('div', { class: 'group-meta' },
              h('a', { class: 'group-title', href: g.release.url }, g.release.title || ''),
              h('div', { class: 'group-artist' }, g.release.artist || ''),
            ),
            h('button', { class: 'icon-btn tiny rm-group', type: 'button', 'aria-label': `Remove ${g.release.title}`, html: icon.x }),
          ),
          h('ol', { class: 'rows' }, ...g.rows),
        ),
      ),
    );
  }

  el.list.addEventListener('click', (e) => {
    const rm = e.target.closest('.rm');
    const rmGroup = e.target.closest('.rm-group');
    const main = e.target.closest('.row-main');
    if (rm) {
      const t = state.queue[Number(rm.closest('.row').dataset.index)];
      if (t) send('remove', { uid: t.uid });
    } else if (rmGroup) {
      send('removeRelease', { key: rmGroup.closest('.group').dataset.key });
    } else if (main) {
      const index = Number(main.closest('.row').dataset.index);
      if (index === state.index) send('toggle');
      else send('jump', { index });
    }
  });
  root.querySelector('.clear').addEventListener('click', () => send('clear'));

  document.addEventListener('pointerdown', (e) => {
    if (drawerOpen && !e.composedPath().includes(el.dock)) setDrawer(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) setDrawer(false);
  });

  // ---------- toast ----------

  // One line above the bar. Notices show for a few seconds; a loading status stays until it's done.
  let toastTimer = 0;
  function toast(text) {
    el.toast.dataset.loading = 'false';
    el.toast.textContent = text;
    el.toast.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      renderStatus();
    }, 2800);
  }

  function renderStatus() {
    if (toastTimer) return; // a notice is showing; the status comes back after it
    if (state.status) {
      el.toast.dataset.loading = 'true';
      el.toast.textContent = state.status;
      el.toast.dataset.show = 'true';
    } else {
      el.toast.dataset.show = 'false';
    }
  }

  // ---------- cover controls ----------

  function coverFrom(node) {
    if (!(node instanceof Element) || host.contains(node)) return null;
    const card = node.closest('.hifi-catalog-listing-card');
    const a = card?.querySelector('a.hifi-catalog-listing-card-image') ?? node.closest('a[href*="/release/"], a[href*="/master/"]');
    const img = a?.querySelector('img');
    if (!img) return null;
    const path = new URL(a.href, location.href).pathname;
    const m = path.match(ID_RE);
    if (!m) return null;
    return {
      zone: card ?? a,
      a,
      img,
      key: `${m[1]}:${m[2]}`,
      ref: { kind: m[1], id: m[2], url: path, thumb: img.currentSrc || img.src },
    };
  }

  let hover = null;
  let hideTimer;
  let intentTimer;
  let lastWarm = 0;

  function showFloater(c) {
    clearTimeout(hideTimer);
    if (hover?.img === c.img) return;
    const rect = c.img.getBoundingClientRect();
    if (rect.width < MIN_COVER || rect.height < MIN_COVER) return;
    hover = c;
    placeFloater();
    renderFloater();
    el.floater.dataset.show = 'true';

    // Hover intent: resolve the release before the click, and wake the player.
    clearTimeout(intentTimer);
    intentTimer = setTimeout(() => {
      if (hover !== c) return;
      send('prefetch', { release: c.ref });
      if (Date.now() - lastWarm > 25_000) {
        lastWarm = Date.now();
        send('warm');
      }
    }, 90);
  }

  function hideFloater() {
    hover = null;
    el.floater.dataset.show = 'false';
    // Once faded, park it at the top so a stale spot never stretches a page that got shorter.
    hideTimer = setTimeout(() => {
      if (!hover) el.floater.style.transform = '';
    }, 120);
  }

  function hideFloaterSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideFloater, 60);
  }

  function placeFloater() {
    if (!hover) return;
    if (!hover.img.isConnected) return hideFloater();
    const r = hover.img.getBoundingClientRect();
    const compact = r.width < 132;
    el.floater.dataset.compact = String(compact);
    el.floater.dataset.tiny = String(r.width < 110);
    const inset = compact ? 6 : 10;
    const size = compact ? 32 : 44;
    el.floater.style.transform = `translate(${Math.round(r.left + scrollX + inset)}px, ${Math.round(r.bottom + scrollY - inset - size)}px)`;
  }

  function renderFloater() {
    if (!hover) return;
    const key = hover.key;
    const isCurrent = key === currentKey();
    const loading = state.loadingKey === key;
    el.floater.dataset.state = loading ? 'loading' : isCurrent ? (state.playing ? 'playing' : 'paused') : 'idle';
    el.flPlay.setAttribute('aria-label', isCurrent && state.playing ? 'Pause' : 'Play release');
    const queued = state.queue.some((t) => t.release.key === key);
    el.floater.dataset.queued = String(queued);
    el.flAdd.setAttribute('aria-label', queued ? 'In your queue' : 'Add to queue');
    paintHeart(el.flWant, key);
  }

  document.addEventListener('pointerover', (e) => {
    if (dead) return;
    const c = coverFrom(e.target);
    if (c) showFloater(c);
  }, { passive: true });

  document.addEventListener('pointerout', (e) => {
    if (!hover) return;
    const to = e.relatedTarget;
    if (to === host || (to instanceof Node && hover.zone.contains(to))) return;
    hideFloaterSoon();
  }, { passive: true });

  el.floater.addEventListener('pointerleave', (e) => {
    const to = e.relatedTarget;
    if (hover && to instanceof Node && hover.zone.contains(to)) return;
    hideFloaterSoon();
  });

  el.flPlay.addEventListener('click', () => {
    if (!hover) return;
    if (hover.key === currentKey()) send('toggle');
    else send('play', { release: hover.ref });
  });

  el.flWant.addEventListener('click', () => hover && send('want', { release: hover.ref }));

  el.flAdd.addEventListener('click', () => {
    if (!hover) return;
    if (el.floater.dataset.queued === 'true') return toast('Already in your queue');
    send('queue', { release: hover.ref });
  });

  // Keyboard: with a cover focused, P plays, Q queues and W toggles the wantlist.
  document.addEventListener('focusin', (e) => {
    const c = coverFrom(e.target);
    if (c && e.target.matches(':focus-visible')) showFloater(c);
  });
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const key = e.key.toLowerCase();
    if (key !== 'p' && key !== 'q' && key !== 'w') return;
    const c = coverFrom(document.activeElement);
    if (!c) return;
    e.preventDefault();
    if (key === 'p') send(c.key === currentKey() ? 'toggle' : 'play', { release: c.ref });
    else if (key === 'w') send('want', { release: c.ref });
    else send('queue', { release: c.ref });
  });

  // ---------- what's actually visible ----------
  // A cover can be inside the window yet hidden by a carousel or scroller around it (the
  // Recommendations row on release pages). Those clipping ancestors are found once per cover.

  const clippers = new WeakMap();

  function clippingAncestors(img) {
    let list = clippers.get(img);
    if (list) return list;
    list = [];
    for (let n = img.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') list.push(n);
    }
    clippers.set(img, list);
    return list;
  }

  // How a cover sits on screen: `shown` when nearly all of it is visible, `near` when it's in no
  // clipped-away spot and within `margin` px above or below the window (worth loading ahead).
  function placement(img, r, margin = 0) {
    let left = 0;
    let right = innerWidth;
    let top = -margin;
    let bottom = innerHeight + margin;
    for (const n of clippingAncestors(img)) {
      const c = n.getBoundingClientRect();
      left = Math.max(left, c.left);
      right = Math.min(right, c.right);
      top = Math.max(top, c.top - (c.height > innerHeight ? margin : 0));
      bottom = Math.min(bottom, c.bottom + (c.height > innerHeight ? margin : 0));
    }
    const wide = Math.min(r.right, right) - Math.max(r.left, left) >= r.width * 0.9;
    const near = wide && r.bottom > top && r.top < bottom;
    const shown = near && r.bottom > 0 && r.top < innerHeight && r.top >= top - 1 && r.bottom <= bottom + r.height * 0.5;
    return { near, shown };
  }

  // ---------- now-playing badges on visible covers ----------

  function layoutBadges() {
    const key = currentKey();
    if (!key) return el.badges.replaceChildren();
    const [kind, id] = key.split(':');
    const covers = [];
    for (const a of document.querySelectorAll(`a[href*="/${kind}/${id}"]`)) {
      const img = a.querySelector('img');
      if (!img || !new URL(a.href, location.href).pathname.match(new RegExp(`/${kind}/${id}(?:\\D|$)`))) continue;
      const r = img.getBoundingClientRect();
      if (r.width < MIN_COVER || !placement(img, r).shown) continue;
      covers.push(r);
      if (covers.length === 8) break;
    }
    const nodes = covers.map((r, i) => {
      const b = el.badges.children[i] ?? h('button', { class: 'badge', type: 'button', html: eq });
      b.style.transform = `translate(${Math.round(r.left + scrollX + 8)}px, ${Math.round(r.top + scrollY + 8)}px)`;
      b.dataset.playing = String(state.playing);
      b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
      return b;
    });
    el.badges.replaceChildren(...nodes);
  }

  el.badges.addEventListener('click', (e) => {
    if (e.target.closest('.badge')) send('toggle');
  });

  // ---------- have / want on covers ----------
  // Counts come from the background, which loads what's on screen first and caches for six hours.

  const stats = new Map(); // key -> { have, want, more }
  const asked = new Map(); // key -> when we last asked
  const pills = new Map(); // key -> element
  const lineWidths = new WeakMap(); // pill -> its width on one line
  let showStats = true;

  chrome.storage.sync.get({ showStats: true }).then((r) => {
    showStats = r.showStats;
    queueLayout();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.showStats) return;
    showStats = changes.showStats.newValue !== false;
    if (!showStats) {
      pills.forEach((p) => p.remove());
      pills.clear();
    }
    queueLayout();
  });

  function applyStats(found) {
    for (const [key, value] of Object.entries(found)) stats.set(key, value);
    queueLayout();
  }

  const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const fullNumber = new Intl.NumberFormat('en');

  function pillFor(key, s) {
    let pill = pills.get(key);
    if (pill && (pill.dataset.pending !== 'true' || !s)) return pill;
    pill?.remove();
    if (!s) {
      // Counts are on their way: a quiet placeholder, so an empty corner doesn't read as "nothing".
      pill = h('div', { class: 'stat', 'data-pending': 'true', title: 'Loading have / want…' },
        h('span', { class: 'stat-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      );
      pills.set(key, pill);
      el.stats.append(pill);
      return pill;
    }
    const plus = s.more ? '+' : '';
    pill = h(
      'div',
      {
        class: 'stat',
        'data-hot': String(s.want > s.have && s.want > 0),
        title: `${fullNumber.format(s.have)}${plus} have · ${fullNumber.format(s.want)}${plus} want`,
      },
      h('span', { class: 'stat-item' }, h('span', { class: 'stat-icon', html: icon.have }), compactNumber.format(s.have) + plus),
      h('span', { class: 'stat-item want' }, h('span', { class: 'stat-icon', html: icon.want }), compactNumber.format(s.want) + plus),
    );
    pills.set(key, pill);
    el.stats.append(pill);
    return pill;
  }

  let statsTimer;
  let pendingRefs = new Map();

  function layoutStats() {
    if (!showStats || dead) return;
    const seen = new Set();
    const margin = innerHeight / 2; // a little look-ahead so counts are there when you scroll
    for (const a of document.querySelectorAll('a[href*="/release/"], a[href*="/master/"]')) {
      const img = a.querySelector('img');
      if (!img) continue;
      const r = img.getBoundingClientRect();
      if (r.width < MIN_COVER || r.bottom < -margin || r.top > innerHeight + margin) continue;
      const where = placement(img, r, margin);
      if (!where.near) continue; // clipped away by a carousel: don't load it, don't show it
      const path = new URL(a.href, location.href).pathname;
      const m = path.match(ID_RE);
      if (!m) continue;
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const s = stats.get(key);
      if (!s) {
        const distance = r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0;
        if (Date.now() - (asked.get(key) ?? 0) > 15_000) pendingRefs.set(key, { kind: m[1], id: m[2], distance });
      }
      const onScreen = where.shown;
      // Top-right corner: the play controls own the bottom, the now-playing badge the top-left.
      const pill = pillFor(key, s);
      pill.dataset.show = String(onScreen);
      if (onScreen) {
        // List views have narrow thumbnails: stack the counts rather than spill off the cover.
        if (!lineWidths.has(pill)) lineWidths.set(pill, pill.offsetWidth);
        const stack = lineWidths.get(pill) > r.width - 16;
        pill.dataset.stack = String(stack);
        const inset = stack ? 4 : 8;
        // A stacked pill can still be a hair wide on the smallest covers: never past the cover's left edge.
        const right = stack ? Math.max(r.right - inset, r.left + pill.offsetWidth) : r.right - inset;
        pill.style.transform = `translate(${Math.round(right + scrollX)}px, ${Math.round(r.top + scrollY + inset)}px) translate(-100%, 0)`;
      }
    }
    for (const [key, pill] of pills) if (!seen.has(key)) pill.dataset.show = 'false';

    if (pendingRefs.size) {
      clearTimeout(statsTimer);
      statsTimer = setTimeout(() => {
        const refs = [...pendingRefs.values()].sort((a, b) => a.distance - b.distance);
        pendingRefs = new Map();
        refs.forEach((ref) => asked.set(`${ref.kind}:${ref.id}`, Date.now()));
        send('stats', { refs: refs.map(({ kind, id }) => ({ kind, id })) });
      }, 150);
    }
  }

  // ---------- keeping overlays glued to the page ----------

  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued || dead) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      placeFloater();
      layoutBadges();
      layoutStats();
    });
  }
  addEventListener('scroll', queueLayout, { passive: true, capture: true });
  addEventListener('resize', queueLayout, { passive: true });
  const observer = new MutationObserver(queueLayout);
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    hello();
    if (state.playing && !raf) raf = requestAnimationFrame(loop);
  });

  // The extension was reloaded or removed: get out of the page cleanly.
  function teardown() {
    if (dead) return;
    dead = true;
    observer.disconnect();
    cancelAnimationFrame(raf);
    host.remove();
    document.documentElement.classList.remove('nd-has-bar');
  }

  setInterval(() => !document.hidden && queueLayout(), 15_000);

  hello();
})();
