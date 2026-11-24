"""Regenerate src/per-object-keys.json: the settings OrcaSlicer lets you set on one object (right-click an object ->
Add settings), i.e. the options of PrintObjectConfig and PrintRegionConfig in OrcaSlicer's src/libslic3r/PrintConfig.hpp.
Everything else (PrintConfig: first layer height, travel speed, prime tower..., filament and printer settings) applies
to the whole plate. Snapmaker Orca is an OrcaSlicer fork with the same split.

usage: python tools/gen_per_object_keys.py <path to PrintConfig.hpp> [source description]
"""
import json, re, sys, os, datetime

src = open(sys.argv[1], encoding='utf-8').read()
source = sys.argv[2] if len(sys.argv) > 2 else 'OrcaSlicer src/libslic3r/PrintConfig.hpp'


def block(name):
    i = src.index(f'PRINT_CONFIG_CLASS_DEFINE(\n    {name},')
    j = src.index('\n)', i)
    return re.findall(r'\(\(\s*[^,()]+(?:<[^>]*>)?\s*,\s*(\w+)\s*\)\)', src[i:j])


keys = sorted(set(block('PrintObjectConfig')) | set(block('PrintRegionConfig')))
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'per-object-keys.json')
json.dump({'source': source, 'generated': datetime.date.today().isoformat(), 'keys': keys}, open(out, 'w', encoding='utf-8', newline='\n'), indent=1)
print(f'{len(keys)} keys -> {os.path.normpath(out)}')
