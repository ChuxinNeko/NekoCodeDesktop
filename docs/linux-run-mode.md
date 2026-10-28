# Linux application identity

The first onboarding page and Settings → General offer **Linux application user**
on Linux desktops. The default is the desktop user. Selecting root and applying
opens the desktop's polkit authorization dialog through `/usr/bin/pkexec`.
Being in a sudo group does not change the UID of an already running application.

Switching is supported in packaged builds with polkit, a desktop authentication
agent, and an X11 display (including XWayland). Pure Wayland sessions without
`DISPLAY` cannot use this option. No password is collected or saved by NekoCode.
The system authorization dialog authenticates the administrator selected by
polkit (normally the desktop user's own password on Ubuntu).

After authorization, the original user's process uses `xhost` from
`x11-xserver-utils` to allow only `SI:localuser:root` on this display. This is
needed by graphics children that do not retain the main process's Xauthority
cookie. Access control remains enabled. The supervisor removes its own grant
on shutdown or recovery; a pre-existing root entry is left in place. The
supervisor hides only after root's application UI has rendered.

Root runs the entire application and its tools with UID 0 and `--no-sandbox`.
It retains the desktop user's HOME and the original application data paths, so
conversations, model profiles, agent/CLI configuration, credentials, themes and
other preferences remain available. Browser storage is private to the root
process to avoid two Chromium processes opening the same database. Onboarding,
appearance and the currently selected local or ACP conversation are transferred
before the new renderer loads; changes are periodically saved back to the
desktop user's browser storage and flushed before returning.

Encrypted credentials retain their original format. Root uses a private,
token-authenticated Unix socket to ask the original user's process to access
its keyring. Plaintext credentials are never exported to disk or command-line
arguments. Configuration files created by root have their ownership repaired
without following symlinks or hard links. Project files are outside that repair
scope and can still be owned by root.

The ordinary user process remains in the background to provide the keyring and
browser-storage bridge. Running agent tasks and automations must finish or be
stopped before switching. After authorization succeeds its agent processes,
terminals, watchers and background services stop before root opens the stores;
the two instances do not run concurrent writers. The preference is saved only
after the root window loads. Subsequent launches request system authorization
again, subject to polkit policy. Cancellation before handoff leaves the original
session running; a failure after handoff restarts it from the preserved profile.
Opening the app again focuses the root instance.

To return, select **Current desktop user** in the root instance's settings and
apply. The root instance saves its UI state and quits. The saved preference
resets and the desktop user app restarts from the updated profile, avoiding stale
in-memory stores overwriting changes made as root. A root instance launched outside this flow must be
quit and reopened from the ordinary desktop user. Quitting root normally also
quits the background supervisor; a root crash restarts the ordinary user app.

AppImage recovery and keyring fallback relaunch through a detached system shell
that waits for the original process to exit and passes every path and argument
as a quoted positional parameter. This avoids Electron's native relauncher's
`no_new_privs` flag, which prevents the FUSE mount helper from elevating. Paths
into the old AppImage mount are removed from the new process's environment.

## Linux acceptance checks

These require a packaged Linux build; Windows unit tests cannot validate desktop
authorization, X server access or actual file permissions.

1. Launch as an ordinary user such as `morax`; confirm the setting reports that
   user and defaults to the current desktop user.
2. Select root and apply, then cancel authorization. Confirm the original window
   stays available and the saved mode remains current.
3. Authorize root. Confirm only the root session remains visible, its terminal
   reports `id -u` as `0`, and it can list `/root`. Test writing only in a
   disposable directory, then remove the test files.
4. Confirm root skips onboarding, shows the same conversations, reopens the
   selected local/ACP conversation, and retains model/API and GitHub credentials.
   Change a harmless preference while root is running.
5. Launch the app from its desktop entry again; confirm it focuses root.
6. Return to the current desktop user through settings; confirm the conversation,
   changed preference and tray return, with `id -u` reporting the user's UID.
   Confirm configuration files remain writable by the desktop user and that
   executing a turn still works with the original model credentials.
7. Repeat using both the deb package and an AppImage with spaces in its path;
   exercise an X11 desktop and a Wayland desktop with XWayland.
8. Verify missing pkexec, missing DISPLAY, denied authorization, and startup
   failure leave the ordinary user session usable. Quit root normally, relaunch
   from the desktop and check that authorization is requested for the saved mode.
