# CoeliSafe & Jarvis Low-Token Coding Rules (Argon Usage Optimizer)

## 1. Never Read Full Large Files (`index.html` is 11,343 Lines / 405 KB)
To prevent hitting usage/token limits during large tasks on **CoeliSafe** (`C:\Users\kovia\Desktop\VerifiedGF-App\index.html`), **ALWAYS pass `StartLine` and `EndLine` (at most 120–160 lines per call)** when calling `read_file` on `index.html`.

## 2. Exact Line-Number Map of `C:\Users\kovia\Desktop\VerifiedGF-App\index.html`
- **Lines `1–75`**: `<head>`, SEO meta tags, Google Analytics (`G-LV9696J77C`), Leaflet CSS/JS imports.
- **Lines `76–3814`**: `<style>` CSS stylesheet (variables at `76–130`, header/nav at `190–350`, hero/search at `355–520`, cards/badges at `525–950`, map view at `955–1250`, modals at `1255–2200`, dietary filters & dark mode at `3100–3814`).
- **Lines `3815–3857`**: `<header class="app-header">` (logo, desktop tabs, language button, owner modal link, profile icon).
- **Lines `3858–3978`**: Tab 1 — Discover View (`#view-discover-page`: hero banner, search bar, dietary filter toggles, category filter chips, `#restaurant-cards-list`).
- **Lines `3979–4042`**: Tab 2 — Interactive Map View (`#view-map-page`, `#leaflet-map-container`, `#map-sheet-drawer`, `#map-quick-cards-row`).
- **Lines `4045–4080`**: Tab 3 — Saved Restaurants View (`#view-saved-page`).
- **Lines `4081–4300`**: Tab 4 — Profile, Digital Chef Medical Card (`#chef-notice-body`), Language selector, Theme toggle.
- **Lines `4301–4345`**: Mobile Bottom Navigation Bar (`<nav class="bottom-nav">`).
- **Lines `4346–5005`**: Modals (Restaurant Detail Modal `#detail-modal`, Video Audit Modal, Booking Modal, Owner Application Modal, Legal Modal, Founder Admin Studio `#founder-admin-modal` at `4900–5005`).
- **Lines `5006–5110`**: Start of `<script>` and `const RESTAURANTS = [` (Verified showcase venue `id: 0` "Tisza Bistro Szeged" is at `5013–5107`; always insert new verified restaurants right at line `5013` with `"verified": true`).
- **Lines `5108–8401`**: Remaining waitlist entries (`id: 1` to `id: 51`) — **DO NOT read lines `5150–8395`** unless specifically asked about a UK waitlist item.
- **Lines `8402–8770`**: `isVenueVerified(r)`, dietary filter helpers (`getVenueDiets`, `toggleDietFilter`, `setChefCardMode`), `getFilteredRestaurants()`, and `renderCardsList()`.
- **Lines `8772–8852`**: Search bar & category chip handlers (`executeSearch`, `applyFilterCategory`).
- **Lines `8853–9210`**: Leaflet map (`initMapPins`, `updateMapPins`, `renderMapQuickCards`, `onMapPinClicked`, GPS location `locateUserOnMap`).
- **Lines `9211–10600`**: Modals, Saved restaurants, Dark/Light theme, and `BUILTIN_HU_DICTIONARY` Hungarian translations.
- **Lines `10601–10913`**: Neural & dictionary language translation engine (`applyAppTranslation`, `initLanguageSystem`).
- **Lines `10914–11343`**: Founder Admin Studio (`publishAdminVenueLive`), Google Sheet CSV sync (`COELISAFE_EMBEDDED_CSV`, `applyCsvTextToRestaurants`), and startup init calls (`11332–11340`).

## 3. Fast Publishing to Live Site (`https://verifiedgf-app.pages.dev`)
When editing CoeliSafe on the user's PC, push `index.html` to `adosz1/VerifiedGF-App` on GitHub (which automatically deploys to Cloudflare Pages `https://verifiedgf-app.pages.dev`).
