#!/bin/bash
# Installs the Typecase launcher, menu entry and icon for the current user.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
chmod +x "$DIR/typecase" "$DIR/typecase.py"
ln -sf "$DIR/typecase" "$HOME/.local/bin/typecase"
cp "$DIR/static/icon.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/typecase.svg"
cat > "$HOME/.local/share/applications/typecase.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Typecase
Comment=Install, browse and compare fonts
Exec=$HOME/.local/bin/typecase
Icon=typecase
Terminal=false
Categories=Graphics;Utility;
StartupWMClass=Typecase
DESK
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Typecase installed. Open it from the app menu or run: typecase"
