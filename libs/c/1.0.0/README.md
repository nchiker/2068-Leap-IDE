# Leap-C 1.0.0 library images

The images `LIB "name"` loads into image region 3 (`LX_BASE`, `$F400`): the
data block of each library tape in the Leap-C 1.0.0 release's emulator pack
(`leapc-1.0.0-emulators.zip`, `libs/<name>.tap`), unchanged. The IDE installs
the one a program uses before each run and check, as `LIB "name"` does
(the image at `$F400`, `LIB_LOADED` set), and unloads it otherwise.

| File | SHA-256 | From |
|---|---|---|
| `shapes.bin` (438 bytes) | `c4c145cd1c1b80914166a54c091b7594d03a4eba73f2fa226f755d44fa0f6d0e` | `libs/shapes.tap` (SHA-256 `a9129a8e…` in the release's `SHA256SUMS`), its data block; equal to `build/libs/shapes.bin` of a `make build` |
