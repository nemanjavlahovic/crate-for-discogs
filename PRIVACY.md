# Crate privacy policy

Last updated: November 22, 2026

Crate: Record Player for Discogs is a Chrome extension. It has no server of its own, no analytics and no ads, and it never sells or shares your data.

## What it stores, and where

Everything stays in Chrome's extension storage on your device:

- **Your Discogs personal access token**, if you add one in the popup. It is used only to call the Discogs API on your behalf (to check which account it belongs to, to add and remove releases on your wantlist, and to raise the API rate limit). It is stored on this device only and is not synced.
- **Settings**: whether have/want counts are shown on covers. This is synced through your Chrome profile, like any extension setting.
- **Your queue and which releases you added to your wantlist through Crate**, so the player picks up where it left off.
- **A short-lived cache** of release details, YouTube video IDs and have/want counts from Discogs. Entries are deleted after 6 hours.

## Who it talks to

- **Discogs** (`api.discogs.com`): to look up releases, their videos and community counts, and to edit your wantlist. Requests carry your token if you added one. See the [Discogs privacy policy](https://www.discogs.com/company/privacy-policy).
- **YouTube** (`youtube.com`): to play videos, through YouTube's embedded player or a pinned youtube.com tab. YouTube sees what you play, as it would on youtube.com, and you are signed in with your own YouTube account. See the [Google privacy policy](https://policies.google.com/privacy).

Crate reads the Discogs pages you visit only to find the record covers on them. On youtube.com video pages it only checks whether the tab is its own player tab, and does nothing in any other tab. It doesn't read or record anything else, on those pages or any other site.

## Removing your data

Remove the extension, or clear the token field in its popup. Removing the extension deletes everything it stored.

## Contact

Open an issue at https://github.com/nemanjavlahovic/crate-for-discogs.
