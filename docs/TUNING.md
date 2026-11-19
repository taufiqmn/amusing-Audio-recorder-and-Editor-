# Tuning record (final values and why)

All values were chosen by running the seeded fixtures in `tests/fixtures.mjs` and comparing numbers in `tests/studio-engine.test.mjs`.

| Stage | Final value | Evidence |
|---|---|---|
| High-pass | 80 Hz, 4th-order Butterworth (phone preset 110 Hz, music 40 Hz) | removes rumble; voice fixtures carry nothing below 70 Hz |
| Noise tracker | per-bin 20th-percentile tracker in dB (+0.2 dB/frame up, −0.8 down; ×4 during the first second), bias correction +6.5 dB (×4.48) | a minimum-follower under-estimated noise by ~7 dB and removed almost nothing; the quantile tracker gave +9 to +31 dB SI-SDR |
| log-MMSE | decision-directed ξ (α = 0.98, ξmin −25 dB), noise over-estimate ×1.25, gain floor −26 dB at full strength | floor drop ≥ 15 dB on hiss/fan/hum |
| RNNoise blend | 35 % of full strength in Standard (100 % in Fast) | 0 % lost floor reduction on non-stationary noise; 100 % capped SI-SDR (RNNoise scores only 6.3 dB on the clean synthetic voice); 35 % kept every case above +6 dB |
| Echo removal | late-reverb model, 50 ms boundary, over-subtraction = control × 1.6 for RT60 < 0.6 s, × 0.7 for RT60 > 1 s, floor −12 dB | RT60 −37 % / −44 % / −75 % at 0.4 / 0.8 / 1.2 s; voice correlation 0.863 / 0.852 / 0.842 |
| Learned noise sample | profile × (1 + 2·amount), extra −6 dB gain floor | +1.9 dB before the change, passes ≥ 3 dB after |
| Warmth | low shelf 160 Hz up to +5 dB, cut at 320 Hz up to −4 dB (control 0–100) | presets use 45–70 % |
| Clarity | presence 4 kHz up to +5 dB; air shelf 11 kHz up to +4 dB only when measured bandwidth ≥ 12 kHz | prevents boosting hiss on phone audio |
| De-esser | dynamic notch 6.5 kHz, threshold −8 dB band-to-full ratio | |
| Leveler | 400 ms window, 200 ms look-ahead, ±9 dB, 350 ms smoothing, works around the measured speech level (clamped −40…−16 dBFS) | a hum fixture once produced "no speech" (−120 dB) and crushed the audio; fallback to the 90th-percentile level fixed it |
| Compressor | threshold speech level + 4 dB, ratio 1 + 3 × evening (≈ 2.8:1), 15 ms / 100 ms | |
| Gap expander | threshold speech level − 26 dB, 150 ms hold, 10 ms look-ahead, range 14 × evening dB | breaths reduced, not removed |
| Limiter | 4× oversampled detector, 2.5 ms look-ahead, 60 ms release, ceiling × 0.995 | true peak ≤ ceiling in every test |
| Loudness | exact two-pass gain from stored K-weighted energies; limiter loss corrected by search (cached ≤ 10 min, one probe pass beyond) | within 0.25 LU on every preset |
| Naturalness guard | voice-band (100 Hz–4 kHz) magnitude correlation ≥ 0.9 to the original, musical noise ≤ 6 blips/s | Auto backs off strength and says so |
