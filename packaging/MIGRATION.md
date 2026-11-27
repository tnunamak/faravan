# Before the first preview launch

Stop all versions of Faravan before migration, including trays, apps, background services and CLI commands. Back up both profiles named by the launcher before proceeding. Keep the source backup until you have checked your circles, device identity and job history in the preview.

Older binaries do not take the profile writer gate. The launcher cannot prove that those processes have stopped. Close their terminals and stop their services as well as their app windows; do not run either version against the source while migration is in progress.

## If migration refuses startup

Leave the source, destination, staging directories and transaction records in place. The diagnostic names these paths. An unproven destination requires explicit reconciliation; do not replace it with the source or edit its completion marker to bypass the check.

An unknown-owner diagnostic names the exact lock entry. A busy lock can belong to a running process; a missing or unreadable identity is not proof that its owner is gone. Retrying never takes over an unknown owner automatically.

1. Stop every version and all of its app, tray, service and CLI processes. If the profile is shared with another login, container or machine, stop its writers too. If you cannot establish this, leave the lock intact and ask for help.
2. Back up both profiles, the named lock entries and the sibling transaction records. Preserve their contents and permissions for diagnosis.
3. Have an operator verify the owner and reconcile the profiles. Only after independently establishing that no process can use the lock may the operator move the exact stale entry aside to a retained backup. Do not clear whole lock directories or remove entries merely because they are old, malformed or have an unfamiliar PID.
4. Retry the same launcher. If it still refuses, retain the new diagnostic and the backups for support. Do not force fresh initialization or manually mark migration complete.

This procedure does not certify storage after a power loss. Directory sync errors must be resolved before retrying migration.

For the default label `20261026`, the launcher copies only `~/.faravan-preview-20261026/state` into `$XDG_DATA_HOME/Faravan Preview 20261026` when `XDG_DATA_HOME` is absolute, otherwise into `~/.local/share/Faravan Preview 20261026`. It retains the source; other dated labels and ordinary Faravan data are not picked up. Back up the actual source and destination. If the package was built with a custom preview root, its source is `$root/state` instead.

The preview state root's parent must already exist. If `XDG_DATA_HOME` is absolute, that directory must also already exist. The launcher creates the default `.local/share` directories from your established home; it does not treat a missing configured root as established.
