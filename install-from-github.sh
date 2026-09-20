#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL=${BTC_MONITOR_REPO_URL:-https://github.com/detydanesu/btc-monitor-local.git}
INSTALL_DIR=${BTC_MONITOR_INSTALL_DIR:-"$HOME/.local/share/btc-monitor-local"}

download_archive() {
  local destination=$1
  local archive_url="${REPO_URL%.git}/archive/refs/heads/main.tar.gz"
  local downloader
  if command -v curl >/dev/null 2>&1; then
    downloader=(curl -fsSL "$archive_url")
  elif command -v wget >/dev/null 2>&1; then
    downloader=(wget -qO- "$archive_url")
  else
    echo "Git, curl, or wget is required to download the project." >&2
    return 1
  fi
  command -v tar >/dev/null 2>&1 || { echo "tar is required to unpack the project." >&2; return 1; }
  mkdir -p "$destination"
  echo "Downloading $archive_url"
  "${downloader[@]}" | tar -xz --strip-components=1 -C "$destination"
}

fetch_source() {
  local destination=$1
  if command -v git >/dev/null 2>&1; then
    echo "Cloning $REPO_URL to $destination"
    git clone --depth 1 --branch main "$REPO_URL" "$destination"
  else
    download_archive "$destination"
  fi
}

mkdir -p "$(dirname -- "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating $INSTALL_DIR"
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is required to update an existing checkout: $INSTALL_DIR" >&2
    exit 1
  fi
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  source_ready=0
  if [[ -e "$INSTALL_DIR" && -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    if [[ -f "$INSTALL_DIR/install.sh" && -f "$INSTALL_DIR/btc-realtime-monitor.mjs" ]]; then
      echo "Updating existing non-Git installation: $INSTALL_DIR"
      staging_dir=$(mktemp -d)
      cleanup_staging() { rm -rf -- "$staging_dir"; }
      trap cleanup_staging EXIT
      fetch_source "$staging_dir/source"
      if [[ -f "$INSTALL_DIR/config.json" ]]; then
        cp -p -- "$INSTALL_DIR/config.json" "$staging_dir/config.json.keep"
      fi
      cp -a -- "$staging_dir/source/." "$INSTALL_DIR/"
      if [[ -f "$staging_dir/config.json.keep" ]]; then
        cp -p -- "$staging_dir/config.json.keep" "$INSTALL_DIR/config.json"
      fi
      trap - EXIT
      cleanup_staging
      echo "Updated source files and preserved config.json and data/."
      source_ready=1
    else
      echo "Install directory exists and is not a recognized BTC Monitor installation: $INSTALL_DIR" >&2
      echo "Set BTC_MONITOR_INSTALL_DIR to an empty directory and retry." >&2
      exit 1
    fi
  fi
  if [[ "$source_ready" == "0" ]]; then
    if command -v git >/dev/null 2>&1; then
      echo "Cloning $REPO_URL to $INSTALL_DIR"
      git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
    else
      download_archive "$INSTALL_DIR"
    fi
  fi
fi

if [[ -d "$INSTALL_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
  echo "Using source revision $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

exec bash "$INSTALL_DIR/install.sh" "$@"
