# Linux application identity

The first onboarding page and Settings → General offer **Linux application user**
on Linux desktops. The default is the desktop user. Selecting root and applying
opens the desktop's polkit authorization dialog through `/usr/bin/pkexec`.
Being in a sudo group does not change the UID of an already running application.

Switching is supported in packaged builds with polkit, a desktop authentication
agent, and an X11 display (including XWayland). Pure Wayland sessions without
`DISPLAY` cannot use this option. No password is collected or saved by NekoCode.

Root runs the entire application and its tools with UID 0 and `--no-sandbox`.
The launcher passes only the display and Xauthority information; it does not
forward the ordinary user's HOME, application profile or provider credentials.
Root therefore uses its own settings, history and agent home, and needs its own
initial configuration. The root session uses Electron's basic password store;
features that require a system keyring may be unavailable. Project files created
by root can be owned by root.

The ordinary user process remains in the background, with its tray icon hidden,
to preserve its session and manage the saved launch preference. Existing tasks
in that process retain their original identity. The preference is saved only
after the root window loads. Subsequent launches request system authorization
again, subject to polkit policy. Cancellation or startup failure retains the
ordinary user session. Opening the app again focuses the root instance.

To return, select **Current desktop user** in the root instance's settings and
apply. The root instance quits, the saved preference resets, and the original
window and tray are restored. A root instance launched outside this flow must be
quit and reopened from the ordinary desktop user. Quitting root normally also
quits the background supervisor; a root crash restores the ordinary user window.

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
4. Confirm root has separate onboarding and configuration. Check that ordinary
   user configuration files retain their owner and permissions.
5. Launch the app from its desktop entry again; confirm it focuses root.
6. Return to the current desktop user through settings; confirm the original
   conversation, window and tray return, with `id -u` reporting the user's UID.
7. Repeat using both the deb package and an AppImage with spaces in its path;
   exercise an X11 desktop and a Wayland desktop with XWayland.
8. Verify missing pkexec, missing DISPLAY, denied authorization, and startup
   failure leave the ordinary user session usable. Quit root normally, relaunch
   from the desktop and check that authorization is requested for the saved mode.
