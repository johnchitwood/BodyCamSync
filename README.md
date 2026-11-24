# BodyCamSync

Play body-camera and in-car video from one incident together, lined up by their audio.
Click a camera to switch the view and the sound; grid and single-view layouts; frame stepping.

## Run

    open dist/mac-arm64/BodyCamSync.app       # packaged app
    npm start                                  # from source (needs npm install)
    npm run pack                               # rebuild the .app into dist/

## How it works

- **Original files are never written to.** They are opened read-only. Everything the app makes
  (audio copies, local video copies, sync results, fingerprints) lives in
  `~/Library/Application Support/BodyCamSync/projects/<id>/`.
- **Sync**: each camera's audio is cross-correlated against the others (GCC-PHAT, `src/main/dsp.js`),
  checked at ~36 points across the recording; offsets are solved as a graph, with a cross-check
  between independent matches. Manual nudges (1 ms / 10 ms / 1 frame) are saved per camera.
- **Playback** (`src/renderer/engine.js`): one master clock; every camera's audio runs continuously
  and only the active one is audible, so switching is a short crossfade, never a seek.
- **Local copies**: 720p, 15-frame-GOP copies are built in the background (max 2 at once) and swapped in
  while playing. Seeks drop from ~200 ms (worst >1 s) on a network drive to ~10 ms.
- **Fingerprints**: Files tab -> SHA-256 of every original, stored with size and modified time.

## Transcript, speakers, and editing

- Transcripts: local whisper.cpp (`resources/mac/whisper-cli` on Mac, `resources/win/whisper-cli-gpu.exe` / `whisper-cli.exe` on Windows) with `ggml-large-v3-turbo-q5_0` + silero VAD. Runs on the graphics card (Metal on Mac, Vulkan on Windows) and falls back to the processor if the card can't be used. The progress line shows which one is in use.
- Overrides (environment variables): `BCS_NO_GPU=1` transcribes on the processor only; `BCS_NO_HWACCEL=1` decodes video in software when making local copies.
- Speakers: sherpa-onnx (pyannote segmentation + wespeaker embeddings, threshold 0.4, biased toward
  splitting a voice rather than merging two people). Runs in a child process (`src/main/diarWorker.js`).
  Voices under 25 s of speech are grouped as "Other voices". Detected voices are suggestions, not identifications.
- Editing is an overlay: `review.json` per case holds people, voice-to-person assignments, line edits
  (text, speaker, split, delete) and a history. The machine transcript is never modified; every edited line
  can be reverted, and Undo (⌘Z) steps back through changes, including bulk ones.
- Matching voices across cameras: when the same words are heard on two cameras at the same moment
  (using the sync), the voice that said them on each camera is probably the same person. The People panel lists
  these pairs with the evidence (lines heard together), flags voices that look like a mix of people, and applies a
  match only when you confirm it. Nothing is merged automatically; matches undo as one step.
- ⌘-click / Shift-click lines to select several, then reassign or delete them together.
- Live captions (Playback tab, the CC button, or C): the line being spoken is shown over the picture with who said it,
  for the audible camera or every camera. Captions are an on-screen layer only; nothing is burned into a video or written
  to any file. They follow the transcript as edited, each camera shows only what its own microphone heard, and timing is
  per transcript line (about a second). A name appears only after a reviewer assigns the voice to a person; machine-grouped
  voices show as "Speaker N" marked UNCONFIRMED.
- Export (`.txt`) lists speakers and ends with the original machine text of every edited line.
- Models and caches: `~/Library/Application Support/BodyCamSync/models/` and `.../projects/<id>/`.

## Opening, storage, and layout

- Open a whole folder, or just some files: "choose individual files", drop several files on the front screen,
  or File → Open Files… (⇧⌘O). A hand-picked set is its own case, remembered in Recent.
- Front screen → "Free up space…": per case, remove local video copies and/or prepared audio (audio is re-made the
  next time the case is opened). Originals, transcripts, speaker names and edits are never removed.
- Drag the bar above the timeline to resize it (double-click: fit every camera). With many cameras the lanes scroll
  with the mouse wheel; Shift+wheel pans time. Files that don't follow a known naming pattern get short labels made
  from what differs between them.

## Playback audio

- Sync, transcripts and speaker detection use a 16 kHz analysis copy of each audio track (`s*.wav`).
- What you hear is `p*.m4a` when possible: the camera's ORIGINAL AAC track copied out of the video unchanged
  (about 15 MB per 40 minutes). A copy is used only if it is verified to line up with the analysis audio along the
  whole recording (equal length within 3 ms, loud stretches matching within 1 ms). Some cameras' audio clocks run a
  few ppm off their video timestamps (a car mic drifted 12 ms over 38 minutes), so those tracks keep a lossless
  16-bit FLAC copy (`p*.flac`) instead.
- Front screen → Free up space → "Shrink audio copies" converts older cases the same way, verifying every track
  before removing its larger lossless copy.

## Keys

Space play/pause · ← → one frame · ⇧← ⇧→ one second · J / L ten seconds · 1-9 switch camera · Tab next · G grid/single · C captions

## Layout

    src/main      main process: scanning, grouping, audio extraction, sync, proxies, fingerprints
    src/preload   safe bridge to the renderer
    src/renderer  UI: engine (playback), timeline, app (views/panels)
    scripts       make-icon.js

## Design

Two-tone: a navy "room" around the video and timeline, bond-paper panels for transcript and side tabs. Red (`#B5443A`) is the only accent. Type is Public Sans (interface, tabular numerals) and Source Serif 4 (headlines, transcript), bundled in `src/renderer/fonts/`. Cameras carry lettered exhibit tabs (A, B, C…). The transcript is set like pleading paper: running line numbers, a double red margin rule, "Page N" every 25 lines, and exports cite `page:line`.

## Windows

**Download (newest release):**
- Portable zip, no install: https://github.com/johnchitwood/BodyCamSync/releases/latest/download/BodyCamSync-Windows-x64.zip
- Installer: https://github.com/johnchitwood/BodyCamSync/releases/latest/download/BodyCamSync-Windows-x64-Setup.exe

These links always point at the newest release. To publish a new one, push a version tag (for example
`git tag v0.2.0 && git push origin v0.2.0`); the workflow below builds it and attaches both files to a public
GitHub Release.

The app is cross-platform (Electron). Windows builds are made by GitHub Actions on a Windows machine, not on a Mac:
Actions tab → "Build Windows app" → Run workflow. It compiles the speech engine (whisper.cpp) from source, runs
`npm run smoke`, then saves an installer and a portable zip as an artifact (visible only to signed-in repo users, kept 90 days); a tag push also publishes them as a release. Builds are unsigned, so
Windows SmartScreen will warn on first run ("More info" → "Run anyway").

Differences from the Mac build:
- Two speech engines ship: `whisper-cli-gpu.exe` runs on the graphics card through Vulkan (NVIDIA, AMD or Intel; the
  card's normal driver provides Vulkan), and `whisper-cli.exe` runs on the processor (AVX2). The graphics-card engine is
  tried first; if it can't start or fails (no driver, old driver, out of video memory), that file is redone on the
  processor and the processor is used for the rest of the session. The time estimate shown is a rough guess.
- Local video copies decode the original on the graphics card (`-hwaccel auto`) and use the NVIDIA/Intel/AMD hardware
  encoder when a quick test encode succeeds. With an NVIDIA card, NVIDIA's own decoder (NVDEC) is asked for first. If a step
  fails on a file, it is retried with the next option: other GPU decoding, software decoding, then
  software x264.
- The window buttons sit at the top right; shortcuts use Ctrl instead of ⌘.

`npm run smoke` checks ffmpeg, the sync engine (finds a known offset to the millisecond), the speech engine and the
speaker-detection library on whichever platform it runs on.
