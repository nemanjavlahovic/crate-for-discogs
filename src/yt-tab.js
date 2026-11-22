// Tab engine: runs on youtube.com/watch, but only acts in the pinned tab the background opened.
// A real youtube.com tab is first-party, so it is always signed in and plays videos that block embedding.
(() => {
  const send = (msg) =>
    chrome.runtime
      .sendMessage({ target: 'bg', from: 'tab', videoId: new URLSearchParams(location.search).get('v'), ...msg })
      .catch(() => {});

  send({ type: 'hello' }).then((res) => res?.player && attach());

  function attach() {
    let video;
    let last = 0;
    const isAd = () => !!document.querySelector('.html5-video-player.ad-showing');

    const status = () => {
      if (!video || isAd()) return;
      last = Date.now();
      send({
        type: 'status',
        t: video.currentTime,
        d: video.duration || 0,
        playing: !video.paused,
        buffering: !video.paused && video.readyState < 3,
      });
    };

    const bind = (v) => {
      video = v;
      for (const ev of ['playing', 'pause', 'waiting', 'loadedmetadata', 'seeked']) v.addEventListener(ev, status);
      v.addEventListener('timeupdate', () => Date.now() - last > 1000 && status());
      v.addEventListener('ended', () => !isAd() && send({ type: 'ended' }));
      if (v.paused) v.play().catch(() => {});
      status();
    };

    const find = () => {
      const v = document.querySelector('video.html5-main-video');
      v ? bind(v) : setTimeout(find, 100);
    };
    find();

    // A consent dialog, sign-in wall or autoplay block keeps the video from starting.
    // Only a person can clear those, so ask for one instead of hanging silently.
    setTimeout(() => {
      if (isAd() || (video && (!video.paused || video.currentTime > 0.5))) return;
      send({ type: 'blocked' });
    }, 6000);

    chrome.runtime.onMessage.addListener((msg) => {
      if (!video) return;
      if (msg.cmd === 'play') video.play().catch(() => {});
      if (msg.cmd === 'pause') video.pause();
      if (msg.cmd === 'seek') video.currentTime = msg.t;
    });
  }
})();
