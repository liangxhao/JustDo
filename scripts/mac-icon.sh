#!/bin/bash
set -e

# Mac icon utilities — formerly fix-mac-icon-display.sh + regenerate-mac-icon.sh
#
# Usage:
#   bash scripts/mac-icon.sh regenerate                — regenerate macOS .icns from PNG icons
#   bash scripts/mac-icon.sh fix-display <path-to-app> — fix macOS icon display on Apple Silicon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODE="${1:-}"

usage() {
  echo "Usage: $0 <mode> [args...]"
  echo "  regenerate                Regenerate macOS .icns from PNG icons"
  echo "  fix-display <path-to-app> Fix macOS icon display on Apple Silicon"
  exit 1
}

# ── regenerate ───────────────────────────────────────────────────────────────

regenerate_icon() {
  ICON_DIR="$PROJECT_ROOT/build/icons"
  PNG_DIR="$ICON_DIR/png"
  MAC_DIR="$ICON_DIR/mac"
  ICONSET_DIR="$MAC_DIR/icon.iconset"

  echo "🎨 Regenerating macOS icon for better compatibility..."

  if [ ! -f "$PNG_DIR/icon_512x512.png" ]; then
    echo "❌ Error: Source PNG not found at $PNG_DIR/icon_512x512.png"
    echo "   Please ensure PNG icons are extracted first."
    exit 1
  fi

  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"

  for size in 16 32 128 256 512; do
    if [ -f "$PNG_DIR/icon_${size}x${size}.png" ]; then
      cp "$PNG_DIR/icon_${size}x${size}.png" "$ICONSET_DIR/icon_${size}x${size}.png"
      echo "  ✓ Added ${size}x${size}"
    fi

    doubled=$((size * 2))
    if [ -f "$PNG_DIR/icon_${size}x${size}@2x.png" ]; then
      cp "$PNG_DIR/icon_${size}x${size}@2x.png" "$ICONSET_DIR/icon_${size}x${size}@2x.png"
      echo "  ✓ Added ${size}x${size}@2x (${doubled}x${doubled})"
    fi
  done

  if [ -f "$MAC_DIR/icon.icns" ]; then
    mv "$MAC_DIR/icon.icns" "$MAC_DIR/icon.icns.backup"
    echo "📦 Backed up old icon to icon.icns.backup"
  fi

  iconutil -c icns "$ICONSET_DIR" -o "$MAC_DIR/icon.icns"

  if [ $? -eq 0 ]; then
    echo "✅ Successfully generated new icon.icns"
    ls -lh "$MAC_DIR/icon.icns"
    file "$MAC_DIR/icon.icns"
    rm -rf "$ICONSET_DIR"
    echo "🧹 Cleaned up temporary iconset directory"
  else
    echo "❌ Failed to generate icon.icns"
    if [ -f "$MAC_DIR/icon.icns.backup" ]; then
      mv "$MAC_DIR/icon.icns.backup" "$MAC_DIR/icon.icns"
      echo "♻️  Restored original icon"
    fi
    exit 1
  fi

  echo ""
  echo "🎉 Icon regeneration complete!"
  echo "   The new icon should work correctly on both Intel and Apple Silicon Macs."
  echo "   You can now rebuild the app with: npm run dist:mac"
}

# ── fix-display ──────────────────────────────────────────────────────────────

fix_icon_display() {
  APP_PATH="$1"

  if [ -z "$APP_PATH" ]; then
    echo "Usage: $0 fix-display <path-to-app>"
    echo "Example: $0 fix-display release/mac-arm64/GucciAI.app"
    exit 1
  fi

  echo "🔧 Applying macOS icon fix for Apple Silicon compatibility..."

  RESOURCES_PATH="$APP_PATH/Contents/Resources"
  INFO_PLIST="$APP_PATH/Contents/Info.plist"

  if [ ! -d "$APP_PATH" ]; then
    echo "❌ Error: App not found at $APP_PATH"
    exit 1
  fi

  if [ ! -f "$INFO_PLIST" ]; then
    echo "❌ Error: Info.plist not found at $INFO_PLIST"
    exit 1
  fi

  echo "  App: $APP_PATH"

  if plutil -extract CFBundleIconName raw "$INFO_PLIST" &>/dev/null; then
    ICON_NAME=$(plutil -extract CFBundleIconName raw "$INFO_PLIST")
    echo "  ✓ CFBundleIconName already set: $ICON_NAME"
  else
    echo "  ℹ️  Adding CFBundleIconName to Info.plist..."
    plutil -insert CFBundleIconName -string "icon" "$INFO_PLIST"
    echo "  ✓ CFBundleIconName added"
  fi

  ICON_FILE="$RESOURCES_PATH/icon.icns"
  if [ ! -f "$ICON_FILE" ]; then
    echo "  ⚠️  Warning: icon.icns not found at $ICON_FILE"
  else
    FILE_SIZE=$(stat -f%z "$ICON_FILE" 2>/dev/null || stat -c%s "$ICON_FILE" 2>/dev/null)
    echo "  ✓ icon.icns found ($(numfmt --to=iec-i --suffix=B $FILE_SIZE 2>/dev/null || echo $FILE_SIZE bytes))"
  fi

  echo "  🧹 Clearing icon cache..."
  xattr -cr "$APP_PATH" 2>/dev/null || true
  touch "$APP_PATH"
  touch "$RESOURCES_PATH"

  echo ""
  echo "✅ Icon fix applied successfully!"
  echo ""
  echo "📝 Next steps:"
  echo "   1. If the app is signed, you may need to re-sign it:"
  echo "      codesign --force --deep --sign - \"$APP_PATH\""
  echo ""
  echo "   2. Clear system icon cache (optional, may require restart):"
  echo "      sudo rm -rf /Library/Caches/com.apple.iconservices.store"
  echo "      killall Dock"
  echo ""
  echo "   3. Test the app to verify the icon appears in About dialog"
}

# ── dispatch ─────────────────────────────────────────────────────────────────

case "$MODE" in
  regenerate)
    regenerate_icon
    ;;
  fix-display)
    fix_icon_display "$2"
    ;;
  *)
    usage
    ;;
esac
