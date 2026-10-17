#!/bin/sh
# Chromium binds DevTools to loopback only; socat is the container's network face on 9222.
# Who may reach it is decided by the Docker network, not by the bind address.
# --no-sandbox: the container runs with every capability dropped and no-new-privileges.
# No --remote-allow-origins: the runtime (Playwright over CDP) sends no Origin header, which Chromium
# always lets through; a web page always sends one, so pages cannot open a DevTools socket.
set -eu
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &
exec chromium \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-crash-reporter \
  --font-render-hinting=none \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/profile
