#!/usr/bin/env bash
# Install markm into the user's local prefix and register it as a handler for
# markdown files, so `xdg-open file.md`, file managers, and "Open With" all
# launch it. No root required (installs under ~/.local by default).
#
# Run `pnpm build && pnpm exec neu build --release` first to produce the bundle.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX="${PREFIX:-$HOME/.local}"

# Pick the binary for this architecture.
case "$(uname -m)" in
  x86_64)          BIN=markm-linux_x64 ;;
  aarch64|arm64)   BIN=markm-linux_arm64 ;;
  armv7l|armhf)    BIN=markm-linux_armhf ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

DIST="$REPO_DIR/dist/markm"
if [[ ! -f "$DIST/$BIN" || ! -f "$DIST/resources.neu" ]]; then
  echo "Bundle not found. Build first:" >&2
  echo "  pnpm build && pnpm exec neu build --release" >&2
  exit 1
fi

ICON_SRC="$REPO_DIR/dist/icons/appIcon.png"
[[ -f "$ICON_SRC" ]] || ICON_SRC="$REPO_DIR/public/icons/appIcon.png"

APPDIR="$PREFIX/share/markm"
BINDIR="$PREFIX/bin"
APPS="$PREFIX/share/applications"
ICONS="$PREFIX/share/icons/hicolor/256x256/apps"
MIMEPKGS="$PREFIX/share/mime/packages"

mkdir -p "$APPDIR" "$BINDIR" "$APPS" "$ICONS" "$MIMEPKGS"

# App files: the native binary + its resources.neu must live side by side so
# the runtime finds the bundle next to the executable.
install -m755 "$DIST/$BIN"            "$APPDIR/markm"
install -m644 "$DIST/resources.neu"   "$APPDIR/resources.neu"
install -m644 "$ICON_SRC"             "$ICONS/markm.png"
install -m644 "$REPO_DIR/mime/markm-markdown.xml" "$MIMEPKGS/markm-markdown.xml"

# Convenience launcher on PATH. Neutralino resolves resources.neu relative to
# --path, so we pass the app dir explicitly; that way markm works from any CWD.
# By default it detaches from the terminal so `markm file.md` frees the prompt;
# --fg (or MARKM_FG=1) keeps it in the foreground. The APPDIR assignment is
# written with %q so the rest of the body can be a verbatim (unexpanded) heredoc.
{
  printf '#!/usr/bin/env bash\n'
  printf 'APPDIR=%q\n' "$APPDIR"
  cat <<'EOF'
# --fg / MARKM_FG=1 keeps markm attached to the terminal; otherwise detach so the
# shell returns immediately and closing it won't kill the viewer.
fg="${MARKM_FG:-0}"
args=()
for a in "$@"; do
  case "$a" in
    --fg|--foreground) fg=1 ;;
    -*) args+=("$a") ;;
    # Resolve an existing path (e.g. '.', 'notes', '/tmp') to absolute so the
    # detached app — which no longer shares this shell's CWD — can find it.
    *) [ -e "$a" ] && a="$(realpath "$a" 2>/dev/null || printf '%s' "$a")"; args+=("$a") ;;
  esac
done

if [ "$fg" = "1" ]; then
  exec "$APPDIR/markm" --path="$APPDIR" "${args[@]}"
fi

# New session (no controlling tty), stdio detached, backgrounded and disowned.
setsid "$APPDIR/markm" --path="$APPDIR" "${args[@]}" >/dev/null 2>&1 </dev/null &
disown 2>/dev/null || true
EOF
} > "$BINDIR/markm"
chmod 755 "$BINDIR/markm"

# Desktop entry from the template (absolute Exec path; --path=app dir so the
# bundle is found when launched by xdg-open / a file manager from any CWD).
sed -e "s|@EXEC@|$APPDIR/markm|g" -e "s|@APPDIR@|$APPDIR|g" -e "s|@ICON@|markm|g" \
  "$REPO_DIR/desktop/markm.desktop.in" > "$APPS/markm.desktop"
chmod 644 "$APPS/markm.desktop"

# Refresh caches and register as the default markdown/text handler.
update-mime-database "$PREFIX/share/mime" 2>/dev/null || true
update-desktop-database "$APPS" 2>/dev/null || true
gtk-update-icon-cache -f -t "$PREFIX/share/icons/hicolor" 2>/dev/null || true
xdg-mime default markm.desktop text/markdown 2>/dev/null || true
xdg-mime default markm.desktop text/x-markdown 2>/dev/null || true
xdg-mime default markm.desktop text/plain 2>/dev/null || true
xdg-mime default markm.desktop application/json 2>/dev/null || true

echo "Installed markm -> $APPDIR"
echo "Registered as the default handler for markdown files."
echo "Try:  xdg-open <file>.md    or    markm <file>.md"
echo "(If ~/.local/bin isn't on PATH, add it to use the 'markm' command.)"
