/**
 * The remote desktop's accessibility tree (AT-SPI), read over SSH: every
 * visible button, field, menu item and label, with its name, state and place
 * on screen — what a screenshot shows, as text, for a fraction of the tokens,
 * and with exact coordinates instead of ones read off an image.
 *
 * It speaks AT-SPI's D-Bus protocol through Gio, which comes with python3-gi
 * on any GTK desktop, rather than through libatspi's Python bindings, which
 * are a separate package servers often lack. It runs as the desktop's owner,
 * on that session's bus, found in the environment of one of its processes.
 */

export interface A11yElement {
	role: string;
	name: string;
	/** An editable field's or terminal's contents; masked for passwords. */
	text?: string;
	states: string[];
	x: number;
	y: number;
	width: number;
	height: number;
	app: string;
	window: string;
	/** In the active window. */
	active: boolean;
}

export interface A11ySnapshot {
	elements: A11yElement[];
	/** Elements left out by the limit. */
	omitted: number;
}

/**
 * Finds the display's owner and their session bus, then runs `python3 -` as
 * them with the script on stdin. `display` is the X display number, or null
 * to pick one the way the x11vnc launch does. Errors come back as JSON too.
 */
export function accessibilityWrapper(display: string | null): string {
	return [
		`d=${display && /^:?\d+$/.test(display) ? display.replace(/^:/, "") : ""}`,
		'if [ -z "$d" ]; then',
		"  me=$(id -u); best=9",
		"  for s in /tmp/.X11-unix/X*; do",
		'    [ -S "$s" ] || continue',
		"    owner=$(ls -ln \"$s\" | awk '{print $3}')",
		'    if [ "$owner" = "$me" ] && [ "$me" != 0 ]; then rank=0; elif [ "$owner" != 0 ]; then rank=1; else rank=2; fi',
		'    if [ "$rank" -lt "$best" ]; then best=$rank; d="${s##*/X}"; fi',
		"  done",
		"fi",
		"uid=$(ls -ln \"/tmp/.X11-unix/X$d\" 2>/dev/null | awk '{print $3}')",
		"[ -n \"$uid\" ] || { echo '{\"error\":\"no-display\"}'; exit 0; }",
		"command -v python3 >/dev/null 2>&1 || { echo '{\"error\":\"no-python\"}'; exit 0; }",
		"bus=",
		// Only the owner's processes can hold that session's bus; pgrep lists them in one go.
		'pids=$(pgrep -u "$uid" 2>/dev/null) || pids=$(ls /proc | grep -E "^[0-9]+$")',
		"for n in $pids; do",
		'  p=/proc/$n',
		"  [ \"$(ls -ldn \"$p\" 2>/dev/null | awk '{print $3}')\" = \"$uid\" ] || continue",
		'  env=$(tr "\\000" "\\n" < "$p/environ" 2>/dev/null) || continue',
		'  printf "%s\\n" "$env" | grep -qE "^DISPLAY=:$d([.]0)?$" || continue',
		'  b=$(printf "%s\\n" "$env" | sed -n "s/^DBUS_SESSION_BUS_ADDRESS=//p")',
		'  if [ -n "$b" ]; then bus=$b; break; fi',
		"done",
		"[ -n \"$bus\" ] || { echo '{\"error\":\"no-session-bus\"}'; exit 0; }",
		'if [ "$(id -u)" = "$uid" ]; then exec env DISPLAY=":$d" DBUS_SESSION_BUS_ADDRESS="$bus" python3 -; fi',
		'exec runuser -u "$(id -nu "$uid")" -- env DISPLAY=":$d" DBUS_SESSION_BUS_ADDRESS="$bus" python3 -',
	].join("\n");
}

/** The Python side: walks the showing windows and prints one JSON object. */
export function accessibilityScript(options: { limit: number; query: string; width: number; height: number }): string {
	return `OPTS = ${JSON.stringify(JSON.stringify(options))}
${SCRIPT_BODY}`;
}

const SCRIPT_BODY = String.raw`import json, sys, time
try:
    from gi.repository import Gio, GLib
except Exception as e:
    print(json.dumps({"error": "no-gi", "detail": str(e)}))
    sys.exit(0)
OPTS = json.loads(OPTS)
FLAGS = Gio.DBusCallFlags.NONE
try:
    session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    addr = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None, GLib.VariantType("(s)"), FLAGS, 3000, None).unpack()[0]
    bus = Gio.DBusConnection.new_for_address_sync(addr, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
except Exception as e:
    print(json.dumps({"error": "no-a11y-bus", "detail": str(e)}))
    sys.exit(0)
ACC = "org.a11y.atspi.Accessible"
STATE_NAMES = {1: "active", 4: "checked", 7: "editable", 10: "expanded", 12: "focused", 20: "pressed", 23: "selected"}
SHOWING, VISIBLE, SENSITIVE, ENABLED, FOCUSED, ACTIVE = 25, 30, 24, 8, 12, 1
TEXT_ROLES = {"text", "entry", "password text", "terminal", "spin button", "editbar", "paragraph"}
SKIP_ROLES = {"filler", "redundant object", "separator", "scroll bar", "viewport", "scroll pane"}

def call(n, p, iface, method, args=None, sig=None):
    return bus.call_sync(n, p, iface, method, args, GLib.VariantType(sig) if sig else None, FLAGS, 1000, None).unpack()

def prop(n, p, iface, key):
    return call(n, p, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (iface, key)), "(v)")[0]

def states(n, p):
    words = call(n, p, ACC, "GetState", None, "(au)")[0]
    return {i for i in range(64) if i // 32 < len(words) and (words[i // 32] >> (i % 32)) & 1}

def text_of(n, p, role):
    try:
        if "org.a11y.atspi.Text" not in call(n, p, ACC, "GetInterfaces", None, "(as)")[0]:
            return None
        count = prop(n, p, "org.a11y.atspi.Text", "CharacterCount")
        if role == "password text":
            return "•" * min(count, 32)
        # A terminal's scrollback is long; its end is what was just printed.
        start = max(0, count - (2000 if role == "terminal" else 300))
        return call(n, p, "org.a11y.atspi.Text", "GetText", GLib.Variant("(ii)", (start, count)), "(s)")[0]
    except Exception:
        return None

deadline = time.time() + 8
query = OPTS["query"].lower()
found = []
visited = 0
try:
    apps = call("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root", ACC, "GetChildren", None, "(a(so))")[0]
except Exception as e:
    print(json.dumps({"error": "no-registry", "detail": str(e)}))
    sys.exit(0)
windows = []
for (an, ap) in apps:
    try:
        app = prop(an, ap, ACC, "Name")
        for (wn, wp) in call(an, ap, ACC, "GetChildren", None, "(a(so))")[0]:
            ws = states(wn, wp)
            if SHOWING in ws:
                windows.append((ACTIVE in ws, app, prop(wn, wp, ACC, "Name"), wn, wp, ws))
    except Exception:
        continue
windows.sort(key=lambda w: not w[0])
for (active, app, title, wn, wp, ws) in windows:
    stack = [(wn, wp, ws)]
    while stack and visited < 4000 and time.time() < deadline:
        n, p, st = stack.pop()
        visited += 1
        try:
            if st is None:
                st = states(n, p)
            if SHOWING not in st:
                continue
            kids = call(n, p, ACC, "GetChildren", None, "(a(so))")[0]
            stack.extend((kn, kp, None) for (kn, kp) in reversed(kids))
            role = call(n, p, ACC, "GetRoleName", None, "(s)")[0]
            if role in SKIP_ROLES:
                continue
            name = prop(n, p, ACC, "Name") or ""
            text = text_of(n, p, role) if role in TEXT_ROLES else None
            if not (name.strip() or text or FOCUSED in st):
                continue
            if query and query not in (name + " " + (text or "") + " " + role).lower():
                continue
            x, y, w, h = call(n, p, "org.a11y.atspi.Component", "GetExtents", GLib.Variant("(u)", (0,)), "((iiii))")[0]
            if w <= 0 or h <= 0 or x + w <= 0 or y + h <= 0:
                continue
            flags = [STATE_NAMES[s] for s in sorted(st) if s in STATE_NAMES and s != ACTIVE]
            if SENSITIVE not in st and ENABLED not in st:
                flags.append("disabled")
            item = {"role": role, "name": name.strip()[:200], "states": flags, "x": x, "y": y, "width": w, "height": h, "app": app, "window": title, "active": active}
            if text:
                item["text"] = text
            found.append(item)
        except Exception:
            continue
limit = OPTS["limit"]
print(json.dumps({"elements": found[:limit], "omitted": max(0, len(found) - limit)}, ensure_ascii=False))
`;

/** The script's JSON, or an error whose message says what to do about it. */
export function parseAccessibility(output: string): A11ySnapshot {
	const line = output.split("\n").map((entry) => entry.trim()).reverse().find((entry) => entry.startsWith("{"));
	let parsed: { error?: string; detail?: string; elements?: A11yElement[]; omitted?: number };
	try {
		parsed = JSON.parse(line ?? "");
	} catch {
		throw new Error(`Reading the accessibility tree failed:\n${output.trim().slice(-1500) || "(no output)"}`);
	}
	switch (parsed.error) {
		case undefined:
			return { elements: parsed.elements ?? [], omitted: parsed.omitted ?? 0 };
		case "no-python":
		case "no-gi":
			return fail("python3 with PyGObject (python3-gi) is needed on the server to read the accessibility tree; use screenshots, or install it (`sudo apt install python3-gi`).");
		case "no-session-bus":
			return fail("The desktop's D-Bus session was not found, so its accessibility tree cannot be read; use screenshots.");
		case "no-a11y-bus":
		case "no-registry":
			return fail(`The desktop has no accessibility bus running (${parsed.detail ?? ""}); use screenshots.`);
		case "no-display":
			return fail("No X display was found on the server.");
		default:
			return fail(`Reading the accessibility tree failed: ${parsed.error} ${parsed.detail ?? ""}`);
	}
}

function fail(message: string): never {
	throw new Error(message);
}
