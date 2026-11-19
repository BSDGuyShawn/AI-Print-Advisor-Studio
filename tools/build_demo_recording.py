"""Turn a recording of the real app (AIPA_RECORD) into the demo's replay file.

    python tools/build_demo_recording.py <rec.jsonl> <demo/recording.json>

- Tags every answer with its context: which demo model was open (file) and whether a color remix was applied
  (remix), so the demo replays the right 3D preview after the user applies the remix.
- Leaves out calls the demo answers itself (filament inventory, settings, sessions) and anything personal.
- Replaces local paths (user name, temp folders) with a neutral demo folder.
- Keeps only the remix that was applied last (the demo can apply that scheme).
"""
import json
import re
import sys

SKIP = {'filament-load', 'filament-save', 'filament-import', 'filament-has-key', 'filament-check-folder', 'filament-check-backup',
        'set-config', 'session-save', 'session-get', 'session-clear', 'session-forget-file', 'startup-state',
        'inventory-status', 'past-analyses', 'recent-sessions', 'set-assembly', 'history-rate', 'printers-status'}
DEMO_DIR = 'C:\\Demo\\'

def scrub(text):
    # any absolute Windows path up to the file name -> the demo folder (JSON-escaped backslashes and forward slashes)
    text = re.sub(r'[A-Za-z]:(?:\\\\|/)(?:[^"\\/:*?<>|]+(?:\\\\|/))+', lambda m: DEMO_DIR.replace('\\', '\\\\'), text)
    return text

def main():
    src, out = sys.argv[1], sys.argv[2]
    recs = [json.loads(l) for l in open(src, encoding='utf-8')]
    file, remix = None, None
    kept = []
    for r in recs:
        m = r['m']
        if m == 'open-path':
            file = re.split(r'[\\/]', r['args'][0])[-1] if r.get('args') else file
            remix = None
        if m == 'remix-undo': remix = None
        ctx = {'file': file, 'remix': remix}
        if m == 'remix-apply' and 'r' in r: remix = r['r'].get('name')
        if m in SKIP: continue
        kept.append({'m': m, 'ctx': ctx, 'args': r.get('args', []), **({'r': r['r']} if 'r' in r else {'err': r.get('err')}), 'ms': r.get('ms', 0)})
    # only the last applied remix can be applied in the demo
    applied = [k for k in kept if k['m'] == 'remix-apply' and 'r' in k]
    if applied:
        last = applied[-1]['r']['name']
        kept = [k for k in kept if not (k['m'] == 'remix-apply' and k.get('r', {}).get('name') != last)]
        kept = [k for k in kept if k['ctx']['remix'] in (None, last)]
    # the slice made only to get the failed print's G-code isn't a demo version
    for k in kept:
        if k['m'] == 'slice-variants':
            k['args'][0]['variants'] = [v for v in k['args'][0]['variants'] if v['id'] != 'as-printed']
            k['r'] = [x for x in k['r'] if x.get('id') != 'as-printed']
    kept = [k for k in kept if not (k['m'] == 'slice-variants' and not k['r'])]
    text = scrub(json.dumps(kept, ensure_ascii=False))
    for bad in ('jamis', 'sk-ant', 'scratchpad', 'AppData'):
        if bad.lower() in text.lower(): print(f'WARNING: "{bad}" still appears in the recording');
    open(out, 'w', encoding='utf-8').write(text)
    print(f'{out}: {len(kept)} answers, {len(text) / 1e6:.2f} MB')

if __name__ == '__main__':
    main()
