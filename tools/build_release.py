"""Build ready-to-run Windows folders (and zips) of the app, from this source and an existing build's Electron runtime.

Full app (to share):
    python tools/build_release.py --runtime <a built AI-3D-Print-Advisor-Studio-x.y.z-win-x64 folder> --out <folder>

Demo app (guided sample with recorded results, see preload-demo.js):
    python tools/build_release.py --runtime <...> --out <folder> --demo --recording <rec.jsonl>
        --inventory <Filament Inventory folder> [--backup <its downloaded backup .json>] --config <the app's config.json>

The runtime folder supplies Electron (the .exe and its DLLs) and the bundled node_modules (read from its app.asar).
Nothing from your data folder goes into the full app. The demo gets: the recorded answers (scrubbed of local paths),
your filament catalog and product photos with the shop links replaced by dummies, and your printers' names and
addresses (never their API keys).
"""
import argparse
import tarfile
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_FILES = ['main.js', 'preload.js', 'preload-demo.js', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'renderer', 'src']
EXE = 'AI 3D Print Advisor Studio.exe'

def asar_node_modules(asar, out):
    """Copy node_modules out of an app.asar (and its .unpacked folder)."""
    d = open(asar, 'rb').read()
    hdr = json.loads(d[16:16 + struct.unpack('<I', d[12:16])[0]]); base = 8 + struct.unpack('<I', d[4:8])[0]
    unpacked = asar + '.unpacked'
    def walk(node, dst, rel):
        for name, v in node.get('files', {}).items():
            p, r = os.path.join(dst, name), os.path.join(rel, name)
            if 'files' in v: walk(v, p, r)
            elif v.get('unpacked'):
                os.makedirs(os.path.dirname(p), exist_ok=True); shutil.copy(os.path.join(unpacked, r), p)
            elif 'offset' in v:
                os.makedirs(os.path.dirname(p), exist_ok=True); o = base + int(v['offset']); open(p, 'wb').write(d[o:o + v['size']])
    walk(hdr['files']['node_modules'], os.path.join(out, 'node_modules'), 'node_modules')

def overlay_packages(tarballs, app):
    """Replace bundled libraries with newer npm packages (.tgz from registry.npmjs.org), e.g. for a security fix."""
    for tgz in tarballs or []:
        with tarfile.open(tgz) as t:
            name = json.load(t.extractfile('package/package.json'))['name']
            dst = os.path.join(app, 'node_modules', name)
            shutil.rmtree(dst, ignore_errors=True)
            for m in t.getmembers():
                if not m.name.startswith('package/') or not (m.isfile() or m.isdir()): continue
                rel = m.name[len('package/'):]
                if not rel or '..' in rel.split('/'): continue
                target = os.path.join(dst, rel)
                if m.isdir(): os.makedirs(target, exist_ok=True); continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with t.extractfile(m) as f, open(target, 'wb') as o: o.write(f.read())
            print('Bundled', name, json.load(open(os.path.join(dst, 'package.json')))['version'])

def copy_app(dst):
    for f in APP_FILES:
        s = os.path.join(ROOT, f)
        if os.path.isdir(s): shutil.copytree(s, os.path.join(dst, f))
        elif os.path.exists(s): shutil.copy(s, os.path.join(dst, f))

def demo_data(args, demo_dir, exe):
    os.makedirs(demo_dir, exist_ok=True)
    # recorded answers
    subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'tools', 'build_demo_recording.py'), args.recording, os.path.join(demo_dir, 'recording.json')], check=True)
    rec_path = os.path.join(demo_dir, 'recording.json')
    text = open(rec_path, encoding='utf-8').read()
    # the stand-in printer of the recording is named like your printers
    text = re.sub(r'(?<!Snapmaker )U1 #(\d)', r'Snapmaker U1 #\1', text)
    open(rec_path, 'w', encoding='utf-8').write(text)
    # your printers: names and addresses only
    cfg = json.load(open(args.config, encoding='utf-8'))
    printers = [{'name': p.get('name'), 'url': p.get('url')} for p in cfg.get('printers', [])]
    json.dump(printers, open(os.path.join(demo_dir, 'printers.json'), 'w', encoding='utf-8'), indent=1)
    # your filament: imported with the app's own importer into a scratch data folder
    tmp = tempfile.mkdtemp(prefix='demo-filament-')
    env = dict(os.environ, ELECTRON_RUN_AS_NODE='1')
    cmd = [exe, os.path.join(ROOT, 'tools', 'import_filament_inventory.js'), args.inventory, args.backup or '', tmp]
    subprocess.run(cmd, check=True, env=env)
    src = os.path.join(tmp, 'filament')
    fil = os.path.join(demo_dir, 'filament'); os.makedirs(fil, exist_ok=True)
    cat = json.load(open(os.path.join(src, 'catalog.json'), encoding='utf-8'))
    for o in cat.get('orders', []): o['url'] = 'https://demo.invalid/reorder'   # no real order or shop links
    cat.pop('importedFrom', None)
    json.dump({'orders': cat['orders'], 'prices': cat.get('prices', {})}, open(os.path.join(fil, 'catalog.json'), 'w', encoding='utf-8'))
    if os.path.exists(os.path.join(src, 'state.json')):
        st = json.load(open(os.path.join(src, 'state.json'), encoding='utf-8'))
        json.dump(st, open(os.path.join(fil, 'state.json'), 'w', encoding='utf-8'))
    shutil.copytree(os.path.join(src, 'images'), os.path.join(fil, 'images'))
    shutil.rmtree(tmp, ignore_errors=True)
    # nothing personal may be left
    for root, _, files in os.walk(demo_dir):
        for f in files:
            if f.endswith('.json'):
                t = open(os.path.join(root, f), encoding='utf-8').read()
                for bad in [b for b in ('sk-ant', os.environ.get('USERNAME', ''), 'amazon.com/gp/your-account', 'apiKey') if b]:   # keys, your Windows user name, order links
                    if bad in t: sys.exit(f'Stopped: "{bad}" found in {os.path.join(root, f)}')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--demo', action='store_true'); ap.add_argument('--recording'); ap.add_argument('--inventory'); ap.add_argument('--backup'); ap.add_argument('--config')
    ap.add_argument('--no-zip', action='store_true')
    ap.add_argument('--package', action='append', help='an npm .tgz to bundle instead of the runtime copy (repeatable)')
    args = ap.parse_args()
    version = json.load(open(os.path.join(ROOT, 'package.json')))['version']
    name = f"AI-3D-Print-Advisor-Studio-{'DEMO-' if args.demo else ''}{version}-win-x64"
    out = os.path.join(args.out, name)
    if os.path.exists(out): shutil.rmtree(out)
    shutil.copytree(args.runtime, out, ignore=shutil.ignore_patterns('app.asar', 'app.asar.unpacked', 'app'))
    app = os.path.join(out, 'resources', 'app')
    os.makedirs(app)
    copy_app(app)
    if not args.demo: os.remove(os.path.join(app, 'preload-demo.js'))
    asar_node_modules(os.path.join(args.runtime, 'resources', 'app.asar'), app)
    overlay_packages(args.package, app)
    if args.demo:
        demo_data(args, os.path.join(app, 'demo'), os.path.join(out, EXE))
        os.rename(os.path.join(out, EXE), os.path.join(out, 'AI 3D Print Advisor Studio DEMO.exe'))
    print('Built', out)
    if not args.no_zip:
        z = out + '.zip'
        if os.path.exists(z): os.remove(z)
        with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(out):
                for f in files:
                    full = os.path.join(root, f)
                    zf.write(full, os.path.join(name, os.path.relpath(full, out)))
        print('Zipped', z, f'{os.path.getsize(z) / 1e6:.0f} MB')

if __name__ == '__main__':
    main()
