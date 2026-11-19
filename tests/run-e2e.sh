#!/usr/bin/env bash
# Browser tests: Takeflow editor (regression) + Enhance Studio. Needs Python Playwright + Chromium and ffmpeg.
set -e
cd "$(dirname "$0")/.."
node tests/make_e2e_fixtures.mjs /tmp/studio-fx >/dev/null
node -e "import('./tests/helpers.mjs').then(({synthSpeech})=>{const fs=require('fs');const sr=48000;const {x}=synthSpeech(sr,20,{noise:0.02,hum:0.005});const b=Buffer.alloc(44+x.length*2);b.write('RIFF',0);b.writeUInt32LE(36+x.length*2,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(x.length*2,40);for(let i=0;i<x.length;i++)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(x[i]*32767))),44+i*2);fs.writeFileSync('/tmp/mic.wav',b)})"
python3 tests/serve.py 8765 public & S1=$!
python3 tests/serve.py 8770 public & S2=$!
trap 'kill $S1 $S2' EXIT
sleep 1
FAKE_MIC=/tmp/mic.wav TAKEFLOW_URL=http://localhost:8765/classic.html python3 tests/e2e_browser.py
python3 tests/e2e_studio.py
