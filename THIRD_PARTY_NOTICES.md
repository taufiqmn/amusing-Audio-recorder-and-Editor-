# Third-party software

| Component | Where | Licence |
|---|---|---|
| RNNoise WebAssembly build (@jitsi/rnnoise-wasm 0.2.1, RNNoise by Jean-Marc Valin / Xiph.Org) | `public/js/vendor/`, `public/studio/js/vendor/rnnoise.*` | BSD-style, see `RNNOISE-LICENSE.txt` |
| lamejs 1.2.1 (JavaScript port of LAME) | `public/js/vendor/lame.min.js`; `public/studio/js/vendor/lame.mjs` is the same file with one added line, `export default lamejs;`, so it loads as a module without eval | LGPL, see `LAMEJS-LICENSE.txt`; shipped as a separate replaceable file |
| Inter (Rasmus Andersson) | `public/studio/fonts/` | SIL Open Font License 1.1, `OFL-Inter.txt` |
| Space Grotesk (Florian Karsten) | `public/studio/fonts/` | SIL Open Font License 1.1, `OFL-SpaceGrotesk.txt` |
| Bricolage Grotesque, Figtree (editor page, loaded from Google Fonts) | Google Fonts | SIL Open Font License 1.1 |
| axe-core (tests only, not shipped) | dev dependency | MPL-2.0 |
