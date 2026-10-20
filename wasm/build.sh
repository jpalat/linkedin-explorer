#!/bin/sh
# Build the WebAssembly module into ../app, plus the native linkedin-build CLI,
# then copy the page into $SITE_DIR (default /srv/sites/linkedin-explorer) if that directory exists.
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/linkedin_export.wasm ../app/
cargo build --release
ls -l ../app/linkedin_export.wasm

SITE=${SITE_DIR:-/srv/sites/linkedin-explorer}
if [ -d "$SITE" ]; then
  # Only the public files: never data.json, which holds your messages.
  (cd ../app && install -m 644 index.html app.js styles.css linkedin_export.wasm "$SITE"/)
  echo "Published to $SITE"
fi
