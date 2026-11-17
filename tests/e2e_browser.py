# End-to-end browser test (Playwright + Chromium with a simulated microphone).
# Usage: serve public/ on port 8765, create a mono 48 kHz WAV for the fake mic, then:
#   FAKE_MIC=/path/mic.wav python3 tests/e2e_browser.py
import asyncio, base64, subprocess, json, sys
from playwright.async_api import async_playwright
import os
URL=os.environ.get('TAKEFLOW_URL','http://localhost:8765/')
CH=os.environ.get('CHROME_PATH') or None
results=[]
def check(c,msg): results.append((bool(c),msg)); print(('  ✓ ' if c else '  ✗ ')+msg, flush=True)

async def main():
  async with async_playwright() as p:
    b = await p.chromium.launch(executable_path=CH, args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+os.environ.get('FAKE_MIC','/tmp/mic.wav')+'','--autoplay-policy=no-user-gesture-required'])
    ctx = await b.new_context(viewport={'width':1400,'height':1000}, permissions=['microphone'])
    page = await ctx.new_page()
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
    await page.goto(URL); await page.wait_for_function('window.__takeflow')
    sr = await page.evaluate('__takeflow.ctx.sampleRate')
    print('sample rate', sr)
    L = lambda: page.evaluate('__takeflow.tl().length')

    # 1) first take: 3 seconds
    await page.click('#wave')  # focus
    await page.keyboard.press('r'); await page.wait_for_timeout(3000); await page.keyboard.press('r')
    await page.wait_for_function('!__takeflow.state.recording')
    n1 = await L(); check(2.6*sr < n1 < 3.4*sr, f'records first take ({n1/sr:.2f} s)')
    cls = await page.evaluate('document.body.className'); check('recording' not in cls, 'record button returns to idle')

    # 2) punch-in at 1.5 s with pre-roll, replace to end
    await page.evaluate(f'__takeflow.state.cursor={int(1.5*sr)}; __takeflow.view.setCursor({int(1.5*sr)})')
    await page.click('#btnRecord'); await page.wait_for_timeout(2000+2500); await page.click('#btnRecord')
    await page.wait_for_function('!__takeflow.state.recording')
    n2 = await L(); take = n2 - int(1.5*sr)
    check(2.6*sr < take < 3.1*sr, f'punch-in after 1.5 s run-up (all audio before the cursor) replaced the rest ({n2/sr:.2f} s total, new take {take/sr:.2f} s)')
    clips = await page.evaluate('__takeflow.tl().clips.length'); check(clips == 2, f'timeline has 2 clips after punch-in ({clips})')
    cur = await page.evaluate('__takeflow.state.cursor'); check(cur == n2, 'cursor moves to the end of the new take')

    # 3) select by dragging on the waveform, then Delete
    box = await page.locator('#wave').bounding_box()
    await page.evaluate('__takeflow.view.fit()'); await page.wait_for_timeout(100)
    x0 = box['x'] + box['width']*0.2; x1 = box['x'] + box['width']*0.4; y = box['y'] + box['height']*0.6
    await page.mouse.move(x0,y); await page.mouse.down(); await page.mouse.move(x1,y,steps=8); await page.mouse.up()
    sel = await page.evaluate('__takeflow.state.sel'); check(sel and sel['b']>sel['a'], f'drag selects a range ({(sel["b"]-sel["a"])/sr:.2f} s)')
    await page.keyboard.press('Delete'); n3 = await L()
    check(abs((n2-n3)-(sel['b']-sel['a']))<2, f'Delete removes exactly the selection ({n3/sr:.2f} s left)')

    # 4) undo / redo via keyboard
    await page.keyboard.press('Control+z'); check(await L()==n2, 'Ctrl+Z restores the cut')
    await page.keyboard.press('Control+Shift+z'); check(await L()==n3, 'Ctrl+Shift+Z re-applies it')
    await page.keyboard.press('Control+z')

    # 5) re-record a selection (replace-range)
    await page.evaluate(f'__takeflow.state.sel={{a:{int(0.5*sr)},b:{int(1.0*sr)}}}; __takeflow.view.setSelection(__takeflow.state.sel)')
    await page.keyboard.press('r'); await page.wait_for_timeout(500+1500); await page.keyboard.press('r')
    await page.wait_for_function('!__takeflow.state.recording')
    n4 = await L(); check(n4 > n2 - 0.5*sr, f're-recording a selection swaps it for the new take ({n4/sr:.2f} s)')

    # 6) Esc discards a take
    before = await L()
    await page.keyboard.press('r'); await page.wait_for_timeout(1200); await page.keyboard.press('Escape')
    await page.wait_for_function('!__takeflow.state.recording'); check(await L()==before, 'Esc discards the take in progress')

    # 7) playback, and stopping moves the cursor
    await page.evaluate('__takeflow.state.sel=null; __takeflow.view.setSelection(null); __takeflow.state.cursor=0')
    await page.keyboard.press(' '); await page.wait_for_timeout(1200)
    playing = await page.evaluate('__takeflow.player.playing'); check(playing, 'Space starts playback')
    await page.keyboard.press(' '); c = await page.evaluate('__takeflow.state.cursor')
    check(0.8*sr < c < 1.6*sr, f'stopping playback leaves the cursor where it stopped ({c/sr:.2f} s)')

    # 8) enhance preview + apply
    await page.click('button.preset[data-key=podcast]')
    await page.click('#btnPreview')
    await page.wait_for_selector('#abBox:not([hidden])', timeout=60000)
    rep = await page.inner_text('#enhanceReport'); check('LUFS' in rep, 'enhancement preview: ' + rep)
    lufs = float(rep.split('→')[1].split('LUFS')[0])
    check(abs(lufs+16)<0.3, 'preview hits −16 LUFS')
    await page.keyboard.press('b'); ab = await page.evaluate('__takeflow.player.useAlt'); check(ab is False, 'B toggles back to the original')
    await page.keyboard.press('b')
    nb = await L(); await page.click('#btnApply')
    check(await L()==nb and await page.evaluate('__takeflow.tl().clips.length')==1, 'apply replaces the timeline with the enhanced audio')

    # 9) exports
    async def export(fmt, extra=None):
      await page.check(f'input[name=fmt][value={fmt}]')
      if extra: await page.evaluate(extra)
      await page.evaluate('window.__lastExport=null')
      async with page.expect_download() as dl:
        await page.click('#btnExport')
      d = await dl.value
      path = f'/tmp/takeflow-out.{fmt}'; await d.save_as(path)
      info = subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_name,sample_rate,channels,bits_per_raw_sample,bit_rate:format=duration','-of','json',path],capture_output=True,text=True).stdout
      j = json.loads(info); s=j['streams'][0]; dur=float(j['format']['duration'])
      dec = subprocess.run(['ffmpeg','-v','error','-i',path,'-f','null','-'],capture_output=True,text=True)
      return s, dur, d.suggested_filename, dec.stderr.strip()
    total = await L()/sr
    s,dur,name,err = await export('wav'); check(s['codec_name']=='pcm_s24le' and abs(dur-total)<0.01 and not err, f'WAV 24-bit: {name}, {dur:.2f} s')
    s,dur,name,err = await export('flac'); check(s['codec_name']=='flac' and abs(dur-total)<0.01 and not err, f'FLAC: {dur:.2f} s, decodes cleanly')
    await page.select_option('#rate','44100')
    s,dur,name,err = await export('mp3'); check(s['codec_name']=='mp3' and s['sample_rate']=='44100' and abs(dur-total)<0.1 and not err, f'MP3 @44.1k {s.get("bit_rate")} bps: {dur:.2f} s')
    await page.select_option('#rate','0')
    has_opus = await page.evaluate("!document.getElementById('opusOption').hidden")
    if has_opus:
      s,dur,name,err = await export('opus'); check(s['codec_name']=='opus' and abs(dur-total)<0.03 and not err, f'Opus via WebCodecs: {dur:.2f} s, {name}')
    else: check(False,'Opus option available in Chromium')
    await page.select_option('#channels','2')
    s,dur,name,err = await export('wav'); check(s['channels']==2, 'stereo export has 2 channels')
    await page.select_option('#channels','1')

    # 10) reload restores the project
    await page.wait_for_timeout(1500)
    before = await L()
    await page.reload(); await page.wait_for_function('window.__takeflow && __takeflow.tl().length>0', timeout=10000)
    check(await L()==before, f'reload restores the saved project ({before/sr:.2f} s)')
    check(await page.evaluate("document.getElementById('projectName').value")=='Untitled recording', 'project name restored')

    # 11) crash during recording -> recovered on next load
    before = await L()
    await page.evaluate('__takeflow.state.cursor=__takeflow.tl().length')
    await page.keyboard.press('r'); await page.wait_for_timeout(5000)
    await page.evaluate('1')  # still recording; now simulate a crash by navigating away hard
    await page.goto('about:blank'); await page.goto(URL)
    await page.wait_for_function('window.__takeflow', timeout=10000); await page.wait_for_timeout(800)
    after = await L(); toast = await page.inner_text('#toast')
    check(after > before + 2.2*sr, f'unfinished take recovered after crash (+{(after-before)/sr:.2f} s) — "{toast}"')

    # 12) shorten pauses dialog
    await page.click('#btnPauses'); await page.click('#pauseOk'); await page.wait_for_timeout(300)
    st = await page.inner_text('#status'); check('pause' in st.lower(), 'shorten pauses: ' + st)

    # 13) new recording clears
    await page.click('#btnNew'); await page.click('#confirmOk'); await page.wait_for_timeout(300)
    check(await L()==0, 'New recording clears the project')

    real_errors=[e for e in errors if 'favicon' not in e and 'fonts.g' not in e and 'net::ERR' not in e]
    check(not real_errors, 'no JavaScript errors' + ('' if not real_errors else ': '+' | '.join(real_errors[:5])))
    await b.close()
  fails=[m for ok,m in results if not ok]
  print(f'\n{len(results)-len(fails)}/{len(results)} passed')
asyncio.run(main())
