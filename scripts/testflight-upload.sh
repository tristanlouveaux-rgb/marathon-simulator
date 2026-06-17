#!/usr/bin/env bash
# Mosaic — archive + upload to TestFlight headlessly via App Store Connect API key.
# Usage: bash scripts/testflight-upload.sh
# Prereq: AuthKey_FTHM6NV597.p8 in ~/.appstoreconnect/private_keys/
# Build number auto-managed by exportOptions.plist (manageAppVersionAndBuildNumber).
set -euo pipefail

KEY_ID="FTHM6NV597"
ISSUER_ID="76e7944b-66d1-4715-b32d-42e96539c6a9"
KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
PROJ="ios/App/App.xcodeproj"
ARCHIVE="build/App.xcarchive"

echo "==> Building web bundle"
npx tsc && npx vite build
echo "==> cap sync ios"
npx cap sync ios

echo "==> Archiving"
rm -rf "$ARCHIVE"
xcodebuild -project "$PROJ" -scheme App -configuration Release \
  -archivePath "$ARCHIVE" -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates archive

echo "==> Uploading to App Store Connect"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist ios/exportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID"

echo "==> Done. Build is processing on App Store Connect (~5-15 min)."
