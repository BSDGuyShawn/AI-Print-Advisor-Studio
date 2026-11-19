# Changelog

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
