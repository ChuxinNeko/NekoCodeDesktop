/** Runs only against the X display associated with the active VNC connection. */
export function resolutionScript(display: string, size?: { width: number; height: number }): string {
	return `import os, glob, re, json, subprocess, shutil
OPTS = json.loads(${JSON.stringify(JSON.stringify({ display, size: size ?? null }))})
def main():
 env = dict(os.environ, DISPLAY=OPTS['display'], LC_ALL='C')
 for path in glob.glob('/proc/[0-9]*/cmdline'):
  try:
   args = open(path, 'rb').read().decode().split(chr(0))
   if os.path.basename(args[0]) not in ['Xorg','X','Xvnc','Xtigervnc','Xvfb'] or OPTS['display'] not in args: continue
   if '-auth' in args:
    auth = args[args.index('-auth') + 1]
    if not os.path.isabs(auth): auth = os.path.join(os.readlink(os.path.dirname(path) + '/cwd'), auth)
    env['XAUTHORITY'] = auth
   break
  except (OSError, ValueError, IndexError): continue
 def run(args):
  r = subprocess.run(args, env=env, capture_output=True, text=True, timeout=8)
  if r.returncode: raise RuntimeError((r.stderr or r.stdout or 'Display rejected the resolution').strip()[:1000])
  return r.stdout
 def query():
  text = run(['xrandr','--current'])
  current = re.search(r'current (\\d+) x (\\d+)', text)
  if not current: raise RuntimeError('Could not read the current display resolution')
  active = []; modes = []; output = None
  for line in text.splitlines():
   if line and not line[0].isspace():
    found = re.match(r'^(\\S+) connected (?:primary )?\\d+x\\d+[+-]\\d+[+-]\\d+', line)
    output = found.group(1) if found else None
    if output: active.append(output)
   elif output:
    found = re.match(r'\\s+(?:NEKO_)?(\\d+)x(\\d+)(?:_\\S+)?\\s', line)
    if found:
     mode = {'width':int(found.group(1)), 'height':int(found.group(2)), 'name':line.split()[0]}
     if mode not in modes: modes.append(mode)
  return int(current.group(1)), int(current.group(2)), active, modes
 w,h,active,modes = query()
 blocked = 'rdp' if any(o.startswith('rdp') for o in active) else 'multiple-monitors' if len(active) != 1 else None
 size = OPTS['size']
 if size and (size['width'],size['height']) != (w,h):
  if blocked: raise RuntimeError('Resize this desktop from the RDP client' if blocked == 'rdp' else 'Resolution changes require a single active monitor')
  target = str(size['width'])+'x'+str(size['height'])
  found = next((m for m in modes if m['width']==size['width'] and m['height']==size['height']), None)
  name = found['name'] if found else 'NEKO_'+target
  original = next((m['name'] for m in modes if m['width']==w and m['height']==h), None)
  output = active[0]
  created = False; attached = False; attempted = False
  def cleanup(args):
   try: subprocess.run(args,env=env,capture_output=True,timeout=8)
   except Exception: pass
  try:
   if not found:
    if not shutil.which('cvt'): raise RuntimeError('Custom resolutions require cvt on the remote host; choose an existing mode instead')
    modeline = next((l for l in run(['cvt',str(size['width']),str(size['height']),'60']).splitlines() if l.startswith('Modeline ')), None)
    if not modeline: raise RuntimeError('Could not generate a display mode')
    import shlex
    timing = shlex.split(modeline)[2:]
    # cvt may round the requested width; never report a different size as success.
    if int(timing[1]) != size['width'] or int(timing[5]) != size['height']: raise RuntimeError('This custom width must be a multiple of 8')
    run(['xrandr','--newmode',name]+timing); created=True
    run(['xrandr','--addmode',output,name]); attached=True
   attempted=True
   run(['xrandr','--output',output,'--mode',name])
   w,h,active,modes = query()
   if (w,h) != (size['width'],size['height']): raise RuntimeError('The desktop did not switch to the requested resolution')
  except Exception:
   if attempted and original: cleanup(['xrandr','--output',output,'--mode',original])
   if created:
    # Only remove our unused mode; never delete an existing display mode.
    if attached: cleanup(['xrandr','--delmode',output,name])
    cleanup(['xrandr','--rmmode',name])
   raise
 return {'width':w,'height':h,'modes':[{'width':m['width'],'height':m['height']} for m in modes], 'blockedReason':blocked}
try: result=main()
except Exception as e: result={'error':str(e)}
print('NEKO_RESOLUTION='+json.dumps(result),flush=True)
`;
}
