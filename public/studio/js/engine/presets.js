// Presets are expressed in the same 0–100 control scale the interface shows.
export const DEFAULTS = { strength: 100, noise: 100, echo: 50, background: 4, clarity: 50, warmth: 50, deess: 50, evening: 60, target: -16, ceiling: -1, hp: 80, tier: 'standard', repair: true };

export const PRESETS = {
  auto:      { name: 'Auto', icon: '✦', hint: 'Listens to the file and picks the settings' },
  podcast:   { name: 'Podcast', icon: '🎙', hint: 'Close, warm studio voice at −16 LUFS', noise: 100, echo: 60, background: 4, clarity: 55, warmth: 55, deess: 50, evening: 60, target: -16 },
  interview: { name: 'Interview', icon: '💬', hint: 'Two voices brought to the same level', noise: 100, echo: 50, background: 6, clarity: 50, warmth: 45, deess: 45, evening: 80, target: -16 },
  youtube:   { name: 'YouTube narration', icon: '▶', hint: 'Forward and crisp at −14 LUFS', noise: 100, echo: 60, background: 4, clarity: 65, warmth: 50, deess: 55, evening: 70, target: -14 },
  lecture:   { name: 'Lecture or classroom', icon: '🎓', hint: 'Strong room-echo removal for big rooms', noise: 90, echo: 85, background: 8, clarity: 60, warmth: 45, deess: 40, evening: 70, target: -16 },
  audiobook: { name: 'Audiobook', icon: '📖', hint: 'Natural, quiet background, ACX-friendly peaks', noise: 100, echo: 70, background: 2, clarity: 45, warmth: 55, deess: 50, evening: 50, target: -20, ceiling: -3 },
  phone:     { name: 'Phone or Zoom call', icon: '📞', hint: 'Restores body to thin call audio', noise: 100, echo: 45, background: 3, clarity: 40, warmth: 70, deess: 30, evening: 60, target: -16, hp: 110 },
  singing:   { name: 'Singing or vocal', icon: '🎵', hint: 'Light cleanup that keeps dynamics and tails', noise: 70, echo: 25, background: 10, clarity: 45, warmth: 45, deess: 35, evening: 25, target: -14, hp: 70 },
  music:     { name: 'Music-friendly', icon: '🎧', hint: 'Gentle: keeps music and ambience', noise: 40, echo: 0, background: 40, clarity: 25, warmth: 25, deess: 20, evening: 10, target: -14, hp: 40, repair: false },
  custom:    { name: 'Custom', icon: '⚙', hint: 'Your own settings' },
};

/** Auto: choose settings from the analysis numbers. Returns { controls, reasons }. */
export function autoControls(a) {
  const c = { ...DEFAULTS }, why = [];
  const snr = a.snrDb;
  c.noise = snr < 20 ? 100 : snr < 35 ? 90 : snr < 50 ? 70 : 45;
  why.push(`background noise is ${snr < 20 ? 'strong' : snr < 35 ? 'clear' : snr < 50 ? 'light' : 'very low'} (speech ${snr.toFixed(0)} dB above it)`);
  c.echo = a.rt60 > 0.6 ? 90 : a.rt60 > 0.4 ? 65 : a.rt60 > 0.3 ? 40 : 15;
  why.push(`room echo about ${a.rt60.toFixed(2)} s`);
  if (a.bandwidthHz && a.bandwidthHz < 5500) { c.warmth = 65; c.clarity = 40; c.hp = 100; why.push('phone-quality bandwidth, so adding body instead of treble'); }
  else if (a.tiltDbPerOct < -9) { c.clarity = 65; why.push('dull top end, so adding clarity'); }
  if (a.speechFraction < 0.15) { Object.assign(c, { noise: 40, echo: 0, background: 40, evening: 10, clarity: 25, warmth: 25 }); why.push('little speech found, so using gentle music-friendly settings'); }
  return { controls: c, reasons: why };
}

export function presetControls(key, base = DEFAULTS) {
  const p = PRESETS[key] || {}; const c = { ...base };
  for (const k of Object.keys(DEFAULTS)) if (p[k] !== undefined) c[k] = p[k];
  return c;
}

/** Translate 0–100 controls + analysis into stage parameters. */
export function stageParams(c, a = {}) {
  const hasTop = !a.bandwidthHz || a.bandwidthHz >= 12000;
  return {
    hp: c.hp ?? 80,
    denoise: c.noise / 100, rnMix: c.rnMix ?? 0.35,
    echo: c.echo > 0 ? (1.0 * c.echo) / 100 : 0,
    rt60: Math.max(0.3, a.rt60 || 0.5),
    background: c.background / 100,
    presenceDb: (c.clarity / 100) * 5, airDb: hasTop ? (c.clarity / 100) * 4 : 0,
    warmthDb: (c.warmth / 100) * 5, mudDb: -(c.warmth / 100) * 4,
    deess: c.deess / 100,
    level: c.evening / 100, compRatio: 1 + (3 * c.evening) / 100, gateDb: (c.evening / 100) * 14,
    target: c.target, ceiling: c.ceiling, strength: c.strength / 100,
    humHz: a.humHz || 0, repair: c.repair !== false, clipLevel: a.clipping > 20 && a.clipLevel ? a.clipLevel * 0.999 : 1.01,
    speechDb: isFinite(a.speechDb) ? a.speechDb : -26, tier: c.tier || 'standard',
  };
}
