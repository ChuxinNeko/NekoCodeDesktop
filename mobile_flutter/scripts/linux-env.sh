#!/usr/bin/env sh
# Optional user-local toolchain on the morax development machine.
# Source scripts/env.sh first; standard system toolchains do not need this file.
_nekocode_linux="$HOME/.local/share/nekocode/linux-toolchain"
if [ -x "$_nekocode_linux/bin/clang++" ]; then
  export PATH="$_nekocode_linux/bin:$_nekocode_linux/root/usr/bin:$PATH"
  export PKG_CONFIG_PATH="$_nekocode_linux/root/usr/lib/x86_64-linux-gnu/pkgconfig:$_nekocode_linux/root/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi
unset _nekocode_linux
