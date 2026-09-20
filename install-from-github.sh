#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL=${BTC_MONITOR_REPO_URL:-https://github.com/detydanesu/btc-monitor-local.git}
INSTALL_DIR=${BTC_MONITOR_INSTALL_DIR:-"$HOME/.local/share/btc-monitor-local"}

mkdir -p "$(dirname -- "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating $INSTALL_DIR"
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is required to update an existing checkout: $INSTALL_DIR" >&2
    exit 1
  fi
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  if [[ -e "$INSTALL_DIR" && -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "Install directory exists and is not a Git checkout: $INSTALL_DIR" >&2
    echo "Set BTC_MONITOR_INSTALL_DIR to an empty directory and retry." >&2
    exit 1
  fi
  if command -v git >/dev/null 2>&1; then
    echo "Cloning $REPO_URL to $INSTALL_DIR"
    git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
  else
    archive_url="${REPO_URL%.git}/archive/refs/heads/main.tar.gz"
    if command -v curl >/dev/null 2>&1; then
      downloader=(curl -fsSL "$archive_url")
    elif command -v wget >/dev/null 2>&1; then
      downloader=(wget -qO- "$archive_url")
    else
      echo "Git, curl, or wget is required to download the project." >&2
      exit 1
    fi
    command -v tar >/dev/null 2>&1 || { echo "tar is required to unpack the project." >&2; exit 1; }
    mkdir -p "$INSTALL_DIR"
    echo "Downloading $archive_url to $INSTALL_DIR"
    "${downloader[@]}" | tar -xz --strip-components=1 -C "$INSTALL_DIR"
  fi
fi

if [[ -d "$INSTALL_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
  echo "Using source revision $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

exec bash "$INSTALL_DIR/install.sh" "$@"
