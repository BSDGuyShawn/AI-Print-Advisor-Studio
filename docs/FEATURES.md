# Features

Everything AI 3D Print Advisor Studio can do, in one list. New to 3D printing? Start with the [user guide](USER-GUIDE.md); words like "overhang" are explained in its [glossary](USER-GUIDE.md#glossary).

## Check a model before printing

- **3D preview**: turn and zoom the model, see it in its filament colors.
- **Overhang view**: red where the model would print over thin air, orange where it's borderline.
- **Measurements**: size in mm and inches, volume, overhang area, how much touches the bed, how stable it is, number of colors, flat tops.
- **Orientation finder**: scores every way to place the model and marks the **lowest risk** one. Click to try each.
- **Safety checks**: catches settings that wouldn't work (temperatures, cooling, supports, flow) and fixes many automatically.
- **Heavy-model fix**: very detailed models that would slice slowly can be simplified with one click (undoable).
- **"These parts fit together"**: keeps sizes exactly as designed for snap-fit and multi-part models.

## AI recommendations

- **Get recommended settings**: Claude looks at the model, a real slice, your printer, your past prints and what the part is for, then lists what to change, with a plain-English reason for each.
- **Quality ↔ Speed slider** with ready-made "recipes" from fine to fastest.
- Untick any change; **copy a checklist**; **save as Orca presets** to reuse on other models.
- **Free chatbot mode**: no API key needed; copy and paste with ChatGPT, Claude or Gemini.
- **Choice of Claude model**: Sonnet (balanced), Opus (best), Haiku (cheapest), or any model ID.

## Compare versions

- Real slices of **Original, Recommended, Finest, Fine, Fast, Fastest**, side by side.
- For each: **how it looks**, **how strong**, **print time**, **filament**, layers, tool changes, peak flow.
- Warnings when a version takes much longer, with what causes it.

## Save and print

- **Save as 3MF** with the settings built in (opens straight in Snapmaker Orca).
- **Send to printer**: pick a Snapmaker U1 on your network, see what's loaded in each toolhead, map filaments, upload and start.
- **Open in slicer**: opens it in Snapmaker Orca; edits you save there come back to the app.
- **Save G-code** for a USB stick or Fluidd/Mainsail upload.
- **Export for Bambu Lab**: a Bambu Studio project of your tuned model, ready for MakerWorld.
- **Batch convert**: convert a whole folder of models for your printer.
- **Print names** that voice assistants read out nicely ("White Rocket").

## Color remix

- The AI finds a model's parts (body, eyes, fins…); you check and correct them by clicking or brushing.
- New **color schemes** in styles like Realistic, Fun, Galaxy, Color Shift, Pastel, Monochrome and Holiday, using **only filament you own**.
- Optional **extra colors** with a pause to swap spools mid-print.
- **Apply** paints the colors in and sets the toolheads; **Undo** puts it back.

## Filament library

- Every filament and spool you own, with **product photos**, color swatches, brand, material, finish and price.
- **Spool tracking**: sealed, opened, drying, loaded, empty; grams left; where it's stored; history.
- **Weigh-ins**: enter the scale reading, the app subtracts the empty spool.
- **Add from a screenshot** of any order page, receipt or product page (read by Claude), with photos cut out automatically and **missing photos found online** from the brand's store.
- **Manufacturer print settings** and Snapmaker Orca presets for many brands.
- **Dashboard**: totals, value, what's running low, what's loaded in each printer.
- **Labels** for spools (Avery sheet or label printer), **CSV export**, **backups** (daily automatic copies too).
- **What to buy**: when a model needs colors you don't own, the closest ones you have and shop links.

## Print history and troubleshooting

- **Print history** from your printers; rate each print so future advice learns from it.
- **Troubleshooter**: paint where a print failed, pick the symptoms, add photos; the AI reads the printed G-code at that spot and gives likely causes and fixes.

## Costs, privacy and help

- **AI spending**: the cost of every AI request, this month's total in the top bar, details by feature in Settings. Optional Anthropic Admin key to see your whole account.
- **Everything stays on your computer**; your API key is encrypted.
- **Step-by-step guide**, "?" tips, and an experience setting (from "brand new" to "expert").
- **Sessions**: your work is saved as you go and comes back after a restart; export a session to share.
