"""Build the NFC/RFID spool tag reader (tools/spoolscan) into a standalone folder the app can ship.

    python tools/build_spoolscan.py --out <folder>

Needs Python 3.10+ with:  pip install pyinstaller ./tools/spoolscan
Produces <folder>/spoolscan/spoolscan.exe (plus its _internal folder). Pass that <folder>/spoolscan to
tools/build_release.py with --spoolscan, or copy it next to main.js as ./spoolscan/ to try it from source.

A folder build (not --onefile) starts instantly and isn't unpacked to a temp folder on every launch, which
antivirus tools tend to flag.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'spoolscan')
VENDOR = os.path.join(SRC, 'spoolscan', '_vendor', 'openrfid')


def vendor_data(sep):
    """--add-data for every non-Python file the decoders read at runtime (schemas, ID databases)."""
    args = []
    for dirpath, _dirs, files in os.walk(VENDOR):
        if '__pycache__' in dirpath:
            continue
        rel = os.path.relpath(dirpath, VENDOR)
        for name in files:
            if name.endswith(('.py', '.pyc')) or rel == '.':
                continue
            args += ['--add-data', f'{os.path.join(dirpath, name)}{sep}{rel.replace(os.sep, "/")}']
    return args


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='folder to put the spoolscan folder in')
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    sep = os.pathsep
    with tempfile.TemporaryDirectory() as work:
        entry = os.path.join(work, 'spoolscan_main.py')
        with open(entry, 'w') as f:
            f.write('import sys\nfrom spoolscan.cli import main\nsys.exit(main())\n')
        cmd = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console',
               '--name', 'spoolscan', '--distpath', out, '--workpath', os.path.join(work, 'build'), '--specpath', work,
               '--paths', SRC, '--paths', VENDOR,
               # the brand decoders are imported by name from the vendored OpenRFID folder
               *[a for pkg in ('tag', 'filament', 'config', 'reader') for a in ('--collect-submodules', pkg)],
               '--hidden-import', 'smartcard.pcsc.PCSCReader',
               *vendor_data(sep),
               '--add-data', f'{os.path.join(VENDOR, "LICENSE")}{sep}licenses/OpenRFID',
               '--add-data', f'{os.path.join(VENDOR, "VENDORED.txt")}{sep}licenses/OpenRFID',
               '--add-data', f'{os.path.join(SRC, "LICENSE")}{sep}licenses/spoolscan',
               entry]
        subprocess.run(cmd, check=True)
    exe = os.path.join(out, 'spoolscan', 'spoolscan.exe' if os.name == 'nt' else 'spoolscan')
    if not os.path.exists(exe):
        sys.exit(f'build finished but {exe} is missing')
    # quick self-test: decode a known tag dump with the built program
    fixture = os.path.join(SRC, 'tests', 'fixtures', 'Bambu', 'PLA-Basic-Bronze.bin')
    r = subprocess.run([exe, 'decode', fixture], capture_output=True, text=True)
    if r.returncode != 0 or '"bambu"' not in r.stdout:
        sys.exit(f'self-test failed:\n{r.stdout}\n{r.stderr}')
    print('Built and self-tested', exe)


if __name__ == '__main__':
    main()
