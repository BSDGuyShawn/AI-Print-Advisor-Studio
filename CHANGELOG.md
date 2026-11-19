# Changelog

## 2.23.1
- **The guide stands out more**: a bright orange window, and the "Click here" highlight and the "Click …" line are
  now bright cyan, so the next thing to click still pops against it.
- **Meet the wizard**: the first guide screen shows an animated wizard waving his wand at a Snapmaker U1, turning a
  spaghetti mess into a dragon. His face is the guide's icon on every step.

## 2.23.0
- **Updates built in.** The app checks GitHub for a new version when it starts and once a day while it's open.
  When there is one, it shows **what's new** since your version, and **Install and restart** updates it **in place**
  (same folder, no new download warnings). Only releases that passed GitHub's virus scan are installed, and the
  download is checked against the published SHA-256 checksum. Settings, API key, filament and history are kept.
  Settings → **Check for updates** (and an option to turn the automatic check off). The download is now called
  `AI-3D-Print-Advisor-Studio-win-x64.zip`, without the version, so the folder stays the same.
- **Snapmaker Orca color mixes** ("Full Spectrum" mixed filaments, where thin layers of 2–4 filaments blend into a
  new color) now show: under the toolheads with their recipe (e.g. T1 60% + T2 40%) and blended color, and in the
  3D view, so the model looks like it does in Snapmaker Orca. Changing a toolhead's color updates its mixes.
- Fixed: a file using color mixes was prepared as if each mix were another real filament (e.g. 7 filaments on a
  4-toolhead U1). Mixes now count as the real filaments they're printed with.
- **Sparkly filament in the 3D view**: galaxy, glitter and sparkle filaments (detected from the filament name, or
  switched with the new ✦ button next to each toolhead) get tiny glinting flakes, like the real thing. Mixes that
  use them sparkle too.
- Guide fixes: it moves on as soon as a model opens (it used to wait until the app finished preparing it), reacts
  to clicks straight away, and says when the app is busy (e.g. slicing for Compare slices) instead of looking stuck.

## 2.22.0
- **Printable cheat sheets** (PDF, US Letter): a **1-page quick sheet** and a **booklet** with setup, why prints
  fail, a troubleshooting table and every 3D printing word with its picture. Open them from the Glossary window or
  Settings; they're also in a "Printable cheat sheets" folder next to the program, and on GitHub.
- **Good to know**, under every set of recommendations and every troubleshooter result: what settings can't fix
  (damp filament, the room and temperature swings, the filament itself, the printer's condition and calibration,
  the model) and that AI can make mistakes, especially with little to go on.
- The guided tour has a new step about this, and points to the cheat sheets.

## 2.21.0
- **The demo is now built into the app** as a one-time **guided tour**: the first time you open the app it walks
  you through every feature on the sample rocket with recorded results (nothing is sliced, printed or sent to AI,
  and your settings and filament aren't touched). **Finish the tour** to unlock the app for your own models: it
  restarts once, fresh, with an empty filament library. It never runs again (Settings → "Take the guided tour
  again" replays it). People who already used the app aren't sent through it. There's no separate DEMO download
  any more.
- New tour steps: the **Glossary** (a great way to learn the terms), **Settings** (the gear) and the **API key**:
  where to paste it, why the app needs one (it works with Claude on its own; a chatbot needs copy and paste every
  time) and what it costs (a few cents per analysis). A key saved during the tour is kept.
- The experience level picked in the tour carries over.

## 2.20.1
- Removed the optional Anthropic **Admin API key** and the "Check this month on Anthropic" button from
  Settings → AI spending: they only worked for Anthropic organizations. Any admin key saved earlier is deleted
  the next time Settings is saved. Settings now links to your **API keys page** in the Claude Console, which
  shows what your key has cost in total. The app's own record of what it spent stays.

## 2.20.0
- **Guide you can't miss**: the step-by-step guide (beginners and the demo) is bigger and brighter, and at every
  step a pulsing orange **Click here** ring sits on the exact button to press next, with "Click ..." spelled out in
  the guide. It follows you through windows step by step (Color remix: Identify parts, Confirm parts, Generate,
  Apply to model; the troubleshooter; the demo's model picker; the Filament screen).
- The guide moves itself to whichever corner doesn't cover the button to click or the window's other buttons, so
  it no longer sits on top of what you need (it used to cover "Generate" in Color remix).

## 2.19.2
- Word explanations: **STL file** has its own picture (it showed the 3MF one), and the **3MF file** picture
  labels all three parts: model, colors and settings.

## 2.19.1
- **Tidier download**: the unzipped folder now holds just one program to open (`AI 3D Print Advisor Studio.exe`,
  or `... DEMO.exe`) and an `app` folder with everything else. The zip no longer has a folder inside it, so
  "Extract All" no longer makes a folder within a folder of the same name.

## 2.19.0
- **3D printing words explained** (for "Brand new" and "A little"): words like brim, infill, nozzle, prime tower,
  purge, "Generic PLA", toolhead and about 45 others get a dotted underline. Hover over one to see a plain-language
  explanation with a drawing; click it to keep the explanation open. Works everywhere in the app, including open
  windows (Color remix, Settings) and the Filament screen, in the full app and the demo.
- **Glossary** button at the top: every word with its drawing, searchable.
- Settings: "Explain 3D printing words" switch, so anyone can turn the underlines on or off.

## 2.18.0
- **Runs on Electron 45.4.1** (was 33.2.1), the official build from the Electron project. Clears the published
  Chromium/Electron security advisories and the antivirus "packed program" flag some scanners raised on the
  old launcher. Saved API keys keep working.
- New app icon; the program shows its own name and version in Windows.
- **Very large models open**: model files bigger than JavaScript can hold as text (a 619 MB MakerWorld model) are
  read in chunks, and **Fix model** lightens them (6.9 million → 1 million triangles in about a minute).
- meshoptimizer 1.3.0 for Fix model.
- Product photos: honours a store's "try again in N seconds", and falls back to the product's .json data or the
  page's preview picture when a store doesn't offer the usual product data.
- AI spending shows tiny costs (under a hundredth of a cent) instead of rounding them to zero.

## 2.17.1
- Security: updated the `ws` library (used to talk to printers) from 8.18.0 to 8.23.0 to fix two published
  high-severity advisories (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p), and `jszip` from 3.10.1 to 3.10.2.
  Found by the repository's new dependency audit.

## 2.17.0
- **Filament screen** (Filament button, top right): the Filament Inventory web page is now part of the app. You can track
  spools, statuses, weigh-ins, locations, labels, a dashboard, manufacturer print settings and U1 Orca presets.
  - Data lives in the app's data folder (`filament\`), with a daily backup for two weeks.
  - Color remix and the what-to-buy check use what's on hand on this screen. The old "Filament Inventory folder"
    setting is only a fallback until you import.
  - **Import from Filament Inventory…** brings in the old page's orders, product photos and (from its downloaded
    backup) every spool.
  - **📷 From screenshot** and **Find missing photos online** use the API key from Settings. The key stays in the
    app; store pages and photos are fetched by the app, so browser restrictions no longer apply.
- No separate Filament Inventory web page any more: the "inventory folder" setting and its import are gone
  (tools/import_filament_inventory.js remains for a one-time move of old data).
- **Demo app** (built by tools/build_release.py --demo): a guided tour with a sample 4-color rocket
  (tools/make_demo_rocket.py, CC0) and a MakerWorld/Bambu version of it, replaying results recorded from the real
  app (preload-demo.js). Nothing is sliced, saved, sent or asked of the AI; a banner says so.
- Orientation options are named by what happens to the model ("Stood upright", "Laid down") instead of "On its
  side" for a model saved lying down.
- Compare slices: "Finest/Fine/Fast/Fastest + recommendations" keep the recipe's own layer height and speeds; the
  AI's layer height no longer overrides them (Finest could come out the same as Recommended).
- Times round correctly (2h 0m, not 1h 60m).
- **AI spending**: every Claude answer is priced from its token counts (list prices, web searches included) and
  kept in ai-spend.json. An "AI" counter in the top bar flashes each request's cost and shows the month's total;
  Settings → AI spending lists this month, the last 30 days and all time, by feature, with the latest requests.
  Optional Admin API key (organizations only): "Check this month on Anthropic" reads Anthropic's own figure for
  the whole account and for this app's key (Usage and Cost Analytics API).
- The guide stays visible and clickable over windows like Color remix and the troubleshooter.
- **Get recommended settings** slices only the original model (the AI needs it). It no longer also slices the
  recommended version for Compare slices; do that in Compare slices when you want it. Sending a print still
  slices on demand.

## 2.16.1
- Source as received (baseline).
