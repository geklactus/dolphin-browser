# dolphin-browser

[wasm-dolphin](https://github.com/geklactus/wasm-dolphin) — the Dolphin GameCube/Wii
emulator compiled to WebAssembly — packaged from a **pinned repository and commit** with a
few patches, and published as a GitHub release so a web host can fetch it by URL and check
it by sha256. Nothing is compiled here: wasm-dolphin commits its prebuilt core
(`dolphin-core-upstream.{js,wasm}`, whose SHA-256 its page pins and verifies before use),
and the patches touch only the page's JavaScript.

The pinned repository is our fork of
[dougchansan/wasm-dolphin](https://github.com/dougchansan/wasm-dolphin) (the research
prototype), which carries its patch series onto current Dolphin, builds the core in CI on a
locked Linux toolchain, and adds a Wii Remote driven from the page — the mouse over the
game is the pointer, left/right click A/B, the keyboard has Dolphin's desktop defaults, and
a gamepad is held like a Classic Controller. Wii titles that need the pointer run from here.

The sibling of [play-browser](https://github.com/geklactus/play-browser) (PS2), for the
same host: retroarch.aoede.me's `/play/gc/`.

## What's in a release

`dolphin-browser-<version>.tar.gz` unpacks to one directory, served as it is:

| | |
|---|---|
| `index.html`, `src/` | the page (upstream's, patched) — module workers, ES modules |
| `cores/dolphin/dolphin-core-upstream.js`, `.wasm` | the engine, byte-identical to upstream's (the page checks the wasm's SHA-256) |
| `MANIFEST` | upstream commit, Dolphin commit, core sha256, patches, build run |
| `SHA256SUMS` | of every file |
| `LICENSE-wasm-dolphin.txt` | GPLv2 |

The page needs cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`) for its 1.5 GiB of shared memory, module
workers, and a desktop Chromium; WebGPU for the hardware renderer (the software renderer
runs without it).

## Pins and patches

- `wasm-dolphin-repo` and `wasm-dolphin-commit` — the repository and commit the page and
  core come from. Bump the commit, open a PR, and the PR build shows whether the patches
  still apply and the core still matches its pin.
- `patches/*.patch`, applied with `git apply` in name order:
  - `0001-worker-remote-disc-saves-start.patch` (the disc worker):
    - **a disc on the server, read a piece at a time.** Upstream mounts a dropped `File`
      through Emscripten's WORKERFS, which reads it by `slice()` + `FileReaderSync`. A
      `RangeDisc` stands in for the file: its slices come from 4 MiB blocks fetched with
      HTTP Range requests — synchronously, which a dedicated worker may do — kept in a
      256 MiB LRU, the next block prefetched after a miss. The reader is swapped for one
      that uses a slice's bytes as they are. A 1.4 GB image starts in seconds.
    - **saves that survive a reload.** Dolphin's user directory is MEMFS; the GCI-folder
      memory-card files under `/dolphin-user/GC` and the Wii NAND under `/dolphin-user/Wii`
      (a Wii game's save is `title/<id>/data/…`; `tmp/` stays out) are restored from
      IndexedDB before a disc boots and written out when they change (every 5 s, and on
      request). Since 2026.10.23-1 for the NAND; before that a Wii save lived until the
      tab closed.
    - `start`/`pause`/`resume` messages the adapter sends but the worker never answered
      (every Start showed "Unknown upstream worker message"); `flushSaves`/`discStats`.
    - the 16 MiB boot gate lowered to 1 MiB: a homebrew disc is a disc too.
  - `0002-page-disc-param-states-webgpu.patch` (the page):
    - `?disc=<same-origin URL>`: the page gets the size with a HEAD and the game id from
      the first 32 KB, the drop zone becomes a Start button (the AudioContext needs the
      click), the worker gets the `RangeDisc`. Settings that reload the page keep it.
      The panel shows how much was read and how often the core waited on the network.
    - the slot Save/Load buttons, stubs in the core, capture a real state (the same path
      as the download button) and keep it in IndexedDB under the game's id.
    - the per-game "hardware" renderer profile is only applied where WebGPU hands out an
      adapter (one probe per page); `navigator.gpu` alone is no promise of one.
    - the memory cards are flushed when the page is hidden or closed.
  - `0003-styles-start-badge.patch`: the Start badge.

## Checked against real discs

Headless Chrome on a Mac, the disc served by a Range-capable test server with the COOP/COEP
headers, the page opened with `?disc=`: Luigi's Mansion (157 MB RVZ) boots to its title on
the software renderer (94 % speed) and on the hardware one, reading 44–52 MB of the disc in
the first minute with 5–7 short waits; Animal Crossing (20 MB RVZ) runs at full speed but
renders black on both paths, which is upstream's documented state for that title (its
`game-profiles.js`, issue #11), not the remote-disc path. With the fork's core, Mario Kart
Wii (real disc) boots to its main menu at 60 fps with the mouse as the Wii Remote pointer —
the menu highlight follows it — and Melee still boots on the same core.

## Releasing

A tag `v<version>` (or **Run workflow** with a version) builds and publishes the release;
every push and PR builds and uploads the same archive as a workflow artifact. Version
strings are `<pinned commit date>-<n>`.

## Licence

wasm-dolphin is GPLv2-or-later, as is Dolphin; the packaged page and core are the same
work and are distributed under the same terms. The corresponding source is the pinned
repository's commit (both in `MANIFEST`) plus the patches here.
