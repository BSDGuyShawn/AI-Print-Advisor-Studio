# Changelog

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
- **Get recommended settings** slices only the original model (the AI needs it). It no longer also slices the
  recommended version for Compare slices; do that in Compare slices when you want it. Sending a print still
  slices on demand.

## 2.16.1
- Source as received (baseline).
