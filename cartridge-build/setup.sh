#!/bin/sh
# setup.sh — fetch the Leap 2.1.0-emu.1 sources into leap/, apply the cartridge build (leap.patch)
# and build it. The result is leap/build/cart/leap_v2_cart_{home,exrom}.bin, which the IDE ships in
# ../cartridge/2.1.0-emu.1/, and the release ROMs leap/v2_{home,exrom}.bin for the tools and tests.
#
#   ./setup.sh            clone https://github.com/nchiker/2068-Leap (or $LEAP_REPO) and build
#
# Needs git, make, sjasmplus and Python 3.
set -eu
cd "$(dirname "$0")"
TAG=v2.1.0-emu.1
REPO=${LEAP_REPO:-https://github.com/nchiker/2068-Leap.git}

if [ ! -d leap ]; then
  git clone --quiet "$REPO" leap
  git -C leap checkout --quiet -b cartridge "$TAG"
  git -C leap am --quiet ../leap.patch
fi
make -C leap cart
cmp leap/build/cart/leap_v2_cart_home.bin ../cartridge/2.1.0-emu.1/leap_v2_cart_home.bin &&
  cmp leap/build/cart/leap_v2_cart_exrom.bin ../cartridge/2.1.0-emu.1/leap_v2_cart_exrom.bin &&
  echo "setup.sh: the cartridge images match the IDE's cartridge/2.1.0-emu.1/"
