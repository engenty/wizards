#!/usr/bin/env bash
# engenty wizards — installer for macOS and Linux.
#
#   curl -fsSL https://engenty.ai/install.sh | bash
#
# It needs curl and tar, nothing else, and asks for no password. Everything goes into
# ~/.engenty/wizards (ENGENTY_HOME moves it):
#
#   tools/node-v<version>/   its own Node; a Node you already have is left alone
#   runtime/<version>/       the runtime (the npm package @engenty/wizards-runtime), from the
#                            GitHub release; runtime/current
#                            names the one that runs, the one before stays for going back
#   bin/wizards              the command, linked into ~/.local/bin
#   data/                    your wizards and results (made at the first start)
#
# Then the guided setup runs (`wizards setup`): your engenty account, an AI client to think
# with, ffmpeg, starting at login. Running the installer again updates an install; your data
# is kept.
#
#   --yes            ask nothing and install nothing optional
#   --local          no account: nothing leaves this computer (the docs explain it)
#   --no-setup       only Node, the runtime and the command (what `update` runs)
#   --version <v>    this version instead of the newest
#   --no-link        do not link the command into ~/.local/bin
#
# For tests: ENGENTY_WIZARDS_PACKAGE (an npm spec or a tarball instead of the release's
# package), ENGENTY_WIZARDS_NODE_VERSION, ENGENTY_WIZARDS_NO_LINK=1 (as --no-link).
#
# Written for the bash 3.2 that macOS ships. Nothing here reads stdin: the script itself may be
# arriving through it.
set -Eeuo pipefail

NODE_VERSION="${ENGENTY_WIZARDS_NODE_VERSION:-24.14.0}"
# The runtime's npm package, and its file on the GitHub release (npm pack names it so).
PACKAGE_NAME="@engenty/wizards-runtime"
PACKAGE_FILE="engenty-wizards-runtime"
# What the runtime was called from 0.1.9 to 0.7.4; `wizards` is the launcher now (`npx wizards`).
LEGACY_NAME="wizards"
# What the package and the command were called up to 0.1.8.
OLD_NAME="engenty-wizards"
RELEASES="https://github.com/engenty/wizards/releases"

main() {
  YES=0
  LOCAL=0
  SETUP=1
  LINK=1
  [ -n "${ENGENTY_WIZARDS_NO_LINK:-}" ] && LINK=0
  VERSION=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes | -y) YES=1 ;;
      --local) LOCAL=1 ;;
      --no-setup) SETUP=0 ;;
      --no-link) LINK=0 ;;
      --version)
        shift
        VERSION="${1:-}"
        [ -n "$VERSION" ] || die "--version needs a version, e.g. --version 0.1.0"
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) die "Unknown option $1" ;;
    esac
    shift
  done

  BASE="${ENGENTY_HOME:-$HOME/.engenty}"
  HOME_DIR="$BASE/wizards"
  LOG="$HOME_DIR/logs/install.log"
  NODE_DIR="$HOME_DIR/tools/node-v$NODE_VERSION"
  WRAPPER="$HOME_DIR/bin/wizards"
  LOCAL_BIN="$HOME/.local/bin"

  style
  trap 'printf "%s" "$SHOW"' EXIT
  trap 'failed' ERR

  command -v curl >/dev/null 2>&1 || die "curl is needed and was not found."
  command -v tar >/dev/null 2>&1 || die "tar is needed and was not found."
  mkdir -p "$HOME_DIR/logs" "$HOME_DIR/tools" "$HOME_DIR/bin"
  printf '\n--- %s install.sh\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"

  banner
  printf '%s  Installing into %s\n%s\n' "${GRAY}┌$RESET" "$BOLD$(tilde "$HOME_DIR")$RESET" "$BAR"
  platform
  package
  node
  runtime
  command_link
  old_command
  if [ "$SETUP" = 1 ]; then
    printf '%s  %s\n\n' "${GRAY}└$RESET" "Installed. Next, a few questions to set it up."
    printf '%s' "$SHOW"
    trap - EXIT ERR
    # --local goes on to the setup: it is the setup's account step that keeps the install off
    # the account. The questions need a terminal; stdin may be the pipe this script came through.
    SETUP_ARGS=""
    [ "$LOCAL" = 1 ] && SETUP_ARGS="--local"
    if [ "$YES" = 1 ] || [ "$TTY" != 1 ] || ! (exec </dev/tty) 2>/dev/null; then
      # shellcheck disable=SC2086
      exec "$WRAPPER" setup --yes $SETUP_ARGS </dev/null
    fi
    # shellcheck disable=SC2086
    exec "$WRAPPER" setup $SETUP_ARGS </dev/tty
  fi
  printf '%s  %s\n' "${GRAY}└$RESET" "Installed engenty wizards $INSTALLED."
}

usage() {
  cat <<'USAGE'
engenty wizards — installer for macOS and Linux

  curl -fsSL https://engenty.ai/install.sh | bash
  curl -fsSL https://engenty.ai/install.sh | bash -s -- --yes

Puts its own Node, the runtime and the `wizards` command into ~/.engenty/wizards
(ENGENTY_HOME moves it), then runs the guided setup: it signs this computer in to your
engenty account. Run it again to update.

  --yes            ask nothing and install nothing optional
  --local          no account: nothing leaves this computer (the docs explain it)
  --no-setup       only Node, the runtime and the command
  --version <v>    this version instead of the newest
  --no-link        do not link the command into ~/.local/bin

To remove it: delete ~/.engenty/wizards (your wizards and results are in its data/ folder)
and ~/.local/bin/wizards.
USAGE
}

# --- how it looks ----------------------------------------------------------------------------

style() {
  TTY=0
  RESET="" BOLD="" DIM="" GRAY="" GREEN="" RED="" ORANGE="" MAGENTA="" HIDE="" SHOW=""
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
    TTY=1
    RESET=$'\033[0m' BOLD=$'\033[1m' DIM=$'\033[2m' GRAY=$'\033[90m' GREEN=$'\033[32m'
    RED=$'\033[31m' ORANGE=$'\033[38;2;224;83;27m' MAGENTA=$'\033[35m'
    HIDE=$'\033[?25l' SHOW=$'\033[?25h'
  fi
  BAR="${GRAY}│$RESET"
  FRAMES=(◒ ◐ ◓ ◑)
}

# The tall engenty, the rose one with one eye, in pixels: two rows of them make one line of half
# blocks. . nothing  R rose  r its shade  K the mouth. The eye goes on top.
ENGENTY=(
  "....R...."
  "...RRR..."
  "..RRRRR.."
  "..RRRRR.."
  ".RRRRRRr."
  ".RRRRRRr."
  "RRRRRRRRr"
  "RRRRRRRRr"
  "RRRRRRRRr"
  "RRRRRRRRr"
  ".RRRKRRr."
  ".RRRRRRr."
  ".rRRRRrr."
  "..rrrrr.."
)
# Its tip swaying to one side or the other, like a flame.
ENGENTY_LEFT=("...R....." "..RRR...." "..RRRR..." ".RRRRRR..")
ENGENTY_RIGHT=(".....R..." "....RRR.." "...RRRR.." "..RRRRRR.")

# The eye: five rows of five pixels from the body's fifth row. W white, K pupil, . the body.
eye_rows() {
  case "$1" in
    left) EYE=(".WWW." "WWWWW" "KKWWW" "KKWWW" ".WWW.") ;;
    right) EYE=(".WWW." "WWWWW" "WWWKK" "WWWKK" ".WWW.") ;;
    up) EYE=(".WKK." "WWKKW" "WWWWW" "WWWWW" ".WWW.") ;;
    shut) EYE=("....." "....." "K...K" ".KKK." ".....") ;;
    *) EYE=(".WWW." "WWWWW" "WWKKW" "WWKKW" ".WWW.") ;;
  esac
}

# Sets C to the colour of a pixel, as a foreground (3) or background (4) parameter.
pixel_colour() {
  case "$1" in
    R) C="${2}8;2;240;36;86" ;;
    r) C="${2}8;2;188;18;62" ;;
    W) C="${2}8;2;255;255;255" ;;
    K) C="${2}8;2;46;8;20" ;;
    S) C="${2}8;2;96;96;96" ;;
  esac
}

# One picture of the engenty, into PICTURE: 9 lines of 9 columns. $1 the tip (still, left,
# right), $2 the eye, $3 how many pixels it is off the ground (0 to 2).
engenty_picture() {
  local tip="$1" lift="${3:-0}" rows=() y x row top bottom line pixel
  eye_rows "$2"
  # Two rows of air for a hop, fourteen of engenty, its shadow and a row below that.
  for y in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do
    row="........."
    if [ "$y" -ge $((2 - lift)) ] && [ "$y" -lt $((16 - lift)) ]; then
      x=$((y - 2 + lift))
      row="${ENGENTY[x]}"
      [ "$tip" = left ] && [ "$x" -lt 4 ] && row="${ENGENTY_LEFT[x]}"
      [ "$tip" = right ] && [ "$x" -lt 4 ] && row="${ENGENTY_RIGHT[x]}"
      if [ "$x" -ge 4 ] && [ "$x" -lt 9 ]; then
        pixel="${EYE[x - 4]}"
        line=""
        for top in 0 1 2 3 4; do
          if [ "${pixel:top:1}" = "." ]; then line="$line${row:top+2:1}"; else line="$line${pixel:top:1}"; fi
        done
        row="${row:0:2}$line${row:7}"
      fi
    fi
    # The shadow shrinks as the engenty leaves the ground.
    if [ "$y" = 16 ]; then
      case "$lift" in
        0) row="..SSSSS.." ;;
        1) row="...SSS..." ;;
        *) row="....S...." ;;
      esac
    fi
    rows+=("$row")
  done
  PICTURE=()
  for y in 0 2 4 6 8 10 12 14 16; do
    line=""
    for x in 0 1 2 3 4 5 6 7 8; do
      top="${rows[y]:x:1}"
      bottom="${rows[y + 1]:x:1}"
      if [ "$top" = "." ] && [ "$bottom" = "." ]; then
        line="$line$RESET "
      elif [ "$top" = "$bottom" ]; then
        pixel_colour "$top" 3
        line="$line$RESET"$'\033['"${C}m█"
      elif [ "$top" = "." ]; then
        pixel_colour "$bottom" 3
        line="$line$RESET"$'\033['"${C}m▄"
      elif [ "$bottom" = "." ]; then
        pixel_colour "$top" 3
        line="$line$RESET"$'\033['"${C}m▀"
      else
        pixel_colour "$top" 3
        top="$C"
        pixel_colour "$bottom" 4
        line="$line$RESET"$'\033['"$top;${C}m▀"
      fi
    done
    PICTURE+=("$line$RESET")
  done
}

# Prints a picture with the name beside it, over the one before, and holds it for $4 seconds.
banner_frame() {
  local i=0 line
  engenty_picture "$1" "$2" "$3"
  [ -n "${BANNER_DRAWN:-}" ] && printf '\033[9A'
  BANNER_DRAWN=1
  for line in "${PICTURE[@]}"; do
    printf '\r   %s' "$line"
    case "$i" in
      3) printf '    %sengenty wizards%s' "$BOLD" "$RESET" ;;
      4) printf '    %sMake a wish. Get your wizard.%s' "$DIM" "$RESET" ;;
      5) printf '    %sIt guides you step by step.%s' "$DIM" "$RESET" ;;
      6) printf '    %sLet AI do the work.%s' "$DIM" "$RESET" ;;
    esac
    printf '\n'
    i=$((i + 1))
  done
  sleep "$4"
}

banner() {
  # Only on a terminal: `update` from the studio reads plain lines.
  if [ "$TTY" != 1 ]; then
    return
  fi
  printf '\n%s' "$HIDE"
  # It wakes up, looks around, hops and blinks: a second and a half.
  banner_frame still shut 0 .25
  banner_frame still open 0 .2
  banner_frame still left 0 .18
  banner_frame still right 0 .18
  banner_frame still open 0 .1
  banner_frame still up 1 .07
  banner_frame left up 2 .1
  banner_frame still open 1 .07
  banner_frame right open 0 .09
  banner_frame left open 0 .09
  banner_frame still open 0 .12
  banner_frame still shut 0 .06
  banner_frame still open 0 0
  printf '%s\n' "$SHOW"
}

tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# A finished step: the green diamond, what it was, and a detail in gray.
done_step() {
  [ "$TTY" = 1 ] && printf '\r\033[K'
  printf '%s  %s' "${GREEN}◇$RESET" "$1"
  [ -n "${2:-}" ] && printf '  %s' "$DIM$2$RESET"
  printf '\n%s\n' "$BAR"
}

die() {
  printf '%s' "${SHOW:-}"
  [ "${TTY:-0}" = 1 ] && printf '\r\033[K'
  printf '%s  %s\n' "${RED:-}■${RESET:-}" "$1" >&2
  trap - EXIT ERR
  exit 1
}

failed() {
  local tail=""
  [ -f "$LOG" ] && tail="$(tail -n 12 "$LOG" 2>/dev/null | sed 's/^/   /')"
  [ -n "$tail" ] && printf '\n%s\n' "$DIM$tail$RESET" >&2
  die "${STEP:-The installer} failed. The whole log: $(tilde "$LOG")"
}

# Runs a command with a spinner and the seconds it takes; its output goes to the log.
spin() {
  local label="$1" pid i=0 started=$SECONDS
  shift
  if [ "$TTY" != 1 ]; then
    "$@" >>"$LOG" 2>&1 </dev/null
    return
  fi
  "$@" >>"$LOG" 2>&1 </dev/null &
  pid=$!
  printf '%s' "$HIDE"
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r\033[K%s  %s %s' "$MAGENTA${FRAMES[i % 4]}$RESET" "$label" "$DIM$((SECONDS - started))s$RESET"
    i=$((i + 1))
    sleep 0.12
  done
  printf '%s' "$SHOW"
  wait "$pid"
}

# Downloads a file with a bar that fills as it arrives.
download() {
  local url="$1" dest="$2" label="$3" pid total size filled i bar
  if [ "$TTY" != 1 ]; then
    curl -fsSL "$url" -o "$dest" 2>>"$LOG" </dev/null
    return
  fi
  total="$(curl -fsSIL "$url" 2>/dev/null </dev/null | tr -d '\r' |
    awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }' || true)"
  : >"$dest"
  curl -fsSL "$url" -o "$dest" 2>>"$LOG" </dev/null &
  pid=$!
  printf '%s' "$HIDE"
  while kill -0 "$pid" 2>/dev/null; do
    size="$(wc -c <"$dest" 2>/dev/null | tr -d ' ')"
    if [ "${total:-0}" -gt 0 ]; then
      filled=$((${size:-0} * 24 / total))
      [ "$filled" -gt 24 ] && filled=24
      bar=""
      i=0
      while [ "$i" -lt 24 ]; do
        if [ "$i" -lt "$filled" ]; then bar="${bar}█"; else bar="${bar}░"; fi
        i=$((i + 1))
      done
      printf '\r\033[K%s  %s  %s %s' "${MAGENTA}◒$RESET" "$label" "$ORANGE$bar$RESET" \
        "$DIM$((${size:-0} / 1048576)) of $((total / 1048576)) MB$RESET"
    else
      printf '\r\033[K%s  %s  %s' "${MAGENTA}◒$RESET" "$label" "$DIM$((${size:-0} / 1048576)) MB$RESET"
    fi
    sleep 0.1
  done
  printf '%s' "$SHOW"
  wait "$pid"
}

# --- the steps -------------------------------------------------------------------------------

platform() {
  STEP="Looking at this machine"
  local system machine name
  system="$(uname -s)"
  machine="$(uname -m)"
  case "$system" in
    Darwin)
      OS=darwin
      name="macOS $(sw_vers -productVersion 2>/dev/null || true)"
      # A terminal under Rosetta says x86_64 on a Mac with Apple silicon.
      [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ] && machine=arm64
      ;;
    Linux)
      OS=linux
      name="Linux"
      # Node's own builds need glibc.
      if (ldd --version 2>&1 || true) | grep -qi musl; then
        die "This Linux uses musl (Alpine). Use the Docker image instead: https://github.com/engenty/wizards#run-it-on-a-server"
      fi
      ;;
    *) die "$system is not supported: macOS and Linux are. On Windows, use WSL." ;;
  esac
  case "$machine" in
    arm64 | aarch64) ARCH=arm64 ;;
    x86_64 | amd64) ARCH=x64 ;;
    *) die "$machine is not supported: arm64 and x64 are." ;;
  esac
  done_step "$name on $ARCH"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    sha256sum "$1" | awk '{ print $1 }'
  fi
}

node() {
  STEP="Installing Node $NODE_VERSION"
  if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" = "v$NODE_VERSION" ]; then
    ln -sfn "node-v$NODE_VERSION" "$HOME_DIR/tools/node"
    done_step "Node $NODE_VERSION" "already here"
    return
  fi
  local name="node-v$NODE_VERSION-$OS-$ARCH" dist="https://nodejs.org/dist/v$NODE_VERSION" tmp expected actual
  tmp="$(mktemp -d "$HOME_DIR/tools/.node.XXXXXX")"
  download "$dist/$name.tar.gz" "$tmp/node.tar.gz" "Downloading Node $NODE_VERSION"
  # The file must be the one nodejs.org lists.
  expected="$(curl -fsSL "$dist/SHASUMS256.txt" 2>>"$LOG" </dev/null | awk -v file="$name.tar.gz" '$2 == file { print $1 }')"
  actual="$(sha256_of "$tmp/node.tar.gz")"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"
    die "The Node download does not match its checksum from nodejs.org."
  fi
  mkdir -p "$tmp/node"
  spin "Unpacking Node $NODE_VERSION" tar -xzf "$tmp/node.tar.gz" -C "$tmp/node" --strip-components 1
  # The headers are for compiling addons, which nothing here does: a third of Node's size.
  rm -rf "$tmp/node/include"
  rm -rf "$NODE_DIR"
  mv "$tmp/node" "$NODE_DIR"
  rm -rf "$tmp"
  ln -sfn "node-v$NODE_VERSION" "$HOME_DIR/tools/node"
  # An older Node of ours is not needed any more.
  for old in "$HOME_DIR"/tools/node-v*; do
    [ "$old" = "$NODE_DIR" ] || rm -rf "$old"
  done
  done_step "Node $NODE_VERSION" "$(tilde "$HOME_DIR/tools/node"), checksum from nodejs.org matches"
}

# GitHub answers /releases/latest with the address of the newest release: …/tag/v1.2.3
latest_version() {
  curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest" 2>>"$LOG" </dev/null |
    sed -n 's#.*/tag/v##p'
}

# What gets installed, decided before anything is downloaded: the tarball of the GitHub release,
# which npm installs like one from its registry; what it depends on comes from the registry.
package() {
  STEP="Looking for the newest release"
  SPEC="${ENGENTY_WIZARDS_PACKAGE:-}"
  if [ -n "$SPEC" ]; then
    return
  fi
  if [ -z "$VERSION" ]; then
    VERSION="$(latest_version || true)"
  fi
  if [ -z "$VERSION" ]; then
    die "No release of engenty wizards was found at $RELEASES."
  fi
  case "$VERSION" in
    0.0.* | 0.1.[0-8])
      die "Version $VERSION holds the package under its old name, $OLD_NAME. This installer installs 0.1.9 and newer."
      ;;
    0.[1-6].* | 0.7.[0-4]) SPEC="$RELEASES/download/v$VERSION/$LEGACY_NAME-$VERSION.tgz" ;;
    *) SPEC="$RELEASES/download/v$VERSION/$PACKAGE_FILE-$VERSION.tgz" ;;
  esac
}

runtime() {
  STEP="Installing engenty wizards"
  local dir="$HOME_DIR/runtime" stage previous path
  # An install of the package under its old name is replaced, not kept beside the new one.
  if [ -d "$dir/node_modules/$OLD_NAME" ]; then
    rm -rf "$dir"
  fi
  mkdir -p "$dir"
  # Each version has its folder (runtime/<version>/, an npm prefix); `current` names the one the
  # command starts, and a version that runs keeps its files. npm is a script that asks for
  # `node`: ours comes first on the PATH. No install scripts run; the runtime works without
  # them. --legacy-peer-deps: no peers on top, which nothing here uses (about 70 MB less).
  stage="$(mktemp -d "$dir/.staging-XXXXXX")"
  spin "Installing engenty wizards (about 650 MB on disk, a minute or two)" \
    env PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install --prefix "$stage" \
    --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund --loglevel=error "$SPEC"
  # The runtime under its name, or under the one it had up to 0.7.4 (`--version 0.7.4`). The
  # package `wizards` of now is only the launcher: no runtime in it.
  if [ -f "$stage/node_modules/$PACKAGE_NAME/package.json" ]; then
    PACKAGE="$PACKAGE_NAME"
    # A command or an update of 0.7.4 or older looks for the runtime under its old name.
    ln -s "$PACKAGE_NAME" "$stage/node_modules/$LEGACY_NAME"
  elif [ -d "$stage/node_modules/$LEGACY_NAME/apps/runtime" ]; then
    PACKAGE="$LEGACY_NAME"
  else
    rm -rf "$stage"
    die "$SPEC holds no runtime of engenty wizards."
  fi
  INSTALLED="$(MANIFEST="$stage/node_modules/$PACKAGE/package.json" \
    "$NODE_DIR/bin/node" -p 'require(process.env.MANIFEST).version')"
  # Up to 0.6.2 runtime/ itself was the prefix.
  if [ -d "$dir/node_modules" ] && [ ! -L "$dir/node_modules" ]; then
    rm -rf "$dir/node_modules" "$dir/package.json" "$dir/package-lock.json"
  fi
  previous="$(readlink "$dir/current" 2>/dev/null || true)"
  rm -rf "${dir:?}/$INSTALLED"
  mv "$stage" "$dir/$INSTALLED"
  ln -sfn "$INSTALLED" "$dir/current"
  # For a command written before the version folders (an older bin/wizards or npx wizards).
  ln -sfn "current/node_modules" "$dir/node_modules"
  # This version and the one before stay; older ones go.
  for path in "$dir"/[0-9]*; do
    case "${path##*/}" in "$INSTALLED" | "$previous") ;; *) rm -rf "$path" ;; esac
  done
  done_step "engenty wizards $INSTALLED" "$(tilde "$dir/$INSTALLED")"
}

command_link() {
  STEP="Writing the command"
  {
    printf '#!/bin/sh\n# engenty wizards — written by install.sh; running the installer again rewrites it.\n'
    # An install outside ~/.engenty finds its folder again through the command.
    if [ "$BASE" != "$HOME/.engenty" ]; then
      # shellcheck disable=SC2016
      printf 'export ENGENTY_HOME="${ENGENTY_HOME:-%s}"\n' "$BASE"
    fi
    printf 'exec "%s" "%s" "$@"\n' "$HOME_DIR/tools/node/bin/node" \
      "$HOME_DIR/runtime/current/node_modules/$PACKAGE/bin/wizards.mjs"
  } >"$WRAPPER"
  chmod 755 "$WRAPPER"
  if [ "$LINK" != 1 ]; then
    done_step "Command" "$(tilde "$WRAPPER")"
    return
  fi
  local link="$LOCAL_BIN/wizards"
  mkdir -p "$LOCAL_BIN"
  # Something else of that name is not ours to replace.
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    done_step "Command" "$(tilde "$WRAPPER") ($(tilde "$link") exists and was left as it is)"
    return
  fi
  ln -sfn "$WRAPPER" "$link"
  done_step "Command" "$(tilde "$link")"
}

# The command under its old name: its file, its link, and a login item that would keep
# starting it. The login item is written again by the command itself.
old_command() {
  local old="$HOME_DIR/bin/$OLD_NAME" link="$LOCAL_BIN/$OLD_NAME" item
  [ -e "$old" ] || return 0
  STEP="Renaming the command"
  rm -f "$old"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$old" ]; then
    rm -f "$link"
  fi
  for item in "$HOME/Library/LaunchAgents/com.engenty.wizards.login.plist" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/engenty-wizards.service"; do
    if grep -qF "$old" "$item" 2>/dev/null; then
      "$WRAPPER" autostart on >>"$LOG" 2>&1 </dev/null || true
      break
    fi
  done
  done_step "Command" "$OLD_NAME is now wizards"
}

main "$@"
