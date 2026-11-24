# Changelog

## 2.35.0
- **Safety: a print that would leave the bed is never sent.** A wider brim or skirt next to the bed edge pushed a
  print's first layer past the front of the U1's bed (the printer stopped with "Axis movement anomaly … Y-axis movement
  exceeded travel limit"). Every move of the sliced print is now checked against the printable area before sending;
  when it doesn't fit, the app moves the print back on by the measured amount, slices again and checks again, and if
  it still doesn't fit, **Print is blocked** (the upload itself refuses it too).
- **Checked before every print** (like Snapmaker Orca does before it lets you print): outside the bed, too tall, no
  layers, no extrusion, a layer too thick for the nozzle, broken numbers, temperatures out of range, a cut-short file,
  and errors Snapmaker Orca reported while slicing. Real problems block Print; the rest are shown as warnings.
- **Preview of the sliced print** in Send to printer: the exact file that will be sent, in 3D, in Orca's colours, with
  each feature (walls, infill, supports, skirt, brim…) shown or hidden and a layer slider.

## 2.34.2
- **The troubleshooter opens the plate that was printed.** For prints whose file name doesn't say the plate, it matches
  the objects in the printed G-code to the model's plates (e.g. "Wings Redo" → the plate with the two wings). A
  **Plate** chooser shows every plate and how many printed objects it matches; your choice is remembered for that print.
  Print fixed version, Save fixed 3MF and Use these settings use that plate.
- Fixed: **Settings in this print** reported per-object settings as missing. Orca renumbers objects in the sliced
  project it exports, so they're now matched by name (they were in the print; the check looked in the wrong place).

## 2.34.1
- **Send to printer shows the settings the print will really use**, read back from the sliced file that is about to be
  sent (not from what the app meant to change): every changed setting with ✓, or ⚠ when it isn't in the print, the layer
  height measured from the toolpaths themselves, settings on single objects checked in the sliced project, and the
  print's main settings (layer height, walls, infill, supports, temperatures).
- Send to printer always slices the version exactly as it's ticked now (it could reuse an earlier slice of it).
- Fixed: after **Use these settings** in the troubleshooter, the fixes and the Send to printer / Save buttons stayed
  hidden behind the empty Recommendations page.
- **🖨 Print fixed version…** in the troubleshooter: prints the model with every fix you ticked (the layer height
  included), straight from the app: it opens the printer dialog with the fixed version sliced and ready.
- **The troubleshooter keeps its diagnosis.** Reopening a print shows its last diagnosis right away, with no new AI
  request (before, a print just diagnosed still looked undiagnosed until the history was reloaded, which invited
  paying for the same diagnosis again). Earlier diagnoses of that print are in a list (the ones that change the layer
  height are marked); **Run a new diagnosis with Claude** asks again only when you want. Your ticks and edited values
  are kept, and the model you picked for that print is remembered.
- **Troubleshooter fixes stay** when you then click Get new recommendations: the new advice is added, the fixes are
  kept (marked “From the troubleshooter”), and Send to printer / Save as 3MF use all of them.

## 2.34.0
- **Settings per object, in one file.** Files with several plates, or several different objects on a plate, can now
  get different settings for different objects, saved on the objects themselves (the same as right-click → Add settings
  in Orca). Checked with Snapmaker Orca's own slicer: each object prints with its own walls, infill, layer height…
  - **Saving recommendations for one plate** of a multi-plate file now changes only that plate's objects; the other
    plates keep their settings. Settings Orca can't set per object (filament temperatures, first-layer height, prime
    tower…) still apply to the whole file, and the app says which.
  - **Troubleshooter → Save fixed 3MF** puts the fixes only on the plate that was printed.
  - **Analyze all objects (N)**, next to Get recommended settings: one AI request per *different* object (copies and
    near-identical objects, like a set of similar pegs, are analyzed once and share the settings). Shows the number of
    requests and the expected cost first. Then pick an object to see and edit its settings; settings that must be the
    same for a whole plate are listed once, and when objects disagree you choose the value. Save, Compare, Send and
    Open in Orca use every object's settings.
- **Fixed: a new layer height could be ignored in Orca.** Some models set their own layer height on the object, or use
  a variable layer height; Orca uses those instead of the project's layer height, so the file still printed (and showed)
  the old one. Changing the layer height now removes them where they'd override it, and says so. Height ranges the
  designer set (e.g. a finer section) are kept.

## 2.33.0
- **Take the troubleshooter's photos with your phone**: in the print troubleshooter click **📱 Take photos with your
  phone** and scan the QR code. Your phone opens a page with a big **📷 Take a photo** button. Already took them? **🖼 Choose
  from your photos** or **📁 Browse the phone's files** (Downloads, other folders), several at once. Each photo appears in
  the troubleshooter a moment later, over your home Wi-Fi. No cloud storage, no downloading, no app
  to install. A phone that isn't paired yet pairs right there with the same QR code.
- Snapped photos at the printer before opening the troubleshooter? Paired phones also have a **📷** button on their
  Filament page. The photos wait on the PC: ones from the last 2 hours go into the next troubleshooter by themselves,
  older ones are one click away. Delete any photo on the phone or the PC (✕); they're kept for 14 days.
- **💾 Save fixed 3MF…** in the troubleshooter's results: saves a copy of the model with the ticked fixes built in, in one
  step, without leaving the troubleshooter. It uses the model the app knows for that print, or asks once for the project
  file (.3mf) you sliced in Orca. The new file is named after what it fixes ("Rocket (advisor - Fixed stringing - …).3mf"),
  next to the original, which stays as it was. Double-click it to open it in Snapmaker Orca and print.
- Fixed: turning on phone access's **secure address** for the first time (or after the PC's address changed) could fail
  with "BAD_DECRYPT", so the secure address didn't start.

## 2.32.3
- **Zoom**: make everything bigger (or smaller) for easier reading: **Settings → General → Text and screen size**, the
  **View** menu, **Ctrl +**, **Ctrl −**, **Ctrl 0**, or **Ctrl + mouse wheel**. It applies to every window (the main window,
  the Print Monitor, the Filament screen) and is remembered.
- **The printer bar's height can be changed**: drag its bottom edge. The printer cards, pictures and text grow and shrink
  with it, keeping their proportions (double-click the edge for the normal size). Remembered too.
- The main window keeps opening on the monitor you last used it on (since 2.32.2), like the Print Monitor.

## 2.32.2
- The Print Monitor window opens where you left it: the same monitor, place and size (and maximized if it was).
  The main window does too. If that monitor isn't connected any more, it opens on the main screen.

## 2.32.1
- Print Monitor hardening (found by the code scanner): pictures from a printer are only saved when they really are a
  PNG or JPEG of a sane size, never written over an existing file, and a printer's status messages can only fill in
  printer values.

## 2.32.0
- **Print Monitor**: watch every printer from the app. A bar on the main screen shows what each printer is doing
  (thumbnail, progress, time left, when it ends); **Print Monitor** opens a window with every printer side by side and
  a full page per printer: live camera, the print's preview pictures, progress and layers, **elapsed time, time left,
  estimated duration and end time**, toolhead temperatures with each filament's color, bed and enclosure, fans and
  speed, lifetime totals, pause / resume / cancel (each confirmed), **timelapse videos** and **final photos**.
- **Lifetime print time** from each printer's history: all printers together in the bar on the main screen (hover it
  for each printer), each printer's in its hover card, and a strip on the Print Monitor's All printers page.
- Hover over a printer in the bar for a bigger card: a larger picture of the print, time left, end time, elapsed,
  estimated duration, layer, filament used and the toolheads.
- Built in from U1 Studio and the Home Assistant dashboard's scripts, so nothing else has to run: the Snapmaker U1
  camera keep-alive, a photo at 99 % while the part is still on the bed, layer-by-layer preview pictures drawn from the
  G-code, and the print stages (preparing, printing, cooling, ready to remove). Time left is worked out like Home
  Assistant's and Mainsail's "Print ETA" (the slicer's plan scaled to the print's real pace).
- **Alerts** (Settings → Print monitor): Windows notifications, phone push with **ntfy**, and **email** like the Home
  Assistant automations (a camera photo and the printer's numbers at 1 / 25 / 50 / 75 %, and the final photo when it's
  done and the bed has cooled). Choose per alert which ones you get.
- Works with any Klipper / Moonraker printer, using the printers and API keys already in Settings; a Snapmaker U1 also
  gets its built-in camera, four toolheads with filament colors and timelapses. Other cameras: a snapshot or MJPEG address.
- Keeps watching from the **tray** when the window is closed (so alerts and the 99 % photo aren't missed), and can
  **start with Windows**. Paired phones get the Print Monitor too (**🖨 Printers** on the phone page).
- **Settings is now in tabs**: General, AI, Printers, Print monitor, Filament, Phone.
- The progress bar (starting up, slicing, reading…) now sits at the bottom of the window, so it never covers the menus.
- U1 Studio users: **Settings → Print monitor → Bring over settings and photos from U1 Studio**, then stop U1 Studio
  from starting with Windows so alerts don't come twice.

## 2.31.0
- **Filament prices.** Each filament's details now have a **Prices** section: the **average cost per roll** (total
  spent ÷ rolls), last and lowest price paid, and a **graph** of what you paid for each roll over time. **Check prices
  now** has Claude search the web (your API key, usually a few cents) for that exact product at Amazon, the brand's
  store and other filament shops, flags sales, and shows how much less (or more) than you last paid; found prices are
  kept, so the graph builds a history. **camelcamelcamel** and **Keepa** buttons open Amazon's price history for it.
- The Dashboard shows the **average per roll** for your whole library, filaments that are **cheaper now than you last
  paid**, and a button to check prices for everything running low.
- **Phones: easier secure scanning.** With the secure address on, pairing walks the phone through installing the
  app's certificate (it checks by itself when it's trusted), then pairs on the secure address. The certificate is also
  a QR code in **Settings → Phone access** and under **⚙** on the phone page. Links on labels and stickers move to
  the secure address on phones that trust it.
- **Android: tapping a sticker no longer pops up Android's “New tag scanned” screen** while the filament page is open
  on the secure address: the page keeps listening for stickers (allow it once).

## 2.30.0
- **Your filament library on your phone** (iPhone and Android), on your home Wi-Fi: turn on **Settings → Phone access**,
  click **Pair a phone** and scan the QR code. Look things up, update spools (open, empty, move, weigh, log grams),
  and add filament, including from a photo of an order (read by Claude with the API key on your PC). Changes show up
  on the PC and other phones at once. Add it to the Home Screen to use it like an app. Works while the app is open on
  the PC; only paired phones get in.
- **Scan spools with the phone**: printed labels now have a QR code that opens the spool (the phone's camera app is
  enough), stickers the app writes link to their spool (tap with the phone), and a scan on the PC's NFC reader opens
  the spool on the phone too. An optional **secure address** adds a Scan button inside the page (camera, and NFC on
  Android), after the phone trusts the app's own certificate once.
- Phones that can’t find the PC by name (some Android phones) use its address, and labels and stickers link to that
  address too; Settings says so (reserve the address in your router).
- **Linking a tag to a spool** narrows it down step by step (type → brand → color → filament → spool) instead of one
  long list; a step with one choice picks itself, and the spool is shown to confirm.
- NTAG203/213 stickers, too small for the filament's details, now get the spool link instead.
- The Filament screen saves safely when several screens edit at once (a save based on old data is refused and reloads).

## 2.29.0
- **Spool tags (NFC/RFID).** Turn it on in **Settings → Spool tags** and tap a spool on an NFC reader: a spool
  you've scanned before opens, highlighted; a new one can be added with its brand, material, color, weight and
  temperatures filled in from the tag, or linked to a spool already in your library. Reads Bambu Lab, Snapmaker
  (signature checked), Creality, QIDI, Anycubic and ELEGOO tags and the OpenSpool, OpenTag3D, SpoolEase and TigerTag
  formats. Contributed by BSDGuyShawn (PR #10), with the tag decoders from OpenRFID.
- **Write your own filament to NFC stickers.** On a filament's card, **🏷 Write NFC tag** (or 🏷 on a spool) writes
  it to a blank NTAG215/216 sticker as OpenSpool (or OpenTag3D, with the color name), reads it back to check, and
  links the sticker to that spool. Stickers that are too small (NTAG203/213) can be linked by their ID instead. Only
  blank-style stickers are written: brand tags, locked stickers and the sticker's system pages are never touched,
  and a sticker that already has data asks first.
- **Readers**: USB NFC readers (ACR122U, ACR1252U, Cryptnox, HID Omnikey, Identiv… any PC/SC reader), an
  **Arduino with a PN532 shield** (sketch in `tools/arduino/SpoolTagBridge`), or a **PN532 board** on a USB-serial
  adapter. Pick and test them in Settings; only Arduino boards are ever tried automatically.
- All built in: the tag reading, decoding and writing run inside the app (no Python, no extra program), in a
  background process so the window never waits on the reader. `npm test` runs the tests (`test/`), including every
  tag format against real tag dumps.

## 2.28.1
- **Color remix schemes show the full filament for each color**: color, brand and line, material, finish, spools on
  hand and how much is left, in both Swap colors and recoloring by parts. Swap colors also shows it under each color
  you pick, and each scheme lists what every toolhead changes from and to.
- **Apply to model** on every Swap colors scheme and at the bottom of the list, so there's no scrolling back up.

## 2.28.0
- **Color remix: Swap colors**, a simpler way to recolor that opens first. The model keeps its painting exactly as
  it is; each of its colors gets another filament from your library. Pick them by hand, click **Closest match** (the
  filament you own that looks most like each color) or **Shuffle** (a random scheme that keeps light colors light
  and dark ones dark, so eyes and details still stand out), or let the AI suggest schemes in the styles you pick
  (a few cents). The 3D view shows each change, color mixes follow the new colors, and **Apply to model** sets the
  toolheads to those filaments with their Snapmaker Orca presets. **Undo remix** undoes it. Recoloring by parts is
  still there (Parts and Colors at the top of the window).

## 2.27.0
- **The guided tour is optional.** The app no longer starts in the tour. New users who say they're new to 3D printing
  are offered it once; everyone else never sees the offer. Anyone can take it from Settings, and **Exit the tour**
  (bottom right) leaves it anytime. Finishing it no longer requires setting up the AI first.
- **A short setup window** on first launch for whatever isn't set up yet: the AI (your own API key or the free
  chatbot) and Snapmaker Orca. "Later" is fine: Settings has both.
- **Sample filament library**: the first time you open Filament (with an empty library), choose to explore the
  sample library or start empty. Settings has a new **Filament library** section to remove the samples when you're
  done (anything you added yourself stays, and a backup is kept), or to load them later. Before, the library was
  only in the tour and came up empty afterwards.
- The cheat-sheet booklet offer waits until no other window is open.
- Security (code scanning): the updater starts its hand-over script by a fixed name instead of a full path, and the
  cheat-sheet tool strips HTML tags completely.

## 2.26.1
- **Every filament in the file is kept**: a project with more solid filaments than the printer has toolheads (for
  example 5 colors plus 2 color mixes on the 4-toolhead U1) now shows all of them. Before, the 5th and later were
  dropped from the list. A note under the toolheads says when there are more filaments than toolheads; that's
  fine for files shared for Bambu printers with an AMS, which load 16 or more colors. You can also add filaments
  past the toolhead count.

## 2.26.0
- **Share on MakerWorld, easier to find**: "For MakerWorld (Bambu)…" buttons next to Save as 3MF (for the
  recommendations and for any version in Compare slices), and a "Share on MakerWorld" link under Open in Snapmaker
  Orca. They save a Bambu Studio project made by Bambu Studio itself (needs Bambu Studio, free from bambulab.com).
  The printer you pick is remembered.
- **Color mixes come along**: Snapmaker Orca color mixes become filaments of their own in the blended color, so the
  model looks the same in Bambu Studio and on MakerWorld. (Before, those areas pointed at filaments the Bambu file
  didn't have.)
- **The purge tower fits**: it now goes where it has room to grow, and if the model leaves no room, the model slides
  forward or back to make space. Before, a busy multi-color model could grow the tower off the bed and Bambu Studio
  refused to slice it.
- Fixed Bambu Studio crashing while saving a file with more than the usual number of filaments.

## 2.25.0
- **Find models**: a new button at the top (and a "Find free models" link where you open a file) lists where to
  download models to print. **Snapmaker Space**, Snapmaker's own site with ready-to-print U1 files, comes first.
  Free: MakerWorld, Printables, Thingiverse, Thangs and Yeggi. Paid: Cults, MyMiniFactory, CGTrader, Gambody,
  Patreon creators and Etsy. Tips cover 3MF vs STL files, licenses, and checking other people's prints.
  The guided tour shows it too.

## 2.24.0
- **Everyone takes the guided tour once**, including people who set the app up before the tour existed. It runs on
  the sample rocket with recorded results, so the first experience is quick and the same for everyone (no waiting
  on a big model of your own). It covers every feature: recommendations, Compare slices, Color remix, the filament
  library, print history and the troubleshooter, before your filament library is emptied for real use.
- **The tour now sets up the real app**: creating an Anthropic account and adding credit, creating an API key just
  for this app (so the Console shows exactly what it costs, and you can switch it off on its own), or choosing the
  free chatbot instead, and finding Snapmaker Orca (with a download link and Browse if it isn't installed).
  **Finish the tour** unlocks once the AI is set up; then the app restarts in normal mode where everything is real.
- After the tour, the app offers the **printable booklet** once: open it to print, save a copy, or get the 1-page
  quick sheet.
- **Saved 3MF files say when they were made**: "Rocket (advisor - 2026-11-19 3.42 PM).3mf", and
  "(advisor - Fast - …)" for a version from Compare. Converting many files and the Bambu export do the same.

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
