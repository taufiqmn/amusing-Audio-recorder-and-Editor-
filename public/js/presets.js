// Enhancement presets. Values are designed around a signal pre-levelled to -20 LUFS.
// denoise: 0..1 AI noise removal strength; gate: extra attenuation of pauses (dB);
// deess: 0..1; eq in dB; comp threshold in dBFS (peak detector) and ratio;
// target: integrated loudness in LUFS; ceiling: peak ceiling in dBFS.

export const PRESETS = {
  podcast: {
    name: 'Podcast', hint: 'Clear, close voice at −16 LUFS',
    hp: 80, denoise: 1, gate: 10, deess: 0.5,
    warmth: 1.5, mud: -2.5, presence: 2.5, air: 2,
    compThr: -14, compRatio: 3, target: -16, ceiling: -1.5,
  },
  youtube: {
    name: 'YouTube & video', hint: 'Forward and punchy at −14 LUFS',
    hp: 85, denoise: 1, gate: 10, deess: 0.55,
    warmth: 1, mud: -2.5, presence: 3, air: 2.5,
    compThr: -15, compRatio: 3.5, target: -14, ceiling: -1,
  },
  audiobook: {
    name: 'Audiobook', hint: 'Natural, quiet room tone, ACX-friendly peaks',
    hp: 80, denoise: 0.9, gate: 14, deess: 0.4,
    warmth: 1, mud: -2, presence: 1.5, air: 1,
    compThr: -14, compRatio: 2.5, target: -20, ceiling: -3.5,
  },
  radio: {
    name: 'Warm radio', hint: 'Rich low end, dense and smooth',
    hp: 70, denoise: 1, gate: 8, deess: 0.6,
    warmth: 3.5, mud: -1.5, presence: 3, air: 1,
    compThr: -18, compRatio: 4.5, target: -16, ceiling: -1,
  },
  rescue: {
    name: 'Phone & laptop mic fix', hint: 'Removes room noise, restores body',
    hp: 120, denoise: 1, gate: 14, deess: 0.3,
    warmth: 2.5, mud: -3, presence: 1, air: 3.5,
    compThr: -16, compRatio: 3, target: -16, ceiling: -1.5,
  },
  light: {
    name: 'Light touch', hint: 'Gentle cleanup, keeps the room',
    hp: 70, denoise: 0.6, gate: 0, deess: 0.25,
    warmth: 0, mud: -1, presence: 1, air: 0.5,
    compThr: -10, compRatio: 2, target: -16, ceiling: -1.5,
  },
  level: {
    name: 'Volume only', hint: 'No cleanup, just consistent loudness',
    hp: 0, denoise: 0, gate: 0, deess: 0,
    warmth: 0, mud: 0, presence: 0, air: 0,
    compThr: -12, compRatio: 1.5, target: -16, ceiling: -1.5,
  },
};

export const LOUDNESS_TARGETS = [
  { value: -14, label: '−14 LUFS (YouTube, Spotify)' },
  { value: -16, label: '−16 LUFS (Podcasts, Apple)' },
  { value: -19, label: '−19 LUFS (Mono podcast)' },
  { value: -20, label: '−20 LUFS (Audiobook)' },
  { value: -23, label: '−23 LUFS (EBU R128 broadcast)' },
];
