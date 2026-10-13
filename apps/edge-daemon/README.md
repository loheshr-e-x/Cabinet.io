# Cabinet Edge Daemon

The daemon downloads the ROM for an authenticated edge session, loads one
Libretro shared library, and streams newly rendered XRGB8888 frames as VP8 over
WebRTC. The Docker image builds and includes the FCEUmm NES core from a pinned
upstream revision. The MVP supports one active Libretro core/session at a time.

## Build prerequisites

The VP8 encoder links against system libvpx and generates bindings from its
headers. Install libvpx, pkg-config, and clang/libclang development files before
running Cargo. On macOS with Homebrew:

```sh
brew install pkgconf libvpx llvm
```

The Docker builder installs the corresponding Debian packages.

## Runtime configuration

The Docker image sets `LIBRETRO_CORE_PATH` to its bundled FCEUmm core. Override
it only when using a compatible Libretro shared library for another system.
The daemon also requires `JWT_SECRET` and the R2 settings `R2_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. `PORT` defaults to
`8080`.

After starting the daemon, create a browser session through the orchestrator.
The edge daemon steps the loaded core at approximately 60 Hz and sends frames
through its negotiated VP8 video track. Audio encoding/streaming is not yet
implemented.

## Controller input

The browser creates an ordered WebRTC DataChannel named `input`. It sends the
current Libretro Retropad state as two little-endian bytes; the daemon exposes
the 16 button bits through `retro_input_state` for player port 0.
