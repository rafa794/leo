# AGENTS.md — guide for AI coding agents (GitHub Copilot, Claude, Codex…)

Read this whole file before changing anything. It is the shared memory of the project: what Orion is,
how it is built, the rules the maintainer cares about and the traps that already cost time.

> **Talk to the maintainer in Spanish** (he writes in Spanish). Code, comments, commit messages and docs are in English,
> except the user-facing UI text, which is written in Spanish first (see *Translations*).

---

## 1. What Orion is

A **free, open-source video editor** (GPL-3.0) with the editing model people know from CapCut — magnetic main
track, overlay tracks, keyframes, quick tools — for **Mac, Windows, Linux, Android and the browser**.

The promise to users, which every change must keep:

- **Free for real**: every feature, no watermark, no "Pro" tier, no account, no ads.
- **Private / local**: editing, export and AI run on the user's device. Nothing is uploaded, no telemetry.
- **Runs on modest machines**: no feature may *require* a dedicated GPU or a powerful computer.
  A smooth-slow-motion feature (RIFE via WebGPU) was built and **removed** for this reason. CPU-only or WebGL-light
  approaches are fine; anything heavy must degrade gracefully.
- **Free tools and services only**: open-source libraries, free models downloaded once, free hosting
  (GitHub Releases, Cloudflare Pages). Never add paid APIs, paid SDKs or trackers.

The maintainer is a solo creator (he also runs sports channels, but the product is pitched as a **general**
editor: don't add sports-specific marketing unless asked). Donations: "Invítame a un café" (PayPal.me, Bizum)
in `src/config/author.ts`.

Website: https://orion.rafael-mendoza.com (Cloudflare Pages, `/` = landing page, `/app/` = web version).
Repo: https://github.com/rafa794/orion. Releases: GitHub Releases.

---

## 2. Stack

- **React 19 + TypeScript + Vite 8**, state in **zustand** (`src/store`).
- **mediabunny** (WebCodecs) to decode / encode MP4 (H.264 + AAC), stream exports to OPFS (no 2 GB Blob limit).
- **WebGL2** color pass (`src/lib/gl.ts`): adjustments, LUTs (`.cube`), chroma key, shape masks.
- **OpenCV.js** (stabilizer, in a worker), **transformers.js / Whisper** (subtitles), **MediaPipe** (background
  removal), **RNNoise** (voice isolation / removal). Models download once and are cached.
- **Electron** (desktop: `electron/main.cjs`, `electron/preload.cjs`, served from `app://orion`).
- **Capacitor 8** (Android: `android/`). iOS is not set up yet (needs a paid Apple account).
- Tests: **Vitest** (unit) + **Playwright driving Electron** (end-to-end).
- TypeScript 7 is native (no JS API); the i18n extractor uses the `typescript-js` alias (TS 5.9) instead.

---

## 3. Commands

```bash
npm install                # also copies MediaPipe wasm to public/ (postinstall)
npm run dev                # browser version, http://localhost:5173
npm run mac                # desktop app (Electron) from a fresh build
npm run mac:build          # release/mac-arm64/Orion.app  ← the maintainer uses this app daily
npm run dist:mac | dist:win | dist:linux | dist:all   # installers (unsigned)
npm run android:release    # signed APK → release/Orion-android.apk (key outside the repo, see §9)
npm run android:live       # live reload on a USB-connected phone ("Orion Dev" app, see §8)
npm run site:build         # website + web app → site-dist/ (Cloudflare Pages)
npm test                   # unit tests
npm run test:app           # end-to-end on the dev build (Electron, throwaway profile)
npm run test:mac-app       # same tests on the packaged Orion.app
npx tsc --noEmit -p .      # typecheck (must be clean)
node scripts/i18n-extract.mjs   # refresh src/i18n/strings.json after UI text changes
```

After any change the maintainer will use: **typecheck, `npm test`, `npm run test:app`, then rebuild the app he
uses** (`npm run mac:build`, and `npm run android:live` if a phone is connected).

---

## 4. Project map

```
src/
  App.tsx                 desktop layout; phones / narrow screens (≤ 820 px) render src/mobile instead
  main.tsx                entry: i18n init, App, LanguagePicker
  store/editor.ts         THE project state: tracks, clips, media, selection, time, undo/redo, all edit actions
  store/layout.ts         panel sizes/visibility, compact (phone) detection (useCompact)
  lib/render.ts           draws one frame (preview AND export share it): transforms, animations, crop, masks…
  lib/player.ts           real-time preview (one <video>/<audio> per leaf clip, Web Audio for voice FX)
  lib/scrub.ts            fast WebCodecs frames while dragging the playhead
  lib/exporter.ts         MP4 export; lib/exportQueue.ts background queue
  lib/keyframes.ts        keyframes for ANY numeric property (source-time based)
  lib/timeline.ts         leaves / envelopes (compound clips flattened), audio helpers
  lib/audioMix.ts         offline audio mix for export
  lib/project.ts          projects in IndexedDB, autosave, relinking big camera files
  lib/fileAccess.ts       remembered file handles (Chrome / desktop)
  lib/stabilize.ts        stabilizer path smoothing (ADMM, "tube" constraint so borders never show)
  lib/clipTools.ts        freeze frame, reverse
  lib/attributes.ts       copy / paste attributes
  lib/gl.ts               WebGL2 color / LUT / chroma / mask pass
  lib/library.ts, stickers.ts   free music / SFX (Openverse) and Fluent Emoji 3D stickers
  lib/platform.ts         save / share on Android vs desktop vs browser
  ai/                     workers: whisper, stabilize (OpenCV), voice (RNNoise); segmenter (MediaPipe)
  components/             desktop UI (Timeline, Preview, Inspector/MediaInspector, panels, dialogs)
  components/Range.tsx    the slider used everywhere (no native blue sliders)
  components/MaskOverlay.tsx   mask handles drawn over the viewer
  mobile/                 phone editor: MobileApp (layout, tools, sheets), MobileTimeline, MobileHome, mobile.css
  i18n/                   translations (index.ts = runtime, {en,fr,pt}.json, strings.json = keys)
  config/author.ts        author name/photo, donation links, suggestions email, Web3Forms key
electron/                 desktop main process + preload (menus follow the UI language)
android/                  Capacitor project (release signing reads ~/.orion-signing/keystore.properties)
functions/app/__download.js   Cloudflare Pages Function: proxy for free music downloads (allow-listed hosts)
website/                  landing page (static, 4 languages, OS-aware download button)
scripts/                  licenses.mjs (credits), i18n-extract.mjs, build-site.mjs, android-live.mjs
tests/unit, tests/app     Vitest and Playwright suites
```

---

## 5. Core concepts (read before touching the editor)

- **Tracks are ordered top → bottom; the top track is drawn in front.** `tracks[0]` is the front-most layer;
  `render.ts` draws from the last track to the first. Text tracks are created at the top, overlay video tracks just
  above the main track, audio tracks at the bottom (`createTrack` in `store/editor.ts`). **Both timelines (desktop
  and phone) must show rows in this same order** — overlays, stickers and texts above the main track.
- **Main track** (`MAIN_TRACK`) is magnetic: clips stay together without gaps (`normalize()`). Other tracks can have a
  magnet toggle. Hidden tracks don't render, don't sound and don't lengthen the export.
- **Times**: clip `start`/`duration` are timeline seconds; `trimStart` is source seconds; `speed` maps one to the
  other. **Keyframe times are in SOURCE time** (`srcTime` / `timelineTime`), so they stay on the same moment of
  the footage when a clip is trimmed, split or sped up. Splitting prunes keys outside each part.
- **Undo**: call `checkpoint()` once at the start of a gesture, then update with `commit = false`.
- **Linked edit**: with several clips selected, inspector changes apply only the changed property to all of them.
- **Compound clips**: nested timelines (`compound`), entered/exited with `enterCompound` / `exitCompound`.
- **Generated media** (reversed clips, frozen frames) are stored inside the project (`generated: true`).
- **Inspector props** (`Prop` in `MediaInspector.tsx`): `min`/`max` are in the value's own units (volume 0–2,
  mask −1…1); `scale` converts to what's shown (%). A past bug mixed these up and broke many sliders — there is an
  end-to-end test that every slider reaches its real maximum.
- `[hidden]` always wins (`display: none !important` in styles.css). Use the `hidden` attribute freely.

---

## 6. UX rules (the maintainer is precise about these)

General
- Professional, calm UI: dark theme, our own `Range` sliders, custom selects, thin scrollbars.
- Moving the playhead always pauses. Scrubbing shows the exact frame.
- **Magnets ("imán")** make things align exactly, not "by eye":
  - Trimming a clip edge sticks to the **playhead first**, then to the start/end of clips on **other** rows (texts,
    stickers, audio, overlays) and 0 s — **never** to the neighbour on the same row (its edge is where the clip
    already is, which felt like "snapping to a random point"). It stays stuck until dragged a bit further.
  - Phones vibrate very briefly when something snaps (`buzz()` in `Preview.tsx`; Android needs the VIBRATE
    permission, already in the manifest).
  - Viewer: corner resize and pinch stick at 100 % scale and 0° / 90°.
- **The selected clip's white frame = its grips, drawn OUTSIDE the clip** (phone timeline), like CapCut: no picture
  under them, the clip is only what's between them. The grip's **inner edge** is the clip's first / last pixel and is
  what sticks to the playhead; the grip sticks out on the other side. Touch areas are enlarged invisibly, outwards.
- Export defaults: the frame rate of the footage, and never upscale beyond the project resolution.

Phone editor (`src/mobile`, used for Android and any screen ≤ 820 px)
- Not a shrunken desktop: it follows the mobile editor pattern (CapCut-like *behaviour*, Orion's own look).
- Home screen → "Nuevo proyecto" opens the gallery and goes **straight to the timeline** with the clips added.
- Timeline: **playhead fixed in the middle**, the content scrolls under it (swipe = scrub, pinch = zoom),
  tap = select, `+` adds at the end, "+ Añadir audio / texto" lanes run **to the end of the timeline** (the end of
  whatever ends last).
- Bottom bar: general tools when nothing is selected; the selected clip's tools otherwise (each opens its panel as a
  bottom sheet via `MediaInspector only=… videoSub=…`). "Superposición" adds media **above** the main track.
- Controls row under the viewer: full screen, play, ◆ keyframe, undo / redo. Coffee button in the top bar.
- Viewer: drag to move, finger-sized corners, two-finger pinch to scale and twist to rotate.

Coffee / donations
- `AUTHOR.paypalMe` and `AUTHOR.bizumPhone` in `src/config/author.ts`. The dance video
  (`public/support/dance.webm`) plays **only after** someone picks a coffee (full-screen thanks + confetti).
  Don't show it before (the maintainer doesn't want it to feel like spam).

---

## 7. Translations (mandatory for any UI text)

- The UI is written in **Spanish** and Spanish text is the translation key. `src/i18n/index.ts` swaps texts and
  tooltips on screen at runtime (MutationObserver) for `en`, `fr`, `pt` (pt-BR). In Spanish nothing runs.
- After adding or changing UI text: `node scripts/i18n-extract.mjs`, then add the new keys to
  `src/i18n/en.json`, `fr.json`, `pt.json` (keep placeholders `{0}` identical).
- Prefer **whole sentences** as one template string (`` `Tus vídeos son de ${a} fps…` ``) over JSX split around
  `{values}`, so they translate as a unit.
- Put `translate="no"` on user content (clip names, typed text, project names).
- The Electron menus are translated in `electron/main.cjs` (`MENU`), updated through the preload bridge.
- The website has its own small dictionary inside `website/index.html`.

---

## 8. Testing and verifying

- Always: `npx tsc --noEmit -p .`, `npm test`, `npm run test:app` (Playwright + Electron, **throwaway profile**:
  never touch the maintainer's real app data or projects).
- The app suite covers: language picker, import, timeline add/split/undo, every slider's range, mask editing on the
  viewer, background export of a real MP4, projects, dialogs, voice-isolation progress, language switching, and
  the **phone flow** (home → new project → timeline → swipe → magnet trim → split → sheets).
- Phone checks: the Android emulator AVD `Medium_Phone_API_35` (no real GPU: imports and redraws are slow there,
  that's not a bug). The maintainer's own phone runs **Orion Dev** (`npm run android:live`): a separate app id
  (`app.orion.editor.dev`) that loads the dev server through `adb reverse`, so code changes appear live.
  Don't take screenshots of the maintainer's real phone; use the emulator for visual checks.
- Big camera files are not stored inside projects; after a reload they are relinked by folder.

---

## 9. Releases and publishing

- Version in `package.json` (+ `versionName`/`versionCode` in `android/app/build.gradle`).
- Installers: `npm run dist:all` + `npm run android:release`, then a GitHub Release on `rafa794/orion`.
  Asset names have **no version** (`Orion-mac-arm64.dmg`, `Orion-Setup-x64.exe`, `Orion-Portable.exe`,
  `Orion-linux-x86_64.AppImage`, `Orion-linux-amd64.deb`, `Orion-android.apk`…) so the website's
  `releases/latest/download/<name>` links keep working.
- Apps are unsigned (no paid certificates): the website and README explain the macOS / SmartScreen first-run steps.
- **Android signing key lives outside the repo** (`~/.orion-signing/`). Never commit keys, passwords,
  `keystore.properties`, `.jks`, tokens or `.env` files. Losing the key means existing users can't update.
- Website + web app: `npm run site:build` → Cloudflare Pages (build command `npm run site:build`, output
  `site-dist`, env `NODE_VERSION=22`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`). Files must be ≤ 25 MiB
  (`build-site.mjs` drops the one ONNX wasm that transformers.js loads from its CDN anyway).
- Licenses: `scripts/licenses.mjs` builds `public/licenses.json` (shown in the app). Add any new model/asset to its
  credits list with its license.

---

## 10. Repository hygiene (important)

- Commits go out as the maintainer's personal GitHub identity (configured locally for this repo). Never change
  git/gh accounts globally.
- **Never add references to the maintainer's employer, work accounts or work email** anywhere (code, docs,
  commits, metadata). His own name, photo and donation links are fine.
- Keep IDE folders (`.idea/`, `.vscode/`), simulator state (`.wrangler/`), build output (`dist/`, `release/`,
  `site-dist/`) and test output out of git (already in `.gitignore`).
- Before committing, scan the staged files for secrets and private data.
- End commit messages with a `Co-Authored-By:` line for the AI that helped, if your tool adds one.

---

## 11. Known traps

- **WebCodecs on emulators / some phones can hang**: imports and exports use timeouts with `<video>` fallbacks
  (`withTimeout`). Don't remove them.
- Grid layouts with a wide scrollable child need `grid-template-columns: minmax(0, 1fr)` / `min-width: 0`, or the
  whole page widens (happened in the phone editor).
- In Playwright, `page.setViewportSize` overrides the Electron window size (use it to test the phone layout).
- OpenCV.js module is thenable: wrap it (`{ cv }`) before resolving a promise with it.
- Reverse audio must be resampled to 48 kHz stereo before AAC encoding.
- Newer Android WebViews draw under the status bar: keep `env(safe-area-inset-*)` paddings.
- Electron: links open in the system browser; downloads in tests are redirected with `will-download`.

---

## 12. Roadmap / ideas (ask before starting big ones)

Things CapCut keeps behind "Pro" that Orion should offer free (CPU-friendly versions):
- Object / person removal with AI ("borrar con IA"), face retouch, quality enhance / upscale.
- Voice changer effects, text-to-speech, noise reduction presets.
- Animated word-by-word caption templates (TikTok style).
- Auto reframe 16:9 → 9:16 following the action; motion tracking (text / sticker following a subject).
- Transitions between clips; premium-like effects, filters, fonts and templates (free assets only).
- Long video → short highlights (e.g. detect loud moments in the audio); AI color correction, curves, HSL.
- Phone editor: long-press to reorder clips, transitions button between clips, dedicated volume panel.
- Promotion helpers: tutorial pages on the website (SEO), Google Search Console, Cloudflare Web Analytics.

Rejected: anything that needs a GPU to be usable (e.g. RIFE smooth slow motion), paid services, accounts, tracking.
