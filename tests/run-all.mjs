// Runs every Node test. Requires ffmpeg on PATH for the encoder and loudness checks.
import { execFileSync } from 'node:child_process';
const files = ['dsp.test.mjs', 'enhance.test.mjs', 'encoders.test.mjs', 'engine.test.mjs'];
let failed = 0;
for (const f of files) {
  const out = execFileSync(process.execPath, [new URL(f, import.meta.url).pathname], { encoding: 'utf8' });
  process.stdout.write(out);
  failed += (out.match(/✗/g) || []).length;
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
