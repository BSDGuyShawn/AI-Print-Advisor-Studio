"""Build ready-to-run Windows folders (and zips) of the app, from this source and an existing build's Electron runtime.

Full app (to share):
    python tools/build_release.py --electron <official Electron build, unzipped> --modules <an earlier release's app.asar>
        --package <npm .tgz> ... --rcedit <rcedit.exe> --out <folder>
  (older way: --runtime <an earlier release folder> reuses that release's Electron files and libraries)

With the guided tour (the first launch replays recorded results on a sample model, see preload-demo.js):
    add --recording <rec.jsonl>
        --inventory <Filament Inventory folder> [--backup <its downloaded backup .json>] --config <the app's config.json>

The runtime folder supplies Electron (the .exe and its DLLs) and the bundled node_modules (read from its app.asar).
Nothing else from your data folder goes into the app. The tour gets: the recorded answers (scrubbed of local paths),
your filament catalog and product photos with the shop links replaced by dummies, and your printers' names and
addresses (never their API keys).

Layout: the folder (and zip) holds just one program, a small launcher (tools/launcher/Launcher.cs, compiled with the
C# compiler that ships with Windows), plus an "app" folder with Electron and everything else.
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
CSC = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

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

def build_launcher(csc, dst, title, version):
    """The one program at the top of the folder: starts app/<title>.exe (tools/launcher/Launcher.cs)."""
    tmp = tempfile.mkdtemp(prefix='launcher-')
    info = os.path.join(tmp, 'LauncherInfo.cs')
    q = lambda v: json.dumps(v)   # a valid C# string literal for these plain values
    open(info, 'w', encoding='utf-8').write(
        'using System.Reflection;\n'
        f'[assembly: AssemblyTitle({q(title)})] [assembly: AssemblyProduct({q(title)})]\n'
        '[assembly: AssemblyCompany("AI 3D Print Advisor Studio (open source)")]\n'
        '[assembly: AssemblyCopyright("AGPL-3.0, github.com/jtroberts83/AI-Print-Advisor-Studio")]\n'
        f'[assembly: AssemblyVersion({q(version)})] [assembly: AssemblyFileVersion({q(version)})]\n'
        f'static class LauncherInfo {{ public const string Title = {q(title)}; public const string Target = {q(title + ".exe")}; }}\n')
    subprocess.run([csc, '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', f'/out:{dst}',
                    f'/win32icon:{os.path.join(ROOT, "build", "icon.ico")}', '/r:System.Windows.Forms.dll',
                    os.path.join(ROOT, 'tools', 'launcher', 'Launcher.cs'), info], check=True)
    shutil.rmtree(tmp, ignore_errors=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', help='an earlier release folder: its Electron files and bundled node_modules')
    ap.add_argument('--electron', help="Electron's official Windows build, unzipped (electron-vX-win32-x64.zip from github.com/electron/electron releases); used instead of the runtime's Electron files")
    ap.add_argument('--modules', help='an app.asar to take node_modules from (default: from the runtime)')
    ap.add_argument('--rcedit', help='rcedit.exe (github.com/electron/rcedit): sets the program icon, name and version')
    ap.add_argument('--out', required=True)
    ap.add_argument('--recording', help='the recorded tour (rec.jsonl); without it the app has no guided tour');  ap.add_argument('--inventory'); ap.add_argument('--backup'); ap.add_argument('--config')
    ap.add_argument('--no-zip', action='store_true')
    ap.add_argument('--csc', default=CSC, help="the C# compiler that comes with Windows (.NET Framework 4), for the launcher")
    ap.add_argument('--package', action='append', help='an npm .tgz to bundle instead of the runtime copy (repeatable)')
    args = ap.parse_args()
    version = json.load(open(os.path.join(ROOT, 'package.json')))['version']
    # no version in the name: the folder people extract stays the same, and the app updates itself in place
    # (releases/latest/download/AI-3D-Print-Advisor-Studio-win-x64.zip is also a stable link to the newest)
    name = "AI-3D-Print-Advisor-Studio-win-x64"
    top = os.path.join(args.out, name)
    if os.path.exists(top): shutil.rmtree(top)
    out = os.path.join(top, 'app')   # Electron and all its files; the folder above holds only the launcher
    if args.electron:
        shutil.copytree(args.electron, out, ignore=shutil.ignore_patterns('default_app.asar'))
        os.rename(os.path.join(out, 'electron.exe'), os.path.join(out, EXE))
    else:
        shutil.copytree(args.runtime, out, ignore=shutil.ignore_patterns('app.asar', 'app.asar.unpacked', 'app'))
    app = os.path.join(out, 'resources', 'app')
    os.makedirs(app)
    copy_app(app)
    if not args.recording: os.remove(os.path.join(app, 'preload-demo.js'))
    asar_node_modules(args.modules or os.path.join(args.runtime, 'resources', 'app.asar'), app)
    overlay_packages(args.package, app)
    if args.rcedit:
        title = 'AI 3D Print Advisor Studio'
        subprocess.run([args.rcedit, os.path.join(out, EXE), '--set-icon', os.path.join(ROOT, 'build', 'icon.ico'),
                        '--set-version-string', 'FileDescription', title, '--set-version-string', 'ProductName', title,
                        '--set-version-string', 'CompanyName', 'AI 3D Print Advisor Studio (open source)',
                        '--set-version-string', 'LegalCopyright', 'AGPL-3.0, github.com/jtroberts83/AI-Print-Advisor-Studio',
                        '--set-version-string', 'OriginalFilename', os.path.basename(EXE), '--set-version-string', 'InternalName', title,
                        '--set-file-version', version, '--set-product-version', version], check=True)
    if args.recording:
        demo_data(args, os.path.join(app, 'demo'), os.path.join(out, EXE))
    # the printable cheat sheets: in the app (the Glossary and Settings open them) and in their own folder beside the program
    sheets = os.path.join(ROOT, 'docs', 'cheat-sheets')
    if os.path.isdir(sheets):
        for d in (os.path.join(app, 'cheatsheets'), os.path.join(top, 'Printable cheat sheets')):
            os.makedirs(d, exist_ok=True)
            for f in os.listdir(sheets):
                if f.endswith('.pdf'): shutil.copy(os.path.join(sheets, f), d)
    title = 'AI 3D Print Advisor Studio'
    build_launcher(args.csc, os.path.join(top, title + '.exe'), title, version)
    print('Built', top)
    if not args.no_zip:
        # no extra folder inside the zip: Windows' "Extract All" already makes one named after the zip
        z = top + '.zip'
        if os.path.exists(z): os.remove(z)
        with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(top):
                for f in files:
                    full = os.path.join(root, f)
                    zf.write(full, os.path.relpath(full, top))
        print('Zipped', z, f'{os.path.getsize(z) / 1e6:.0f} MB')

if __name__ == '__main__':
    main()
