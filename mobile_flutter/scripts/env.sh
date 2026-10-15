#!/usr/bin/env sh
# Source this file: . scripts/env.sh
# Preserve explicit mirror overrides made by the caller.
export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"
export PUB_HOSTED_URL="${PUB_HOSTED_URL:-https://pub.flutter-io.cn}"

# Use this server's SDK if it exists; other machines can use Flutter on PATH/FVM.
_nekocode_flutter="$HOME/.local/share/nekocode/flutter-3.47.7/bin"
if [ -x "$_nekocode_flutter/flutter" ]; then
  export PATH="$_nekocode_flutter:$PATH"
fi
unset _nekocode_flutter
