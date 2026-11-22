<img src="assets/brand/logo.svg" width="72" alt="">

# Crate: Record Player for Discogs

Play any release straight from Discogs Explore. Hover a cover and press play, or `+` to queue it. One player sits at the bottom of the page and keeps playing while you browse.

## Install

Install it from the Chrome Web Store (link coming once the listing is approved), or load it from source:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open [Discogs Explore](https://www.discogs.com/search/?type=all) and hover a cover.

## Using it

- **Cover controls:** play the release now (it goes in after the current track), `+` to add it to the end of the queue, or ♡ to put it on your wantlist. If a cover link has keyboard focus, `P` plays, `Q` queues and `W` toggles the wantlist.
- **Wantlist:** the heart is on the cover controls and on the bar (for whatever's playing). It needs your Discogs token, which you add in the popup. A release card adds exactly that release. A master adds its key release, unless that's a promo, test pressing, white label or unofficial, in which case it adds the earliest version that isn't. A message says which version was added, and clicking the heart again removes it.
- **Bar:** previous (restarts the track if you're more than 3s in), play/pause, next. The track along the bottom of the bar is the seek strip; its knob marks the playhead. Hover it to see the time under the cursor, then click, or drag the knob. The arrow keys also seek when the strip has focus.
- **Have / want:** every cover shows its community counts (a master shows the totals across its versions). The want count turns amber when more people want a record than have it. Turn this off, or add a Discogs token for faster loading, from the toolbar popup.
- **Queue:** the list button opens the queue, grouped by release; the number beside it is how many tracks are up next. Click a track to jump to it; hover to remove a track or a whole release.

## How it works

| Piece | Job |
| --- | --- |
| `src/background.js` | Owns the queue. Turns releases into YouTube videos using the Discogs API (curated `videos`, falling back from master to main release). Results are cached for 6 hours, the longest Discogs' API terms allow. Drives the two engines below. |
| `src/offscreen.js` | **Embed engine.** A hidden extension page that keeps one YouTube embed alive. Page navigation never interrupts it, and switching tracks takes about 0.4s. |
| `src/yt-tab.js` | **Tab engine.** For videos whose owners turned off embedding, the background plays them in a pinned youtube.com tab. |
| `src/content.js` + `bar.css` | All UI, in one shadow root floating over Discogs. Discogs's own markup is never edited, so its React app can't break the overlay and the overlay can't break Discogs. |

**Why it stays signed in to YouTube:** a YouTube embed on an ordinary website is a third-party frame. Chrome withholds YouTube's main sign-in cookies from it (SID/HSID/SSID are SameSite=Lax), and blocks all of them when third-party cookies are off. That's why embeds keep acting signed out. Crate's embed lives in an extension page that has youtube.com host access, and Chrome treats that as first-party.

Measured with Chrome set to block third-party cookies:

| Embed | SameSite=None cookie | SameSite=Lax cookie |
| --- | --- | --- |
| Ordinary website | blocked | blocked |
| Crate player | sent | sent |

YouTube refuses embeds that arrive with no `Referer` header (error 153). A session rule therefore adds one, only to embed requests that come from outside any tab, which means only Crate's own player.

## Known limits

- Without YouTube Premium you'll hear YouTube's ads. The bar shows them as `Ad · 12s`.
- Discogs allows 25 API calls a minute without a token, or 60 with one (add it in the popup). For the covers in view, nearest first and five requests at a time, Crate loads the have/want counts and then each cover's videos, so a click goes straight to YouTube. Clicks always come first: background loading pauses while one is loading and never uses the last 8 calls of the minute. With a token, a 24-cover page has every count in about 2s and every cover's videos in about 2.5s. Without one, counts still arrive within a second or two, but the videos for a full page can spill into the next minute. Covers still waiting show a dotted placeholder, and covers hidden inside carousels aren't loaded until they scroll into view. Counts and videos are cached for 6 hours, the longest Discogs' API terms allow, so a page you come back to later loads again.
- If Discogs rate-limits a click anyway, a line above the bar counts down to the retry instead of failing.
- No drag-to-reorder, volume slider or media-key support yet.

## Debugging

Open the service worker from `chrome://extensions` → *Inspect views*. `crate.state` shows the live queue, and `crate.handleUi({ type: 'next' })` drives the player directly.

## Privacy

Crate has no server and collects nothing. Your Discogs token, settings, queue and cache stay in Chrome's storage on your device, and Crate only talks to Discogs and YouTube. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)

Crate uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. 'Discogs' is a trademark of Zink Media, LLC. Crate isn't affiliated with or endorsed by YouTube either; it plays videos through YouTube's embedded player.
