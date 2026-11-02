import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, lstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { canonical, validateUuid } from '../vendor/broker/src/protocol.mjs';
import { openNativeInbox } from './native-inbox.mjs';

/** Retain the ORIGINAL Inbox owner.sqlite lock throughout every incarnation.
 * Old workers therefore cannot reopen the old root while a v2 child is active.
 * Only a proven self-session404 permits replacement; native pending work stays
 * in its original journal. Pointer uncertainty is terminal for this owner.
 */
export function openNativeIncarnation({reference, settings, binding}) {
  if(settings.broker.registrationVersion!==2 || typeof reference.BrokerClient?.prototype?.createReplacementInbox !== 'function') throw new Error('native_incarnation_required');
  const root=openNativeInbox({reference,settings,binding,incarnationOwner:true});
  const closeRoot=root.close.bind(root);root.close=()=>{};
  const closers=new WeakMap([[root,closeRoot]]);
  const retain=inbox=>{closers.set(inbox,inbox.close.bind(inbox));inbox.close=()=>{};return inbox;};
  let current=root, stopped=false, uncertain=false, replacing=false;
  const path=join(root.directory,'current-incarnation.json');
  try {
    let pointer;
    try { const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try { const s=fstatSync(fd);if(!s.isFile()||s.mode&0o077||s.size>8192||process.getuid&&s.uid!==process.getuid())throw new Error('native_incarnation_invalid');pointer=JSON.parse(readFileSync(fd,'utf8')); }finally{closeSync(fd);}
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    if(pointer) {
      if(pointer.version!==1||Object.keys(pointer).sort().join(',')!=='generation,identity,version'||Object.keys(pointer.identity??{}).sort().join(',')!=='client_id,client_type,session_instance_id'||pointer.identity.client_type!=='opencode')throw new Error('native_incarnation_invalid');
      validateUuid(pointer.generation);validateUuid(pointer.identity.client_id);validateUuid(pointer.identity.session_instance_id);
      const directory=join(root.directory,'incarnation-'+pointer.generation);
      const dir=lstatSync(directory), db=lstatSync(join(directory,'inbox.sqlite'));
      if(!dir.isDirectory()||dir.isSymbolicLink()||!db.isFile()||db.isSymbolicLink())throw new Error('native_incarnation_invalid');
      current=retain(new reference.Inbox({directory,identity:pointer.identity}));
    }
  }catch(error){closeRoot();throw error;}
  return {
    get inbox(){if(stopped||uncertain)throw new Error('native_incarnation_unavailable');return current;},
    async replace({client,verifySession,signal}) {
      if(stopped||uncertain||replacing||client.inbox!==current||client.registrationVersion!==2||!client.expiredIdentityConfirmed)throw new Error('native_incarnation_unavailable');
      replacing=true;
      try {
      const generation=randomUUID();
      let next;
      try { next=await client.createReplacementInbox({directory:join(root.directory,'incarnation-'+generation),verifySession,signal}); }
      catch(error) {
        // Native mismatch is rejected before mkdir by the reviewed helper. Other
        // failures may leave a partial directory; require deliberate recovery.
        if(error.code==='session_mismatch')throw error;
        uncertain=true;throw Object.assign(new Error('native_incarnation_uncertain',{cause:error}),{code:'native_incarnation_uncertain'});
      }
      try {
        if(stopped||signal?.aborted||await verifySession(client.identity)!==true)throw new Error('native_session_mismatch');
        uncertain=true;
        const child=openSync(next.directory,constants.O_RDONLY);try{fsyncSync(child);}finally{closeSync(child);}
        const temporary=join(root.directory,`current-incarnation-${randomUUID()}.tmp`);
        // From the first pointer write onward, uncertainty forbids all further
        // allocations/registration in this owner. Reopen reads the durable pointer.
        const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{writeFileSync(fd,canonical({version:1,generation,identity:next.identity})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
        renameSync(temporary,path);
        const parent=openSync(root.directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
        const previous=current;current=retain(next);uncertain=false;if(previous!==root)closers.get(previous)();
        return next;
      }catch(error){next.close();if(uncertain)throw Object.assign(new Error('native_incarnation_uncertain',{cause:error}),{code:'native_incarnation_uncertain'});throw error;}
      }finally{replacing=false;}
    },
    close(){if(stopped)return;stopped=true;try{if(current!==root)closers.get(current)();}finally{closeRoot();}}
  };
}
