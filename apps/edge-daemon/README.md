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
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. Set `DATABASE_URL`
to the Neon PostgreSQL connection string to enable persistent save states; its
TLS connection is verified by the system certificate store. `REDIS_URL` is
optional and is used only as a best-effort hot cache. `PORT` defaults to `8080`.

When save-state persistence is configured, slot 0 is written to R2 at
`saves/{user_id}/{game_id}.state` and its key and byte size are upserted into
the `save_states` table. An existing slot 0 is restored after the Libretro core
loads the ROM. Save/load requests from the browser wait for R2 and PostgreSQL
operations and report failures rather than treating a queued write as saved.

After starting the daemon, create a browser session through the orchestrator.
The edge daemon steps the loaded core at approximately 60 Hz and sends frames
through its negotiated VP8 video track. Audio encoding/streaming is not yet
implemented.

## Controller input

The browser creates an ordered WebRTC DataChannel named `input`. It sends the
current Libretro Retropad state as two little-endian bytes; the daemon exposes
the 16 button bits through `retro_input_state` for player port 0.
