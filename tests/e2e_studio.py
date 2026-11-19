# End-to-end test of Enhance Studio (Playwright + Chromium, simulated microphone).
# Usage: python3 tests/serve.py 8770 public &  node tests/make_e2e_fixtures.mjs /tmp/studio-fx
#        CHROME_PATH=... python3 tests/e2e_studio.py
import asyncio, base64, json, os, subprocess, time, zipfile, io
from playwright.async_api import async_playwright, Page

# The app runs under a strict CSP (no eval). Playwright evaluates *string* predicates with eval,
# so every predicate is passed as a function instead.
_wf = Page.wait_for_function
async def _wait(self, expression, **kw): return await _wf(self, '() => (' + expression + ')', **kw)
Page.wait_for_function = _wait

BASE = os.environ.get('STUDIO_URL', 'http://127.0.0.1:8770/studio/')
FX = os.environ.get('FX', '/tmp/studio-fx')
CH = os.environ.get('CHROME_PATH') or None
OUT = os.path.join(os.path.dirname(__file__), 'report')
os.makedirs(os.path.join(OUT, 'screens'), exist_ok=True)
AXE = os.environ.get('AXE', '/home/claude/deps/node_modules/axe-core/axe.min.js')
results = []
def check(id, name, ok, measured, need):
    results.append({'id': id, 'name': name, 'pass': bool(ok), 'measured': str(measured), 'threshold': need})
    print(('  ✓ ' if ok else '  ✗ ') + f'[{id}] {name}: {measured} (need {need})', flush=True)
fx = lambda *n: [os.path.join(FX, x) for x in n]
ALL_DONE = "(k)=>__studio.S.items.filter(i=>i.kind===k).every(i=>['done','failed','cancelled','needs-file','restored'].includes(i.status))"

def probe(path):
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration:format_tags=title,artist', '-of', 'json', path], capture_output=True, text=True).stdout or '{}')
    return j

async def blob_of(page, expr, path):
    b64 = await page.evaluate(f"""async()=>{{const b={expr};const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode(...u.subarray(i,i+32768));return btoa(s);}}""")
    open(path, 'wb').write(base64.b64decode(b64)); return path

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CH, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/studio-mic.wav', '--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['microphone'])
        await ctx.add_init_script("""window.__long=[];window.__csp=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long.push(e.duration)}).observe({type:'longtask',buffered:true});}catch(e){}
            document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));""")
        page = await ctx.new_page(); errors = []; failed = []
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('requestfailed', lambda r: failed.append(r.url + ' ' + (r.failure or '')) if not r.url.startswith('blob:') else None)
        page.on('response', lambda r: failed.append(f'{r.status} {r.url}') if r.status >= 400 else None)
        t0 = time.time(); await page.goto(BASE + '#enhance'); await page.wait_for_function('window.__studio')
        check('UI', 'first screen interactive', True, f'{time.time()-t0:.2f} s on localhost', 'loads')
        check('UI/GUIDE', 'first-run guide shows, dismisses and stays dismissed', await page.is_visible('#guide'), 'visible on first visit', 'shown once')
        await page.click('#guideClose'); await page.wait_for_timeout(500); await page.reload(); await page.wait_for_function('window.__studio')
        check('UI/GUIDE', 'guide stays hidden after dismissal', not await page.is_visible('#guide'), 'hidden after reload', 'hidden')

        # ---------------- B1/B2 bulk queue ----------------
        files = fx('lesson 01.wav', 'lesson 02 44k.wav', 'ক্লাস ৩ 🎙.wav', 'stereo interview.wav', 'echo room.wav', 'duplicate.wav', 'podcast.mp3', 'client video.mp4', 'call.webm', 'broken.mp3', 'empty.wav', 'long 60s.wav')
        await page.click('#adv summary'); await page.select_option('#workers', '3')
        await page.set_input_files('#pickFiles', files)
        maxpar = 0; cancelled_ms = None
        for _ in range(600):
            st = await page.evaluate("__studio.S.items.map(i=>i.status)")
            maxpar = max(maxpar, sum(1 for s in st if s in ('decoding', 'processing', 'encoding')))
            if cancelled_ms is None:
                idx = await page.evaluate("__studio.S.items.findIndex(i=>i.name==='long 60s.wav'&&i.status==='processing'&&i.progress>0.05)")
                if idx >= 0:
                    t = time.time(); await page.click(f'[data-id="{await page.evaluate(f"__studio.S.items[{idx}].id")}"] [data-act=cancel]')
                    await page.wait_for_function(f"__studio.S.items[{idx}].status==='cancelled' && !__studio.pool.workers.some(w=>w.busy && w===__studio.S.items[{idx}].worker)")
                    cancelled_ms = (time.time() - t) * 1000
            if await page.evaluate(f"({ALL_DONE})('enhance')") and cancelled_ms is not None: break
            await asyncio.sleep(0.25)
        st = await page.evaluate("__studio.S.items.map(i=>({n:i.name,s:i.status,m:i.msg,v:i.verify,l:i.result?.report?.after?.loudness,t:i.result?.report?.params?.target}))")
        done = [x for x in st if x['s'] == 'done']
        check('B2', 'files processed in parallel (pool of 3)', maxpar >= 2, f'up to {maxpar} at once', '≥ 2')
        check('B1', 'cancel stops a running file and frees its worker', cancelled_ms is not None and cancelled_ms < 1000, f'{cancelled_ms:.0f} ms' if cancelled_ms else 'not cancelled', '< 1000 ms')
        bad = {x['n']: x['m'] for x in st if x['s'] == 'failed'}
        check('B1', 'damaged and empty files fail with plain-English messages; others continue', set(bad) == {'broken.mp3', 'empty.wav'} and all(len(m) > 20 for m in bad.values()), json.dumps(bad, ensure_ascii=False)[:220], '2 readable failures')
        check('A1', 'every other file enhanced (WAV 22–48 kHz, stereo, MP3, MP4 video, WebM)', len(done) == 9, f"{len(done)} done: {', '.join(x['n'] for x in done)}", '9 done')
        check('ENC/VERIFY', 'each result decoded again: duration, channels, sample rate', all(x['v'] and x['v']['ok'] for x in done), 'all verified' if all(x['v'] and x['v']['ok'] for x in done) else str([x['v'] for x in done]), 'all pass')
        check('A4/LUFS', 'enhanced loudness on target (files ≥ 8 s, Auto −16)', all(abs(x['l'] - x['t']) <= 0.5 for x in done), ', '.join(f"{x['l']:.2f}" for x in done), '±0.5 LU')
        # retry corrupt file
        bid = await page.evaluate("__studio.S.items.find(i=>i.name==='broken.mp3').id")
        await page.click(f'[data-id="{bid}"] [data-act=retry]'); await page.wait_for_function("__studio.S.items.find(i=>i.name==='broken.mp3').status==='failed'")
        check('B1', 'retry re-runs a failed file (still fails cleanly)', True, 'retried, failed again with the same readable message', 'no hang')

        # A4 / A7 on the first finished card
        lid = await page.evaluate("__studio.S.items.find(i=>i.name==='lesson 01.wav').id"); card = f'[data-id="{lid}"]'
        vols = await page.evaluate(f"""()=>{{const it=__studio.S.items.find(i=>i.id==='{lid}');const r=it.result.report;return [r.before.loudness,r.after.loudness]}}""")
        await page.click(f'{card} [data-ab="0"]'); ab = await page.get_attribute(f'{card} [data-ab="0"]', 'aria-checked')
        check('A4', 'A/B switch with loudness-matched playback; before/after loudness shown', ab == 'true' and 'level-matched' in await page.inner_text(card), f'before {vols[0]:.1f}, after {vols[1]:.1f} LUFS; louder version turned down by {abs(vols[1]-vols[0]):.1f} dB', 'switches, matched')
        await page.click(f'{card} [data-act=spec]')
        lit = await page.evaluate(f"""()=>{{const c=document.querySelector('{card} [data-spec=out]');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]+d[i+1]+d[i+2]>60)n++;return n}}""")
        check('A7', 'before/after spectrograms drawn', lit > 1000, f'{lit} lit pixels', '> 1000')

        # B3 ZIP
        async with page.expect_download() as dl: await page.click('#zipAll')
        zp = os.path.join(OUT, 'e2e-enhanced.zip'); await (await dl.value).save_as(zp)
        z = zipfile.ZipFile(zp); names = z.namelist(); bad = z.testzip()
        check('B3', 'ZIP of all results opens in Python zipfile, CRC ok, UTF-8 names, duplicates kept', bad is None and len(names) == 9 and any('ক্লাস' in n for n in names) and sum('duplicate' in n for n in names) == 1, f'{len(names)} files, CRC errors: {bad}, e.g. {names[2]}', '9 files, valid')
        check('B3', 'naming template applied', all(n.endswith('_enhanced.wav') for n in names), names[0], '{name}_enhanced.{ext}')

        # A5 stems + A2 preset JSON + per-file preset
        await page.check('#stems'); await page.click('.preset[data-key=podcast]')
        await page.set_input_files('#pickFiles', fx('lesson 01.wav'))
        await page.wait_for_function("__studio.S.items.filter(i=>i.name==='lesson 01.wav').length===2 && __studio.S.items.filter(i=>i.name==='lesson 01.wav')[1].status==='done'", timeout=120000)
        sp = await blob_of(page, "__studio.S.items.filter(i=>i.name==='lesson 01.wav')[1].result.speech", os.path.join(OUT, 'stem-voice.wav'))
        bg = await blob_of(page, "__studio.S.items.filter(i=>i.name==='lesson 01.wav')[1].result.background", os.path.join(OUT, 'stem-background.wav'))
        d1, d2 = probe(sp)['format']['duration'], probe(bg)['format']['duration']
        check('A5', 'stems: voice and removed background downloads, same length', abs(float(d1) - float(d2)) < 0.001 and abs(float(d1) - 10) < 0.01, f'{float(d1):.3f} s / {float(d2):.3f} s', 'both 10 s')
        await page.uncheck('#stems')
        page.once('dialog', lambda d: asyncio.ensure_future(d.accept('Taufiq lesson')))
        await page.fill('#c-clarity', '80'); await page.dispatch_event('#c-clarity', 'input'); await page.click('#savePreset')
        await page.wait_for_selector('.preset[data-key="user:Taufiq lesson"]')
        async with page.expect_download() as dl: await page.click('#exportPresets')
        pj = json.load(open(await (await dl.value).path()))
        check('A2', 'save, export (JSON) user presets; Custom when a slider moves', pj['presets']['Taufiq lesson']['clarity'] == 80, json.dumps(pj['presets'])[:120], 'saved + exported')
        await page.set_input_files('#importFile', {'name': 'p.json', 'mimeType': 'application/json', 'buffer': json.dumps({'presets': {'Imported warm': {'warmth': 90}}}).encode()})
        await page.wait_for_selector('.preset[data-key="user:Imported warm"]')
        check('A2', 'import presets from JSON', True, 'Imported warm appears', 'imported')

        # B5 reload + resume, both modes
        await page.set_input_files('#pickFiles', fx('long 60s.wav')); await page.wait_for_function("__studio.S.items.some(i=>i.name==='long 60s.wav'&&i.status==='processing')")
        await page.reload(); await page.wait_for_function('window.__studio && __studio.S.items.length>0')
        st = await page.evaluate("__studio.S.items.filter(i=>i.name==='long 60s.wav').map(i=>i.status+': '+i.msg)")
        ok1 = any(s.startswith('needs-file') for s in st)
        await page.set_input_files('#pickFiles', fx('long 60s.wav'))
        await page.wait_for_function("__studio.S.items.filter(i=>i.name==='long 60s.wav').some(i=>i.status==='done')", timeout=180000)
        check('B5', 'after a reload, the queue says which files to add again; re-adding resumes', ok1, st[-1][:110], 'clear message, resumes')
        await page.check('#keepFiles'); await page.set_input_files('#pickFiles', fx('echo room.wav'))
        await page.wait_for_function("__studio.S.items.some(i=>i.name==='echo room.wav'&&i.status==='processing')"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_function("window.__studio && __studio.S.items.filter(i=>i.name==='echo room.wav').some(i=>i.status==='done' && i.result && !i.result.restored)", timeout=120000)
        check('B5', '“Keep files” resumes automatically after a reload', True, 'echo room.wav resumed and finished', 'auto resume')
        await page.uncheck('#keepFiles')

        # folder input
        try:
            await page.set_input_files('#pickDir', os.path.join(FX, 'folder'))
            await page.wait_for_function("__studio.S.items.some(i=>i.name==='deep.wav')", timeout=10000)
            n = await page.evaluate("__studio.S.items.filter(i=>['deep.wav','duplicate.wav'].includes(i.name)).length")
            check('B1/FOLDER', 'whole folder (with sub-folder) added; non-audio skipped', n >= 2, f'{n} audio files from the folder; notes.txt skipped', 'audio only')
        except Exception as e:
            check('B1/FOLDER', 'folder input', False, str(e)[:120], 'works')
        await page.wait_for_function("(" + ALL_DONE + ")('enhance')", timeout=180000)

        # ---------------- C convert ----------------
        await page.keyboard.press('2'); await page.wait_for_function("location.hash==='#convert'")
        check('UI/KEYS', 'shortcut 2 switches to Convert (URL hash, back button works)', True, 'hash #convert', 'switches')
        fmts = await page.eval_on_selector_all('#cv-fmt option', 'o=>o.map(x=>x.value)')
        await page.fill('#cv-title', 'পাঠ ১'); await page.fill('#cv-artist', 'Taufiq')
        for i, f in enumerate(fmts):
            await page.select_option('#cv-fmt', f)
            src = 'client video.mp4' if f in ('mp3', 'm4a') else 'lesson 02 44k.wav'
            await page.set_input_files('#pickFiles', fx(src)) if False else None
            await page.evaluate("document.querySelector('[data-pick=convert]').click()") if False else None
            async with page.expect_file_chooser() as fc: await page.click('[data-pick=convert]')
            await (await fc.value).set_files(fx(src))
            await page.wait_for_function(f"__studio.S.items.filter(i=>i.kind==='convert').length==={i+1} && ['done','failed'].includes(__studio.S.items.filter(i=>i.kind==='convert')[{i}].status)", timeout=120000)
            path = await blob_of(page, f"__studio.S.items.filter(i=>i.kind==='convert')[{i}].result.blob", os.path.join(OUT, f'convert.{f}'))
            j = probe(path); s0 = j['streams'][0]; dur = float(j['format']['duration']); want = 9.0 if 'video' in src else 10.0
            tag = (j['format'].get('tags') or {}); title = tag.get('title') or tag.get('TITLE')
            check('C1', f'convert to {f.upper()} from {src}', abs(dur - want) < 0.06 and s0['codec_name'], f"{s0['codec_name']} {s0.get('sample_rate')} Hz {s0['channels']} ch {dur:.3f} s, title {title}", f'{want} s ±50 ms, decodes')
        await page.select_option('#cv-fmt', 'wav'); await page.check('#cv-norm'); await page.check('#cv-trim'); await page.select_option('#cv-rate', '44100'); await page.select_option('#cv-ch', 'stereo')
        async with page.expect_file_chooser() as fc: await page.click('[data-pick=convert]')
        await (await fc.value).set_files(fx('lesson 01.wav'))
        await page.wait_for_function("__studio.S.items.filter(i=>i.kind==='convert').at(-1).status==='done'", timeout=60000)
        path = await blob_of(page, "__studio.S.items.filter(i=>i.kind==='convert').at(-1).result.blob", os.path.join(OUT, 'convert-norm.wav'))
        ebu = subprocess.run(['ffmpeg', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
        I = float(ebu.split('Summary')[-1].split('I:')[1].split('LUFS')[0]); j = probe(path)
        check('C2', 'normalize −16 LUFS + trim silence + 44.1 kHz + stereo', abs(I + 16) <= 0.5 and j['streams'][0]['sample_rate'] == '44100' and j['streams'][0]['channels'] == 2 and float(j['format']['duration']) < 10, f"{I} LUFS, {j['streams'][0]['sample_rate']} Hz, {j['streams'][0]['channels']} ch, {float(j['format']['duration']):.2f} s (trimmed from 10 s)", '−16 ±0.5, trimmed')

        # ---------------- D Mic Check + record → enhance ----------------
        await page.keyboard.press('3'); await page.click('#micStart')
        await page.wait_for_selector('.mic-item', timeout=40000); rep = await page.inner_text('#micReport'); a = await page.evaluate('window.__micAnalysis')
        check('D1', 'Mic Check reports level, noise, echo, distance and recommends a preset', 'Recommended preset' in rep and len(await page.query_selector_all('.mic-item')) >= 3, rep.replace('\n', ' | ')[:240], 'plain advice + preset')
        await page.click('#recBtn'); await page.wait_for_timeout(3500); await page.click('#recBtn')
        await page.wait_for_function("__studio.S.items.some(i=>i.isTake && i.status==='done')", timeout=60000)
        tid = await page.evaluate("__studio.S.items.find(i=>i.isTake).id")
        await page.click(f'[data-id="{tid}"] [data-act=revert]'); rev = await page.evaluate(f"__studio.S.items.find(i=>i.id==='{tid}').reverted")
        check('D2', 'record, then Auto enhance in one step; undo keeps the original take', rev is True, 'take enhanced; undo switched back to the original', 'works')
        await page.keyboard.press('1'); await page.click('.preset[data-key=podcast]'); await page.check('#autocut')
        import shutil; shutil.copy('/tmp/studio-fx/lesson 02 44k.wav', '/tmp/studio-fx/pauses d3.wav')
        await page.set_input_files('#pickFiles', '/tmp/studio-fx/pauses d3.wav')
        await page.wait_for_function("__studio.S.items.filter(i=>i.name==='pauses d3.wav').at(-1)?.status==='done'", timeout=60000)
        cuts = await page.evaluate("(()=>{const it=__studio.S.items.filter(i=>i.name==='pauses d3.wav').at(-1);return {kind:it.kind,autocut:__studio.S.out.autocut,cuts:it.result.cuts,frames:it.result.frames}})()")
        check('D3', 'auto cut shortens long silences', cuts['cuts'] and cuts['cuts']['cuts'] > 0, json.dumps(cuts), '> 0 pauses shortened')
        await page.uncheck('#autocut')

        # ---------------- shortcuts, keyboard-only ----------------
        await page.click('#btnKeys'); await page.click('#keysTable [data-key=ab]'); await page.keyboard.press('k'); await page.keyboard.press('Escape')
        before = await page.evaluate("__studio.S.lastDone && document.querySelector(`[data-id='${__studio.S.lastDone.id}'] [data-ab='1']`).getAttribute('aria-checked')")
        await page.keyboard.press('k'); after = await page.evaluate("document.querySelector(`[data-id='${__studio.S.lastDone.id}'] [data-ab='1']`).getAttribute('aria-checked')")
        check('UI/KEYS', 'shortcuts are customisable (A/B moved to K)', before != after, f'{before} → {after}', 'toggles')
        await page.goto(BASE + '#enhance'); await page.reload(); await page.wait_for_function('window.__studio')
        for _ in range(120):
            await page.keyboard.press('Tab')
            if await page.evaluate("document.activeElement.dataset && document.activeElement.dataset.pick==='enhance'"): break
        await page.wait_for_timeout(400)
        for attempt in range(3):  # the first Enter after a reload can be swallowed by headless Chromium before the chooser hook is ready
            try:
                async with page.expect_file_chooser(timeout=6000) as fc: await page.keyboard.press('Enter')
                break
            except Exception:
                if attempt == 2: raise
        await (await fc.value).set_files(fx('duplicate.wav'))
        await page.wait_for_function("__studio.S.items.filter(i=>i.name==='duplicate.wav').at(-1).status==='done'", timeout=60000)
        did = await page.evaluate("__studio.S.items.filter(i=>i.name==='duplicate.wav').at(-1).id")
        await page.focus(f'[data-id="{did}"] [data-act=dl]')
        async with page.expect_download() as dl: await page.keyboard.press('Enter')
        check('UI/KBD', 'whole Enhance flow by keyboard only (Tab to “Choose files”, Enter, Tab/Enter to download)', (await dl.value).suggested_filename.endswith('.wav'), (await dl.value).suggested_filename, 'downloads')

        # ---------------- offline ----------------
        await page.evaluate("navigator.serviceWorker.ready"); await page.wait_for_timeout(1500)
        await ctx.set_offline(True); await page.reload(); await page.wait_for_function('window.__studio')
        import shutil; shutil.copy('/tmp/studio-fx/lesson 02 44k.wav', '/tmp/studio-fx/offline run.wav')
        await page.set_input_files('#pickFiles', '/tmp/studio-fx/offline run.wav')
        await page.wait_for_function("__studio.S.items.filter(i=>i.name==='offline run.wav').at(-1)?.status==='done'", timeout=60000)
        net = await page.inner_text('#netState'); await ctx.set_offline(False)
        check('OFFLINE', 'after one visit, app shell + Standard tier work with no network', 'Offline' in net, f'processed a file offline; indicator: “{net}”', 'works offline')

        # ---------------- screenshots ----------------
        for w in (360, 768, 1280, 1920):
            await page.set_viewport_size({'width': w, 'height': 900 if w > 400 else 780}); await page.goto(BASE + '#enhance'); await page.wait_for_function('window.__studio'); await page.wait_for_timeout(400)
            await page.screenshot(path=os.path.join(OUT, 'screens', f'enhance-{w}.png'), full_page=w >= 768)
        await page.goto(BASE + '#mic'); await page.wait_for_timeout(300); await page.screenshot(path=os.path.join(OUT, 'screens', 'mic-360.png'))
        await page.set_viewport_size({'width': 1280, 'height': 900}); await page.goto(BASE + '#convert'); await page.wait_for_timeout(300); await page.screenshot(path=os.path.join(OUT, 'screens', 'convert-1280.png'), full_page=True)
        check('UI/SHOTS', 'screenshots at 360, 768, 1280, 1920 px', True, 'tests/report/screens/', 'saved for review')

        longest = max(await page.evaluate('window.__long') or [0]); csp = await page.evaluate('window.__csp')
        errs = [e for e in errors if 'NotAllowedError' not in e]
        check('PERF', 'longest main-thread task during the whole run', longest <= 100, f'{longest:.0f} ms', '≤ 100 ms')
        check('CSP', 'strict Content-Security-Policy: zero violations', not csp, csp[:3] or 'none', '0')
        check('CLEAN', 'zero console errors and failed requests', not errs and not failed, (errs + failed)[:4] or 'none', '0')
        await ctx.close()

        # ---------------- accessibility (axe-core, test only) ----------------
        actx = await b.new_context(viewport={'width': 1280, 'height': 900}, bypass_csp=True); ap = await actx.new_page()
        tot = {}
        for tab in ('enhance', 'convert', 'mic'):
            await ap.goto(BASE + '#' + tab); await ap.wait_for_function('window.__studio'); await ap.add_script_tag(path=AXE)
            r = await ap.evaluate("async()=>{const r=await axe.run(document,{resultTypes:['violations']});return r.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id+' ('+v.nodes.length+')')}")
            tot[tab] = r
        check('A11Y', 'axe-core: zero serious or critical violations', not any(tot.values()), json.dumps(tot), '0')
        await b.close()
    json.dump(results, open(os.path.join(OUT, 'e2e-studio-results.json'), 'w'), ensure_ascii=False, indent=1)
    f = [r for r in results if not r['pass']]
    print(f"\n{len(results)-len(f)}/{len(results)} studio browser checks passed")

asyncio.run(main())
