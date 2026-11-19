# Troubleshooting

Two kinds of trouble: **the app** isn't doing what you expect, or **a print** came out wrong. For a failed print, the app's own **troubleshooter** (Print history → Troubleshoot…) is the best place to start; this page covers the common cases.

---

## Problems with the app

### Windows says "Windows protected your PC"
Click **More info → Run anyway**. Next time, skip the warning: before extracting, right-click the zip → **Properties** → tick **Unblock** → **OK**. Windows shows this for programs that aren't signed with a paid certificate. See the [FAQ](FAQ.md#windows-says-windows-protected-your-pc).

### Nothing happens when I double-click the app
- Make sure you **extracted** the zip first (right-click → Extract All…). Running it from inside the zip doesn't work.
- Keep the **`app`** folder next to the program. If it says "Couldn't find the app's files", extract the whole zip again and don't move the program out of its folder (make a desktop shortcut instead: right-click → **Send to → Desktop (create shortcut)**).
- Wait a few seconds: the first start builds an index of your Snapmaker Orca profiles.
- Still nothing? Check **Task Manager** for "AI 3D Print Advisor Studio" and end it, then start again.

### "Snapmaker Orca wasn't found" / slicing is off
Install [Snapmaker Orca](https://www.snapmaker.com/), or open **Settings** and click **Browse** next to "Snapmaker Orca program". It's usually `C:\Program Files\Snapmaker_Orca\snapmaker-orca.exe`.

### The AI buttons ask for a key / say the key was rejected
- Open **Settings** and paste your Anthropic API key (it starts with `sk-ant-`). [How to get one](USER-GUIDE.md#getting-an-anthropic-api-key).
- "Your Anthropic account needs credits": add a little credit under **Billing** at platform.claude.com.
- Prefer not to use a key? Choose **Free chatbot** in Settings.

### "Anthropic is busy" / "limiting requests"
Wait a minute and try again. New accounts have low limits at first; they go up as you use the API.

### My printer doesn't appear / "Not reachable"
- The printer must be **on** and on the **same network** as your computer.
- In Settings, use **Find printers on my network**, or type the address you'd open Fluidd/Mainsail with (like `192.168.1.50`; try adding `:7125`).
- If the printer uses an API key (Moonraker), add it in the printer's row.

### Slicing takes forever
Very detailed models (millions of triangles) slice slowly. When the app offers **Fix model**, accept it: it simplifies the model with no visible difference, and you can undo it.

### The file opens with warnings
Warnings about missing presets or a different printer are normal for files made for other printers (like MakerWorld's Bambu Lab files). The app converts them for the U1 and lists what it changed.

### Something else
Open **Help → Open Log Folder**, then [open an issue](https://github.com/jtroberts83/AI-Print-Advisor-Studio/issues/new/choose) describing what you did and what happened, and attach `app.log` if you can.

---

## Problems with a print

Run the **troubleshooter** first: Print history → **Troubleshoot…** on the print → paint where it failed → pick the symptoms. It reads what the printer actually did at that spot. The table below is a quick reference.

| What you see | Most likely cause | What to try |
|---|---|---|
| **Spaghetti** (a tangle of loose plastic) | The model came loose, or a part was printed over thin air | A better **orientation**, **supports** on, a **brim** for small bases |
| Corners **lifting** (warping) | The bottom cooled and shrank | Clean the bed (dish soap and water), use a **brim**, keep the room draft-free |
| **First layer** patchy or not sticking | Bed dirty or not level, first layer too fast | Clean the bed, run bed leveling, slow the first layer |
| **Stringing** (hairs between parts) | Wet filament, nozzle too hot | **Dry** the filament, lower the temperature a little |
| Overhangs **drooping** | Too steep without supports, not enough cooling | Turn the model, add **supports**, more fan |
| **Layer shift** (layers suddenly offset) | Print head bumped or too fast | Check for collisions, slow down, tighten belts |
| **Cracks between layers** | Too cold, too much cooling (more with PETG/ABS) | Raise the temperature, less fan, enclosure for ABS/ASA |
| **Gaps** / thin walls (under-extrusion) | Partial clog, wet or tangled filament, printing too fast | Check the spool turns freely, dry it, slow down |
| **Blobs** and rough walls | Too much plastic, wet filament | Check the filament preset, dry the filament |
| Bottom edge bulges out (**elephant foot**) | First layers squashed | Slightly higher first layer, lower bed temperature |
| **Wrong colors** or smears between colors | Not enough purge when switching | Keep the **prime tower** on, check which spool is in which toolhead |
| Parts **don't fit together** | Sizes changed by settings | Tick **These parts fit together** before getting recommendations |

Rate every print (**Good / Had issues / Failed**) in Print history: the app's future recommendations learn from what worked for you.
