#!/bin/sh
# Run by the prepared systemd unit on an approved backend host, never during builds.
set -eu
umask 077

: "${YIBO_BACKUP_ROOT:?Set the private staging directory}"
: "${YIBO_BACKUP_REGIONS:?List all regional databases on this host}"
: "${YIBO_RELEASE_SHA:?Set the exact deployed commit SHA}"
: "${RESTIC_REPOSITORY_FILE:?Set the private off-host repository file}"
: "${RESTIC_PASSWORD_FILE:?Set the private repository password file}"
case "$YIBO_BACKUP_ROOT" in /*) ;; *) exit 1 ;; esac
test -d "$YIBO_BACKUP_ROOT"
test -r "$RESTIC_REPOSITORY_FILE"
test -r "$RESTIC_PASSWORD_FILE"

# Require a remote backend; a local repository on the running host is not off-host backup.
repository=$(cat "$RESTIC_REPOSITORY_FILE")
case "$repository" in
  s3:https://*|sftp:*|b2:*|azure:*|gs:*|rest:https://*) ;;
  *) printf '%s\n' '{"event":"backup.failed","code":"REMOTE_REPOSITORY_REQUIRED"}' >&2; exit 1 ;;
esac
unset repository
# Use exactly the reviewed files even if an interactive shell supplied other restic defaults.
unset RESTIC_REPOSITORY RESTIC_PASSWORD RESTIC_PASSWORD_COMMAND

snapshot="$YIBO_BACKUP_ROOT/snapshot-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
node --import tsx src/cli/database-backup.ts create \
  --directory "$snapshot" --regions "$YIBO_BACKUP_REGIONS" --release "$YIBO_RELEASE_SHA"
node --import tsx src/cli/database-backup.ts verify --directory "$snapshot"

# Keep provider diagnostics private and outside the snapshot being uploaded.
# All nonzero restic exits (including incomplete backup) fail the service.
if restic --repository-file "$RESTIC_REPOSITORY_FILE" --password-file "$RESTIC_PASSWORD_FILE" \
  backup --tag yibo-regional -- "$snapshot" >"$snapshot-upload.log" 2>&1; then
  printf '%s\n' '{"event":"backup.upload.complete"}'
else
  printf '%s\n' '{"event":"backup.failed","code":"OFF_HOST_UPLOAD_FAILED"}' >&2
  exit 1
fi
# Retain snapshots/logs on success and failure. No automatic deletion or repository pruning.
