import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const python = Bun.which("python3") ?? Bun.which("python");
test.skipIf(!python)("server refuses weakened isolation, unexpected mounts and published ports", () => {
	const script = `
import sys,types,copy,ipaddress
sys.modules.setdefault('fcntl',types.SimpleNamespace(LOCK_EX=2,flock=lambda *a:None))
sys.path.insert(0,${JSON.stringify(resolve("server/sandbox"))})
import control,network
name='nekocode-'+'a'*24
c={'Config':{'Labels':{control.LABEL:'1',control.LABEL+'.owner':name}},'Mounts':[{'Type':'tmpfs','Destination':p} for p in control.TMPFS]+[{'Type':'bind','Source':control.DNS_FILE,'Destination':'/etc/resolv.conf','RW':False}],
 'HostConfig':{'Runtime':control.RUNTIME,'Privileged':False,'Binds':[control.DNS_BIND],'ReadonlyRootfs':True,'Tmpfs':control.TMPFS,
 'NetworkMode':network.NETWORK,'Memory':control.MEMORY,'MemorySwap':control.MEMORY,'NanoCpus':1000000000,'PidsLimit':512,
 'SecurityOpt':['no-new-privileges'],'PortBindings':{'22/tcp':[{'HostIp':'127.0.0.1','HostPort':''}]}}}
control.validate(c,name)
changes=[('Runtime','runc'),('Privileged',True),('Binds',['/:/host']),('ReadonlyRootfs',False),('Tmpfs',{}),('NetworkMode','host'),('Memory',0),('MemorySwap',-1),('NanoCpus',0),('PidsLimit',0),('SecurityOpt',[]),('PortBindings',{'22/tcp':[{'HostIp':'0.0.0.0','HostPort':'2222'}]})]
for key,value in changes:
 candidate=copy.deepcopy(c);candidate['HostConfig'][key]=value
 try:control.validate(candidate,name)
 except RuntimeError:pass
 else:raise AssertionError('Accepted unsafe '+key)
candidate=copy.deepcopy(c);candidate['Mounts'].append({'Type':'bind','Destination':'/host'})
try:control.validate(candidate,name)
except RuntimeError:pass
else:raise AssertionError('Accepted host mount')
candidate=copy.deepcopy(c);candidate['Mounts'][-1]['RW']=True
try:control.validate(candidate,name)
except RuntimeError:pass
else:raise AssertionError('Accepted writable host configuration')
for address in ['10.1.2.3','172.20.0.1','192.168.1.1','169.254.169.254','100.100.100.200','127.0.0.1']:
 assert any(ipaddress.ip_address(address) in ipaddress.ip_network(cidr) for cidr in network.BLOCKED),address
assert not any(ipaddress.ip_address('1.1.1.1') in ipaddress.ip_network(cidr) for cidr in network.BLOCKED)
print('isolation policy passed')
`;
	const result = spawnSync(python!, ["-"], { input: script, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout).toContain("isolation policy passed");
});
