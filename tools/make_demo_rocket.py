"""Make the demo model: a 4-color toy rocket, saved as a Snapmaker U1 project with deliberate problems.

    python tools/make_demo_rocket.py <project_settings template .3mf> <output .3mf>
    python tools/make_demo_rocket.py --makerworld <Bambu Lab 4-filament .3mf> <output .3mf>

--makerworld makes the "downloaded from MakerWorld" version for the second demo tour: the same rocket standing
upright with the template's own (sensible) Bambu Lab settings, saved as a Bambu Studio project for a Bambu
printer, which is what a U1 owner gets from MakerWorld and has to convert.

The rocket is generated here (no third-party design in it), so it can ship with the demo app.
Colors (painted per triangle, like Orca's color painting):
  T1 white  body            T2 red   nose cone and three fins
  T3 blue   three portholes T4 grey  engine nozzle
Problems built in, for the app to find:
  - saved LYING ON ITS SIDE: big overhangs under the body and fins; standing it upright needs no supports
  - supports off while lying down
  - 0.08 mm layers (very slow for a toy), 1 wall, 5% infill, 2 top layers, no brim for a tall, narrow part
Only the print settings come from the template (a Snapmaker Orca U1 project with 4 filaments); none of its model.
"""
import io
import json
import math
import sys
import zipfile

SEG = 64

class Mesh:
    def __init__(self):
        self.v, self.t = [], []   # t: (a, b, c, paint)
    def add(self, verts, tris, paint):
        o = len(self.v)
        self.v += verts
        paints = paint if isinstance(paint, list) else [paint] * len(tris)   # one color, or one per triangle
        self.t += [(a + o, b + o, c + o, p) for (a, b, c), p in zip(tris, paints)]

def lathe(profile, paint, seg=SEG):
    """Solid of revolution around Z. profile: [(r, z)] from bottom to top; r=0 ends become a single point."""
    verts, tris, rings = [], [], []
    for r, z in profile:
        if r == 0:
            rings.append([len(verts)]); verts.append((0.0, 0.0, z))
        else:
            ring = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                ring.append(len(verts)); verts.append((r * math.cos(a), r * math.sin(a), z))
            rings.append(ring)
    for lo, hi in zip(rings, rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            if len(lo) == 1: tris.append((lo[0], hi[j], hi[i]))
            elif len(hi) == 1: tris.append((lo[i], lo[j], hi[0]))
            else: tris += [(lo[i], lo[j], hi[j]), (lo[i], hi[j], hi[i])]
    # caps where a ring is the first/last
    for ring, up in ((rings[0], False), (rings[-1], True)):
        if len(ring) == 1: continue
        z = verts[ring[0]][2]
        c = len(verts); verts.append((0.0, 0.0, z))
        for i in range(seg):
            j = (i + 1) % seg
            tris.append((c, ring[i], ring[j]) if up else (c, ring[j], ring[i]))
    return verts, tris, paint

def lathe_bands(profile, paints, seg=SEG):
    """One closed solid of revolution with a color per band: paints[i] is for profile[i] -> profile[i+1].
    The bottom cap gets the first band's color, a flat top cap the last one's."""
    verts, tris, paint = [], [], []
    rings = []
    for r, z in profile:
        if r == 0: rings.append([len(verts)]); verts.append((0.0, 0.0, z))
        else:
            ring = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                ring.append(len(verts)); verts.append((r * math.cos(a), r * math.sin(a), z))
            rings.append(ring)
    for k, (lo, hi) in enumerate(zip(rings, rings[1:])):
        for i in range(seg):
            j = (i + 1) % seg
            if len(lo) == 1: t = [(lo[0], hi[j], hi[i])]
            elif len(hi) == 1: t = [(lo[i], lo[j], hi[0])]
            else: t = [(lo[i], lo[j], hi[j]), (lo[i], hi[j], hi[i])]
            tris += t; paint += [paints[k]] * len(t)
    for ring, up, pc in ((rings[0], False, paints[0]), (rings[-1], True, paints[-1])):
        if len(ring) == 1: continue
        z = verts[ring[0]][2]
        c = len(verts); verts.append((0.0, 0.0, z))
        for i in range(seg):
            j = (i + 1) % seg
            tris.append((c, ring[i], ring[j]) if up else (c, ring[j], ring[i])); paint.append(pc)
    return verts, tris, paint

def prism(poly, y0, y1, paint):
    """Extrude a 2D polygon (x, z), counter-clockwise seen from -Y, between y0 and y1."""
    n = len(poly)
    verts = [(x, y0, z) for x, z in poly] + [(x, y1, z) for x, z in poly]
    tris = []
    for i in range(1, n - 1):
        tris.append((0, i, i + 1))             # front (y0), facing -Y
        tris.append((n, n + i + 1, n + i))     # back (y1), facing +Y
    for i in range(n):
        j = (i + 1) % n
        tris += [(i, n + j, j), (i, n + i, n + j)]
    return verts, tris, paint

def rotz(verts, ang):
    c, s = math.cos(ang), math.sin(ang)
    return [(x * c - y * s, x * s + y * c, z) for x, y, z in verts]

def porthole(r_body, z, ang, paint, r=5.0, out=1.4, seg=40):
    """A disc on the body surface, axis horizontal, pointing outward at angle ang."""
    verts, tris, _ = lathe([(r, -1.5), (r, out)], paint, seg)   # axis along Z, from inside the wall to out
    # turn the disc's Z axis to point along +X, then move it to the body surface and rotate around the rocket
    v = [(zz + r_body, y, -x + z) for x, y, zz in verts]
    return rotz(v, ang), tris, paint

def rocket():
    m = Mesh()
    WHITE, RED, BLUE, GREY = None, '8', '0C', '1C'   # paint codes: none = the object's filament (T1); 8 = T2; 0C = T3; 1C = T4
    R = 15.0
    # nozzle, body and nose are one closed solid (no hidden faces inside): nozzle flares out going up, a 45°
    # shoulder to the body, then the nose cone
    m.add(*lathe_bands([(9.0, 0.0), (12.0, 12.0), (R, 15.0), (R, 82.0), (R * 0.75, 95.0), (R * 0.4, 106.0), (0, 114.0)],
                       [GREY, WHITE, WHITE, RED, RED, RED]))
    fin = [(R - 2, 0.0), (31.0, 0.0), (31.0, 10.0), (R - 2, 42.0)]           # sloped top edge: no overhang upright
    for k in range(3):
        v, t, p = prism(fin, -1.6, 1.6, RED)
        m.add(rotz(v, 2 * math.pi * k / 3), t, p)
    for k in range(3):
        m.add(*porthole(R - 0.2, 58.0, 2 * math.pi * k / 3 + math.pi / 3, BLUE))
    return m

def lay_on_side(verts):
    """Rocket axis Z -> X (lying down), resting on the bed, centered on the U1 bed."""
    v = [(z, y, -x) for x, y, z in verts]
    minx = min(p[0] for p in v); maxx = max(p[0] for p in v)
    miny = min(p[1] for p in v); maxy = max(p[1] for p in v)
    minz = min(p[2] for p in v)
    cx, cy = 135 - (minx + maxx) / 2, 135 - (miny + maxy) / 2
    return [(x + cx, y + cy, z - minz) for x, y, z in v]

def stand_up(verts):
    """Upright on the bed, centered on a 256 mm Bambu bed."""
    minx = min(p[0] for p in verts); maxx = max(p[0] for p in verts)
    miny = min(p[1] for p in verts); maxy = max(p[1] for p in verts)
    minz = min(p[2] for p in verts)
    cx, cy = 128 - (minx + maxx) / 2, 128 - (miny + maxy) / 2
    return [(x + cx, y + cy, z - minz) for x, y, z in verts]

def model_xml(m):
    out = io.StringIO()
    out.write('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n')
    out.write(' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n  <object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model">\n   <mesh>\n    <vertices>\n')
    for x, y, z in m.v: out.write(f'     <vertex x="{x:.4f}" y="{y:.4f}" z="{z:.4f}"/>\n')
    out.write('    </vertices>\n    <triangles>\n')
    for a, b, c, p in m.t: out.write(f'     <triangle v1="{a}" v2="{b}" v3="{c}"' + (f' paint_color="{p}"' if p else '') + '/>\n')
    out.write('    </triangles>\n   </mesh>\n  </object>\n </resources>\n</model>\n')
    return out.getvalue()

MAIN = '''<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">Snapmaker_Orca-2.4.1</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">Demo Rocket</metadata>
 <metadata name="Designer">AI 3D Print Advisor Studio demo</metadata>
 <metadata name="License">CC0</metadata>
 <resources>
  <object id="2" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">
   <components>
    <component p:path="/3D/Objects/Rocket_1.model" objectid="1" p:UUID="00010000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">
  <item objectid="2" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>
'''
RELS_MODEL = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/Rocket_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
'''
RELS = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
'''
TYPES = '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
'''
MODEL_SETTINGS = '''<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="Rocket"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="Rocket"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="1"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="101"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />
  </assemble>
</config>
'''

def settings(template, makerworld=False):
    ps = json.loads(zipfile.ZipFile(template).read('Metadata/project_settings.config'))
    assert len(ps['filament_colour']) == 4, 'the template needs 4 filaments'
    if makerworld:   # the designer's Bambu settings, only the colors changed
        ps.update({'filament_colour': ['#FFFFFF', '#D32F2F', '#1E5BD0', '#8A8A8A'], 'filament_type': ['PLA'] * 4})
        return json.dumps(ps, indent=4)
    ps.update({
        'filament_colour': ['#FFFFFF', '#D32F2F', '#1E5BD0', '#8A8A8A'],
        'filament_type': ['PLA'] * 4,
        'layer_height': '0.08', 'initial_layer_print_height': '0.2',
        'wall_loops': '1', 'sparse_infill_density': '5%', 'top_shell_layers': '2', 'bottom_shell_layers': '3',
        'enable_support': '0', 'brim_type': 'no_brim',
    })
    changed = 'bottom_shell_layers;brim_type;enable_support;initial_layer_print_height;layer_height;sparse_infill_density;top_shell_layers;wall_loops'
    d = ps.get('different_settings_to_system') or [''] * 6
    d[0] = changed
    ps['different_settings_to_system'] = d
    return json.dumps(ps, indent=4)

def main():
    args = sys.argv[1:]
    makerworld = '--makerworld' in args
    template, out = [a for a in args if a != '--makerworld']
    m = rocket()
    m.v = stand_up(m.v) if makerworld else lay_on_side(m.v)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('3D/3dmodel.model', MAIN.replace('Snapmaker_Orca-2.4.1', 'BambuStudio-02.04.00.70') if makerworld else MAIN)
        z.writestr('3D/_rels/3dmodel.model.rels', RELS_MODEL)
        z.writestr('3D/Objects/Rocket_1.model', model_xml(m))
        z.writestr('Metadata/model_settings.config', MODEL_SETTINGS)
        z.writestr('Metadata/project_settings.config', settings(template, makerworld))
    xs = [p[0] for p in m.v]; ys = [p[1] for p in m.v]; zs = [p[2] for p in m.v]
    print(f'{out}: {len(m.v)} vertices, {len(m.t)} triangles, size {max(xs)-min(xs):.0f} x {max(ys)-min(ys):.0f} x {max(zs)-min(zs):.0f} mm')

if __name__ == '__main__':
    main()
