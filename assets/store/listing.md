# Chrome Web Store listing

The text for each field in the developer dashboard. The name and summary come from `manifest.json`.

## Store listing

**Category:** Entertainment
**Language:** English

**Description:**

Play any record on Discogs without leaving the page.

Hover a cover on Discogs Explore, search or any list and press play. Crate finds the release's videos on Discogs and plays them in one player bar at the bottom of the page. It keeps playing while you browse, so you can listen to one record and look for the next.

• Play a release now, or press + to queue it
• One queue for everything, grouped by release, with skip, seek and remove
• Have/want counts on every cover, with the want count in amber when more people want a record than have it
• A heart on every cover and on the player to add a release to your Discogs wantlist (needs a free Discogs token)
• Keyboard shortcuts: P to play, Q to queue, W for the wantlist
• Videos play signed in to your own YouTube account, including YouTube Premium, so you hear no ads if you have it

Crate has no server and collects nothing. Your settings and token stay in Chrome on your device. The source code is open: https://github.com/nemanjavlahovic/crate-for-discogs

Crate uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. 'Discogs' is a trademark of Zink Media, LLC. Crate plays videos through YouTube's embedded player and isn't affiliated with or endorsed by YouTube.

**Graphics:**
- Store icon: `assets/store/icon-128.png`
- Screenshots (1280x800): `assets/store/screenshot-*.png`
- Small promo tile: `assets/store/promo-small-440x280.png`
- Marquee promo tile: `assets/store/promo-marquee-1400x560.png`

**Website:** https://github.com/nemanjavlahovic/crate-for-discogs
**Support:** https://github.com/nemanjavlahovic/crate-for-discogs/issues

## Privacy practices

**Single purpose:** Play the YouTube videos of Discogs releases from the Discogs website, in one queue and player bar.

**Permission justifications:**
- `offscreen`: Hosts the YouTube embedded player in an offscreen document, so playback keeps going when you move between Discogs pages.
- `storage`: Saves the queue, settings, the optional Discogs token and a 6-hour cache of release details and counts.
- `declarativeNetRequestWithHostAccess`: Adds a Referer header to YouTube embed requests made by the extension's own offscreen player. YouTube refuses embeds that arrive without one (error 153). The rule only matches requests from outside any tab, so it never touches pages you open.
- Host permissions:
  - `discogs.com` shows the player and cover controls on Discogs pages.
  - `api.discogs.com` looks up releases, videos and have/want counts, and edits the wantlist.
  - `youtube.com` plays videos, in the embedded player or in a pinned youtube.com tab for videos whose owners turned off embedding.

**Remote code:** No, I am not using remote code. The YouTube player runs in an iframe from youtube.com, and the extension doesn't load or run code from it.

**Data usage:**
- Tick **Authentication information** only, for the optional Discogs personal access token. It is stored on the device and sent only to api.discogs.com.
- Leave everything else unticked.
- Certify all three: no selling to third parties, no use unrelated to the single purpose, no use for creditworthiness or lending.

**Privacy policy URL:** https://github.com/nemanjavlahovic/crate-for-discogs/blob/main/PRIVACY.md

## Distribution

Free, public, all regions.
