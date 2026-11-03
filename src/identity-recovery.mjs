import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, lstatSync, openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { canonical, validateUuid } from '../vendor/broker/src/protocol.mjs';
import { privateDirectory } from './config.mjs';
import { nativeSessionBinding } from './native-delivery.mjs';

// Private persisted names remain compatible; the public plugin is only matuto.psst.
export function readNativeBindings(settings) {
  if (!settings) return [];
  try { lstatSync(settings.stateDirectory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  privateDirectory(settings.stateDirectory);
  const names=readdirSync(settings.stateDirectory).filter(name=>name.startsWith('opencode-v2-'));
  if(names.length>256)throw new Error('identity_recovery_scan_limit');
  const records=[];
  for(const name of names){
    if(!/^opencode-v2-[a-f0-9]{64}$/.test(name))throw new Error('identity_recovery_invalid');
    const directory=privateDirectory(join(settings.stateDirectory,name));
    const fd=openSync(join(directory,'binding.json'),constants.O_RDONLY|constants.O_NOFOLLOW);let record;
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.mode&0o077||stat.size>8192||process.getuid&&stat.uid!==process.getuid())throw new Error('identity_recovery_invalid');record=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
    if(record.version!==1||Object.keys(record).sort().join(',')!=='binding,broker,identity,version')throw new Error('identity_recovery_invalid');
    const b=record.binding;
    if(canonical(nativeSessionBinding({id:b?.sessionID,projectID:b?.projectID,location:b?.location,time:{created:b?.created}},b?.hostID))!==canonical(b))throw new Error('identity_recovery_invalid');
    if(Object.keys(record.identity??{}).sort().join(',')!=='client_id,client_type,session_instance_id'||record.identity.client_type!=='opencode')throw new Error('identity_recovery_invalid');
    validateUuid(record.identity.client_id);validateUuid(record.identity.session_instance_id);
    const hash=createHash('sha256').update(canonical({binding:b,broker:record.broker})).digest('hex');
    if(name!=='opencode-v2-'+hash)throw new Error('identity_recovery_invalid');
    if(record.broker===settings.broker.url)records.push(record);
  }
  return records;
}

export async function recoverHostAnchor({storage,session,settings,directory,workspaceID}) {
  const saved=await storage.get('psst-v2-host-id');
  const records=readNativeBindings(settings);
  // Shared approved installations may hold mailboxes belonging to other native
  // hosts. An existing anchor is not replaced based on unrelated manifests.
  if(saved!==undefined)return saved;
  async function freshAnchor(){
    let names=[];
    try{if(settings)names=readdirSync(settings.stateDirectory);}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const name of names.filter(n=>n.startsWith('opencode-')&&!n.startsWith('opencode-v2-'))){
      const path=join(settings.stateDirectory,name),stat=lstatSync(path);
      if(stat.isSymbolicLink())throw new Error('identity_recovery_invalid');
      if(!stat.isDirectory())continue;
      privateDirectory(path);
      // The old classic layout has no exact current native-session proof.
      // Keep it intact instead of allocating a replacement identity.
      throw new Error('identity_legacy_migration_required');
    }
    const id=randomUUID();await storage.set('psst-v2-host-id',id);return id;
  }
  const candidates=records.filter(r=>r.binding.location.directory===directory
    && r.binding.location.workspaceID===workspaceID);
  const anchors=new Set(),deadline=Date.now()+5000;
  let index=0,incomplete=false,unproven=false;
  await Promise.all(Array.from({length:Math.min(4,candidates.length)},async()=>{
    while(index<candidates.length){
      const record=candidates[index++],remaining=deadline-Date.now();
      if(remaining<=0){incomplete=true;return;}
      const signal=AbortSignal.timeout(Math.max(1,Math.min(2000,remaining)));let listener,info;
      try{
        info=await Promise.race([session.get({sessionID:record.binding.sessionID},{signal}),
          new Promise((_,reject)=>{listener=()=>reject(new Error('identity_recovery_timeout'));signal.addEventListener('abort',listener,{once:true});})]);
      }catch(error){
        // The official public API tags absent sessions. Other failures are not
        // evidence that a second anchor is unrelated; preserve and stop.
        if(error?._tag!=='SessionNotFoundError'||error.sessionID!==record.binding.sessionID){incomplete=true;return;}
        continue;
      }finally{if(listener)signal.removeEventListener('abort',listener);}
      // A successful lookup with a changed or unusable live binding is not
      // absence. It must not authorize a fresh anchor or partial recovery.
      if(!info||info.parentID||info.time?.archived){unproven=true;continue;}
      try{
        if(canonical(nativeSessionBinding(info,record.binding.hostID))===canonical(record.binding))anchors.add(record.binding.hostID);
        else unproven=true;
      }catch{unproven=true;}
    }
  }));
  if(incomplete)throw new Error('identity_recovery_incomplete');
  if(anchors.size>1)throw new Error('identity_recovery_ambiguous');
  if(unproven)throw new Error('identity_recovery_required');
  // No candidate, or every candidate positively absent in this native store:
  // allocate an independent host without adopting or changing old mailboxes.
  if(!anchors.size)return freshAnchor();
  const [hostID]=anchors;
  await storage.set('psst-v2-host-id',hostID);
  return hostID;
}

export function assertExistingBinding(settings,binding){
  const matches=readNativeBindings(settings).filter(r=>r.binding.sessionID===binding.sessionID);
  if(matches.length>1||matches.some(r=>canonical(r.binding)!==canonical(binding)))throw new Error('identity_recovery_conflict');
}
