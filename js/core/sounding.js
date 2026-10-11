// "What your keyboard is playing": pages that play notes from the keyboard tell the Recorder which
// sound they played them with, so a take keeps the sound it was played on. A sound is one of
//   { kind: 'xl', name, data }                 a microKORG XL program (its bytes)
//   { kind: 'lab', name, patch }               a Lab instrument
//   { kind: 'voice', name, voice }             one of the sequencer's test voices
//   { kind: 'midi', name, out, ch, program }   other MIDI gear (its port, channel, program)
// Posted on BroadcastChannel('mkxl') as { type: 'sounding', from, wall, sound }.

// A short fingerprint of a sound, to tell sounds apart without comparing them in full.
export function soundKey(sound) {
  const text = JSON.stringify(sound);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${sound.kind}:${h.toString(36)}`;
}

// Returns report(sound): posts it when it changes, and again every few seconds while playing
// (so a Recorder that just loaded learns it too).
export function soundReporter(channel, from) {
  let last = '', at = 0;
  return sound => {
    if (!sound || !channel) return;
    const key = soundKey(sound), now = Date.now();
    if (key === last && now - at < 5000) return;
    last = key; at = now;
    channel.postMessage({ type: 'sounding', from, wall: Math.round(performance.timeOrigin + performance.now()), sound });
  };
}
