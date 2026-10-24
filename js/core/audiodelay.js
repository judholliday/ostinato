// How long sound takes to come out after a note starts: the AudioContext's own buffer
// (baseLatency) plus what the output device adds (outputLatency: Bluetooth headphones add
// 100-250 ms, some audio interfaces tens of ms). Shown beside the keyboard input so a slow output
// is visible, with what to do about it. Browsers that don't report outputLatency show only the first.
export function audioDelayMs(ac) {
  if (!ac || ac.state !== 'running') return null;
  return Math.round(((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000);
}
// Fills `el` (a small pill) with the delay, warning when it's long enough to feel. Updates every few
// seconds, since the output device can change (headphones connected or not).
export function showAudioDelay(el, ac) {
  if (!el) return;
  const paint = () => {
    const ms = audioDelayMs(typeof ac === 'function' ? ac() : ac);
    el.hidden = ms === null;
    if (ms === null) return;
    const slow = ms > 40;
    el.textContent = `Sound out ${ms} ms`;
    el.classList.toggle('warn', slow);
    el.title = slow
      ? `Sound comes out about ${ms} ms after you play, long enough to feel. It's the output device: Bluetooth headphones and speakers add 100-250 ms. Wired headphones, the Mac's speakers, or an audio interface set to a small buffer (64-128 samples) bring it down.`
      : `Sound comes out about ${ms} ms after you play (the browser's audio buffer plus the output device).`;
  };
  paint();
  setInterval(paint, 3000);
}
