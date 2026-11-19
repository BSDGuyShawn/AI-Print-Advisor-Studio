// Manufacturer print settings per product line, and the Snapmaker Orca (U1) preset built from them.
// Key: "Brand|Line" or "Brand|Line|Finish" (the more specific key wins).
//   n / b / d    nozzle °C, bed °C, drying, as the manufacturer states them
//   spd          max print speed the manufacturer states
//   src          where the numbers came from
//   base         Snapmaker Orca system preset the U1 preset inherits from (cooling, retraction, flow, etc.)
//   preset       name of the preset in Snapmaker Orca (a file in profiles/ unless system:true)
//   nz / bd      the values written into the preset (picked from inside the manufacturer range)
//   note         anything worth knowing
const SPECS = {
"Polymaker|Panchroma Translucent": {"n":"190–230","b":"25–60","d":"55 °C · 6 h","spd":"up to 300 mm/s","src":"Amazon listing + Polymaker TDS","base":"Polymaker General PLA Family @U1","preset":"Polymaker Panchroma Translucent @Snapmaker U1","nz":220,"bd":55},
"Polymaker|Panchroma Matte": {"n":"190–230","b":"25–60","d":"55 °C · 6 h","spd":"up to 300 mm/s","src":"Amazon listing + Polymaker TDS","base":"Polymaker General PLA Family @U1","preset":"Polymaker Panchroma Matte @Snapmaker U1","nz":220,"bd":55},
"Polymaker|Panchroma Basic": {"n":"190–230","b":"20–60","d":"55 °C · 6 h","spd":"up to 300 mm/s","src":"Amazon listing + Polymaker TDS","base":"Polymaker General PLA Family @U1","preset":"Polymaker Panchroma Basic @Snapmaker U1","nz":220,"bd":55},
"Polymaker|Panchroma Crystal Gradient": {"n":"190–230","b":"25–60","d":"55 °C · 6 h","src":"Polymaker Panchroma PLA TDS","base":"Polymaker General PLA Family @U1","preset":"Polymaker Panchroma Crystal @Snapmaker U1","nz":220,"bd":55},
"Polymaker|Panchroma Silk": {"n":"190–230","b":"25–60","d":"55 °C · 6 h","src":"Polymaker Panchroma Silk TDS","base":"Polymaker Silk PLA Family @U1","preset":"Polymaker Panchroma Silk @Snapmaker U1","nz":225,"bd":55},
"Polymaker|Panchroma Dual Silk": {"n":"190–230","b":"25–60","d":"55 °C · 6 h","src":"Polymaker Panchroma Silk TDS","base":"Polymaker Silk PLA Family @U1","preset":"Polymaker Panchroma Silk @Snapmaker U1","nz":225,"bd":55},
"Polymaker|Panchroma Gradient Silk": {"n":"190–230","b":"25–60","d":"55 °C · 6 h","src":"Polymaker Panchroma Silk TDS","base":"Polymaker Silk PLA Family @U1","preset":"Polymaker Panchroma Silk @Snapmaker U1","nz":225,"bd":55},
"Polymaker|PolyLite PLA Pro": {"n":"210–230","b":"20–60","d":"55 °C · 6 h","spd":"up to 500 mm/s","src":"Amazon listing","base":"Generic PLA","preset":"PolyLite PLA Pro @Snapmaker U1","existing":true,"nz":225,"bd":55,"note":"Uses the preset you already made in Snapmaker Orca."},
"Polymaker|PETG": {"n":"240–260","b":"60–70","d":"65 °C · 6 h","src":"Amazon listing","base":"Generic PETG","preset":"Polymaker PETG @Snapmaker U1","nz":250,"bd":70},
"Polymaker|PETG Galaxy": {"n":"240–260","b":"60–70","d":"65 °C · 6 h","src":"Amazon listing","base":"Generic PETG","preset":"Polymaker PETG @Snapmaker U1","nz":250,"bd":70},
"Polymaker|ABS": {"n":"245–265","b":"90–100","d":"80 °C · 6 h","src":"Amazon listing","base":"Generic ABS","preset":"Polymaker ABS @Snapmaker U1","nz":255,"bd":95,"note":"Keep the U1 enclosure closed; ABS warps in drafts."},
"BIQU|PLA": {"n":"190–230","b":"50–60","src":"Typical PLA (BIQU doesn't publish numbers for the PopCap spools)","base":"Generic PLA","preset":"Generic PLA","system":true,"nz":220,"bd":65},
"JAYO|Rapid PLA": {"n":"210–235","b":"55–65","src":"JAYO website (PLA line; Rapid PLA isn't listed separately)","base":"Generic PLA High Speed","preset":"JAYO Rapid PLA @Snapmaker U1","nz":220,"bd":60},
"SUNLU|Silk PLA+": {"n":"205–215","b":"60–80","src":"Amazon listing","base":"Generic PLA Silk","preset":"SUNLU Silk PLA+ @Snapmaker U1","nz":215,"bd":60},
"SUNLU|Silk PLA 2.0": {"n":"205–235","b":"50–60","src":"Amazon listing","base":"Generic PLA Silk","preset":"SUNLU Silk PLA 2.0 @Snapmaker U1","nz":220,"bd":55},
"SUNLU|PLA Matte": {"n":"200–230","b":"50–65","src":"Amazon listing","base":"Generic PLA","preset":"SUNLU PLA Matte @Snapmaker U1","nz":215,"bd":60},
"SUNLU|PETG": {"n":"240–260","b":"60–70","src":"Amazon listing","base":"Generic PETG","preset":"SUNLU PETG Translucent @Snapmaker U1","nz":250,"bd":65},
"SUNLU|PETG|Matte": {"n":"240–250","b":"70–80","spd":"50–100 mm/s at 205–215 °C · 100–300 mm/s at 240–250 °C · 300–600 mm/s at 260–270 °C","src":"Amazon listing","base":"Generic PETG HF","preset":"SUNLU High Speed Matte PETG @Snapmaker U1","nz":245,"bd":75},
"SUNLU|PETG 2.0": {"n":"240–270","b":"70–80","src":"Amazon listing","base":"Generic PETG","preset":"SUNLU PETG 2.0 @Snapmaker U1","nz":250,"bd":75},
"Flashforge|PLA Color Change": {"n":"190–220","b":"25–60","src":"Flashforge Chameleon PLA manual","base":"Generic PLA","preset":"Flashforge PLA Color Change @Snapmaker U1","nz":210,"bd":55},
"Flashforge|PETG-CF": {"n":"230–260","b":"60–80","src":"Amazon listing (comparison table)","base":"Generic PETG-CF","preset":"Flashforge PETG-CF @Snapmaker U1","nz":250,"bd":70,"note":"Carbon fiber is abrasive. A hardened nozzle is recommended."},
"Elegoo|Rapid PETG": {"n":"240–270","b":"70–80","src":"Amazon listing (nozzle); bed is a typical PETG range","base":"Generic PETG HF","preset":"Elegoo Rapid PETG @Snapmaker U1","nz":250,"bd":75},
"Elegoo|PLA+": {"n":"200–230","b":"50–60","spd":"up to 280 mm/s","src":"Amazon listing (nozzle); bed is a typical PLA range","base":"Generic PLA","preset":"Elegoo PLA+ @Snapmaker U1","nz":215,"bd":60},
"iSANMATE|HF PETG": {"n":"230–260","b":"60–80","d":"55–65 °C","src":"Amazon listing","base":"Generic PETG HF","preset":"iSANMATE HF PETG @Snapmaker U1","nz":245,"bd":70},
"Creality|PETG": {"n":"220–250","b":"70–80","src":"Amazon listing","base":"Generic PETG","preset":"Creality PETG @Snapmaker U1","nz":240,"bd":75},
"Overture|Rapid PETG": {"n":"230–260","b":"65–70","src":"Amazon listing","base":"Generic PETG HF","preset":"Overture Rapid PETG @Snapmaker U1","nz":245,"bd":70},
"Overture|Matte PLA": {"n":"190–220","b":"50–70","src":"Amazon listing","base":"Generic PLA","preset":"Overture Matte PLA @Snapmaker U1","nz":210,"bd":60},
"Overture|Rainbow PLA": {"n":"200–220","b":"50–60","src":"Amazon listing","base":"Generic PLA","preset":"Overture Rainbow PLA @Snapmaker U1","nz":210,"bd":55},
"YOOPAI|PETG": {"n":"230–260","b":"65–75","src":"Amazon listing","base":"Generic PETG","preset":"YOOPAI PETG @Snapmaker U1","nz":245,"bd":70},
"YXPOLYER|PLA+": {"n":"190–220","b":"25–45","src":"Amazon listing","base":"Generic PLA","preset":"YXPOLYER PLA+ @Snapmaker U1","nz":210,"bd":45},
"PlastKyro|Matte PETG": {"n":"230–260","b":"50–80","d":"60–65 °C","src":"Amazon listing","base":"Generic PETG","preset":"PlastKyro Matte PETG @Snapmaker U1","nz":245,"bd":70},
"UJOY3D|PETG Metal": {"n":"235–255","b":"75–80","src":"Amazon listing","base":"Generic PETG","preset":"UJOY3D PETG Metal @Snapmaker U1","nz":245,"bd":75},
"Stronghero3D|Silk PETG": {"n":"220–250","b":"65–75","src":"Amazon listing","base":"Generic PETG","preset":"Stronghero3D Silk PETG @Snapmaker U1","nz":240,"bd":70},
"XZN|PETG": {"n":"220–260","b":"70–80","src":"Amazon listing","base":"Generic PETG","preset":"XZN PETG Metallic @Snapmaker U1","nz":240,"bd":75},
"Geeetech|PETG": {"n":"220–230","b":"70–80","d":"80 °C · 4–6 h","src":"Geeetech wiki (standard PETG) + Amazon listing (drying)","base":"Generic PETG","preset":"Geeetech PETG Metallic @Snapmaker U1","nz":230,"bd":75,"note":"Metal-powder PETG absorbs moisture faster than plain PETG. Dry it before printing."},
"Geeetech|Matte PLA": {"n":"190–220","b":"50–70","src":"3DJake listing for Geeetech Matte PLA","base":"Generic PLA","preset":"Geeetech Matte PLA @Snapmaker U1","nz":205,"bd":60},
"3D-Fuel|Pro PCTG": {"n":"250–270","b":"80","src":"Amazon listing","base":"Generic PCTG","preset":"3D-Fuel Pro PCTG @Snapmaker U1","nz":260,"bd":80},
"kexcelled|Matte PETG": {"n":"225–245","b":"70–80","spd":"40–80 mm/s","src":"Kexcelled PETG K5 TDS (no separate matte sheet)","base":"Generic PETG","preset":"Kexcelled Matte PETG @Snapmaker U1","nz":240,"bd":75},
"VOXEL|PLA+ HS (Pro)": {"n":"200–220","b":"45–60","src":"voxelpla.com","note":"The spool label says 200–230 °C.","base":"Generic PLA High Speed","preset":"VOXEL PLA+ HS @Snapmaker U1","nz":215,"bd":55},
"VOXEL|Galaxy PLA+ HS (Pro)": {"n":"230–265","b":"70–85","src":"voxelpla.com + spool label","base":"Generic PLA High Speed","preset":"VOXEL Galaxy PLA+ HS @Snapmaker U1","nz":230,"bd":60,"note":"VOXEL lists PETG-like temperatures for this PLA, on both the website and the spool. That looks like a copy-paste error, so the preset uses 230 °C nozzle and 60 °C bed. Run a temperature tower to confirm."},
"VOXEL|PETG+ HS (Pro)": {"n":"230–270","b":"70–85","src":"voxelpla.com","base":"Generic PETG HF","preset":"VOXEL PETG+ HS @Snapmaker U1","nz":250,"bd":75},
"VOXEL|Galaxy PETG+ HS (Pro)": {"n":"230–265","b":"70–85","src":"voxelpla.com","base":"Generic PETG HF","preset":"VOXEL Galaxy PETG+ HS @Snapmaker U1","nz":250,"bd":75},
"Snapmaker|SnapSpeed PLA": {"n":"190–240","b":"65","spd":"up to 300 mm/s","src":"Snapmaker's own U1 profile","preset":"Snapmaker PLA SnapSpeed @U1","system":true,"nz":220,"bd":65},
"Snapmaker|Matte PLA": {"n":"190–240","b":"65","src":"Snapmaker's own U1 profile","preset":"Snapmaker PLA Matte @U1","system":true,"nz":215,"bd":65},
"Snapmaker|Wood PLA": {"n":"190–240","b":"65","src":"Snapmaker's own U1 profile","preset":"Snapmaker PLA Wood @U1 0.4 nozzle","system":true,"nz":220,"bd":65},
"Snapmaker|PETG-CF": {"n":"240–270","b":"80","src":"Snapmaker's own U1 profile","preset":"Snapmaker PETG-CF @U1 0.4 nozzle","system":true,"nz":255,"bd":80,"note":"Carbon fiber is abrasive. A hardened nozzle is recommended."}
};
