# FAQ

## Is it free?

Yes, the app is free and open source. The only possible cost is the AI: with an Anthropic API key you pay Anthropic directly, usually a few cents per request. Or use **Free chatbot** mode and pay nothing.

## Which printers does it work with?

It's made for the **Snapmaker U1** (four toolheads, four colors) and uses **Snapmaker Orca** to slice. It can send prints to U1s on your network and read their print history.

For **Bambu Lab** printers it can **export a Bambu Studio project** of your tuned model (for printing or sharing on MakerWorld). Full support for other printers isn't there yet.

## Do I need to know about 3D printing?

No. Pick **"Brand new"** when the app starts: it turns on a step-by-step guide and tips. The [glossary](USER-GUIDE.md#glossary) explains every term. The first time you open the app, a **guided tour** walks you through everything with a sample rocket.

## What's the guided tour?

The first time you open the app, it runs a one-time **guided tour** with a sample rocket. Everything in it was recorded from the real app, so it needs no key, no slicer and no printer, and it can't save, print or change anything. Click **Finish the tour** at the end and the app restarts, ready for your own models (your filament library starts empty). It doesn't run again; to see it again, open **Settings → Take the guided tour again**. (There used to be a separate demo download; the tour replaces it.)

## I followed the recommendations and the print still failed. Why?

Settings are only part of a good print. These are outside the app's control:

- **Damp filament.** Most filament soaks up moisture from the air (PETG, TPU and nylon most). Wet filament strings, pops, looks rough and prints weak. Dry it (a filament dryer, or your printer's drying function), and store it sealed with desiccant.
- **The room.** Cold rooms, drafts (fans, windows, air vents) and temperature swings cause warping, cracks and prints coming loose. ABS and ASA need an enclosure.
- **The filament itself.** Brands and even colors of the same material print differently. Check the temperatures on the spool's label.
- **The printer.** A dirty or uneven bed, a worn or partly clogged nozzle, loose belts or skipped calibration cause failures no setting fixes. Clean the bed (dish soap and water, or isopropyl alcohol) and run the printer's calibration now and then.
- **The model.** Very thin walls, a tiny footprint on the bed or a broken mesh can fail whatever the settings.

**AI can make mistakes**, especially with little to go on. Tell it what the part is for, describe problems in the troubleshooter and add photos. The app's safety checks catch settings that wouldn't work, but read each change before printing, and do a small test print when it matters.

Run the **troubleshooter** on the failed print (Print history → Troubleshoot…): the more you tell it, the better it gets.

## Is there something I can print and keep next to my printer?

Yes: a [1-page cheat sheet](cheat-sheets/AI-3D-Print-Advisor-Cheat-Sheet-1-page.pdf) and a [booklet with every word and picture](cheat-sheets/AI-3D-Print-Advisor-Booklet.pdf) (PDF, US Letter). In the app: the **Glossary** window or **Settings**. They're also in the **Printable cheat sheets** folder next to the program.

## How do I update?

From 2.23.0 the app updates itself. It checks GitHub when it starts and once a day while it's open; when there's a new version it shows what's new since yours, and **Install and restart** installs it into the same folder (no new download warnings). Only releases that passed the virus scan are installed, and the download is checked against the published checksum. Your settings, API key, filament library and print history are stored separately and kept. **Settings → Check for updates** checks any time; you can turn the automatic check off there. On 2.22.0 or older, download the new zip once by hand.

## My Snapmaker Orca color mixes don't show

They do from 2.23.0: mixed colors ("Full Spectrum" mixed filaments) are listed under the toolheads with their recipe, and the 3D view shows the blended color. They're printed with the real filaments in their recipe, so only those need loading.

## Windows says "Windows protected your PC"

That's Windows SmartScreen. It warns about any program that isn't signed with a paid certificate, which most free hobby apps aren't. Click **More info**, then **Run anyway**.

**To avoid the warning:** do this *before* you extract a new download. Right-click the zip → **Properties** → at the bottom of the **General** tab, tick **Unblock** → **OK**. Then right-click → **Extract All…** as usual. Windows marks every file downloaded from the internet; Unblock removes that mark, so the extracted program starts without the warning. (No Unblock box means the zip isn't marked, and you won't see the warning anyway.) Already extracted? Delete that folder, unblock the zip, and extract again.

The warning comes back for each new version because each version is a new file Windows hasn't seen before. If you want to be sure the file is genuine, compare its checksum with the release page (see [Is it safe?](../README.md#is-it-safe)) or upload it to [VirusTotal](https://www.virustotal.com/).

## My antivirus flagged it

Some antivirus programs are cautious about new, unsigned apps. Each release is scanned with ClamAV and its checksums are published. If your antivirus names a specific threat, please [open an issue](https://github.com/jtroberts83/AI-Print-Advisor-Studio/issues) with the details so it can be checked and reported as a false positive.

## How do I get an API key? Do I need a Claude subscription?

You don't need a Claude.ai subscription. Sign up at [platform.claude.com](https://platform.claude.com/), add a little credit under Billing, and create a key under API keys. Step by step: [Getting an API key](USER-GUIDE.md#getting-an-anthropic-api-key).

## How much will the AI cost me?

Typical costs per request: recommendations 5–20¢, Color remix parts 6–11¢, a set of color schemes about 10¢ (Swap colors schemes 2–5¢; Closest match and Shuffle are free), a troubleshooting run about 10¢, reading an order screenshot a few cents. The app shows an estimate before each request and the real cost after (the **AI** button at the top). Pick **Claude Haiku** in Settings for the cheapest option.

## Can I see my total Anthropic spend in the app?

The app shows what **it** has spent (Settings → AI spending). For what your API key has cost in total, including use outside this app, open your [API keys page](https://platform.claude.com/settings/keys) in the Claude Console.

## What gets sent to the AI?

Only when you click an AI button: the model's measurements and a few pictures of it, the slicer settings, a summary of the slice, your recent print history (if printers are set up) and what you typed. For Color remix, your filament list. For screenshots, the screenshot. Nothing is sent otherwise.

## Where are my settings and filament stored?

In `%APPDATA%\AI 3D Print Advisor Studio` on your computer (paste that into File Explorer's address bar). The filament library keeps a daily backup there for two weeks. You can also **Download backup** in Filament → Settings.

## MakerWorld models show errors when I open them in Snapmaker Orca

MakerWorld files are usually saved for Bambu Lab printers. Open them in this app first: it converts them for the Snapmaker U1, keeps the designer's important settings, and saves a file that opens cleanly in Snapmaker Orca.

## I only have an STL file

Open it in Snapmaker Orca, save it as a project (`.3mf`), then open that in this app.

## The app can't find Snapmaker Orca

Open Settings and click **Browse** next to "Snapmaker Orca program". It's usually `C:\Program Files\Snapmaker_Orca\snapmaker-orca.exe`.

## My printer isn't found on the network

Make sure the printer is on and on the same Wi-Fi/network as your computer. In Settings, type its address by hand: the same address you'd use to open Fluidd or Mainsail in a browser (for example `192.168.1.50`; add `:7125` if that doesn't work).

## How do I update?

Download the new zip from the [releases page](https://github.com/jtroberts83/AI-Print-Advisor-Studio/releases) and extract it. Your settings and filament are stored separately and stay.

## How do I uninstall?

Delete the app's folder. To remove your settings and filament too, also delete `%APPDATA%\AI 3D Print Advisor Studio`.

## Something went wrong. How do I report it?

[Open an issue](https://github.com/jtroberts83/AI-Print-Advisor-Studio/issues) and describe what you did and what happened. The app's log helps: **Help → Open log folder** in the menu, and attach `app.log`. (Check it doesn't contain anything you'd rather not share.)
