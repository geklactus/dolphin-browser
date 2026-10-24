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
- `patches/*.patch`, applied with `git apply` in name order. Since 2026.10.24-1 the disc
  on the server is upstream's own feature (`?disc=<same-origin URL>`, `src/remote-disc.js`
  in the fork: memory, then a copy of the whole image in this device's origin-private file
  system, then HTTP Range through a fetch worker that pulls the rest while the game runs —
  after the first minutes nothing waits on the network and a second launch reads none of
  it). Since 2026.10.24-2 a disc can have a read order beside it, `<disc file>.reads.json`
  (recorded with `?recordreads=1`, or `node tools/probe.mjs --record`): the blocks a title
  reads first go to the front of that background download, which on a first launch cut the
  waits of Mario Kart Wii's first 90 s from 5.3 s to 1.2 s at 100 Mbit / 40 ms. Without one
  (a 404) nothing changes, and with `?opfs=0` there is no background download to reorder.
  The patches are down to what the fork doesn't carry:
  - `0001-worker-saves-start.patch` (the disc worker):
    - **saves that survive a reload.** Dolphin's user directory is MEMFS; the GCI-folder
      memory-card files under `/dolphin-user/GC` and the Wii NAND under `/dolphin-user/Wii`
      (a Wii game's save is `title/<id>/data/…`; `tmp/` stays out) are restored from
      IndexedDB before a disc boots and written out when they change (every 5 s, and on
      request).
    - `start`/`pause`/`resume` messages the adapter sends but the worker never answered;
      `flushSaves`.
    - the 16 MiB boot gate lowered to 1 MiB: a homebrew disc is a disc too.
  - `0002-page-states-webgpu.patch` (the page):
    - the slot Save/Load buttons, stubs in the core, capture a real state (the same path
      as the download button) and keep it in IndexedDB under the game's id.
    - a per-game profile's switch to the "hardware" renderer is only applied where WebGPU
      hands out an adapter (one probe per page); `navigator.gpu` alone is no promise of
      one.
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
the menu highlight follows it — and Melee still boots on the same core. With
2026.10.24-1 (the fork's tiered reader) the same disc on a 100 Mbit link with 40 ms of
latency waited 14 times in its first 90 s and never after, where the previous reader
waited 22 times across the whole run; a second launch in the same browser read nothing
from the network. With the
2026.10.23-1 core (the fork's cold-code compile cap), a first launch of Mario Kart Wii with
an empty JIT cache holds 100–102 % game speed through the menus over 120 s, where
2026.10.22-1 swung between 2 % and 160 % (median 55–63 %).

Pin only cores built by wasm-dolphin's CI. A core built anywhere else embeds that machine's
absolute source paths, so its digest can't be reproduced; the code is the same. Two CI runs
of the same tree gave byte-identical cores (`b7c5c6fe…`, the 2026.10.23-3 core).

## Releasing

A tag `v<version>` (or **Run workflow** with a version) builds and publishes the release;
every push and PR builds and uploads the same archive as a workflow artifact. Version
strings are `<pinned commit date>-<n>`.

## Licence

wasm-dolphin is GPLv2-or-later, as is Dolphin; the packaged page and core are the same
work and are distributed under the same terms. The corresponding source is the pinned
repository's commit (both in `MANIFEST`) plus the patches here.
