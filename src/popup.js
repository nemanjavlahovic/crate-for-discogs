// Settings: have/want overlay (synced, on by default) and the Discogs token (this device only).
const showStats = document.getElementById('showStats');
const token = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.sync.get({ showStats: true }).then((r) => (showStats.checked = r.showStats));
chrome.storage.local.get({ token: '' }).then((r) => {
  token.value = r.token;
  check(r.token);
});

showStats.addEventListener('change', () => chrome.storage.sync.set({ showStats: showStats.checked }));

let timer;
token.addEventListener('input', () => {
  const value = token.value.trim();
  chrome.storage.local.set({ token: value });
  clearTimeout(timer);
  timer = setTimeout(() => check(value), 400);
});

// Confirm which account the token belongs to, so you know the heart writes to the right wantlist.
async function check(value) {
  if (!value) return show('', '');
  show('Checking…', 'pending');
  try {
    const res = await fetch('https://api.discogs.com/oauth/identity', {
      headers: { Authorization: `Discogs token=${value}` },
    });
    if (token.value.trim() !== value) return; // changed while we were asking
    if (!res.ok) return show('Discogs didn’t accept this token', 'bad');
    const me = await res.json();
    show(`Connected as ${me.username}`, 'good');
  } catch {
    show('Couldn’t reach Discogs', 'bad');
  }
}

function show(text, tone) {
  status.textContent = text;
  status.dataset.tone = tone;
}
