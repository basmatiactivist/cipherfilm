#!/bin/sh
# After a Play build (CF_STORE=play): the merged release manifest, as it goes into the bundle, must not hold what
# Google Play's policies reject for this app (docs/play/REQUIREMENTS.md §4.4) and must keep what it needs.
#   mobile/scripts/check-play-manifest.sh mobile/android/app
set -eu
app="${1:?usage: $0 ANDROID_APP_DIR}"
m=$(find "$app/build/intermediates" -name AndroidManifest.xml -path '*merged_manifest*' -path '*elease*' | head -1)
[ -n "$m" ] || { echo "no merged release manifest under $app/build/intermediates" >&2; exit 1; }
# one line, single spaces: the merger writes each attribute on a line of its own
flat=$(tr -s ' \n\t\r' '    ' < "$m" | awk '{ gsub(/</, "\n<"); print }')
bad=0
for p in REQUEST_IGNORE_BATTERY_OPTIMIZATIONS WRITE_EXTERNAL_STORAGE MANAGE_EXTERNAL_STORAGE SYSTEM_ALERT_WINDOW com.google.android.gms.permission.AD_ID; do
  if printf '%s\n' "$flat" | grep '^<uses-permission' | grep -qE "android:name=\"([A-Za-z.]*\.)?$p\""; then echo "the Play build must not declare $p" >&2; bad=1; fi
done
printf '%s\n' "$flat" | grep '^<uses-permission' | grep 'READ_EXTERNAL_STORAGE"' | grep -q 'android:maxSdkVersion="32"' \
  || { echo "READ_EXTERNAL_STORAGE must be declared with maxSdkVersion 32" >&2; bad=1; }
printf '%s\n' "$flat" | grep 'TransferService"' | grep -q 'android:foregroundServiceType="dataSync"' || { echo "TransferService must be a dataSync foreground service" >&2; bad=1; }
[ $bad -eq 0 ] && echo "Play manifest: OK ($m)"
exit $bad
