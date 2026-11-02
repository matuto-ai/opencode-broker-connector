import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeDescription, PREVIEW_TEXT_LIMIT, PREVIEW_SENDER_LIMIT } from '../src/message-preview.mjs';

function envelope(text = 'Olá, terminei a revisão.') {
  return {protocol_version:'1',message_id:randomUUID(),recipient_id:randomUUID(),recipient_sequence:1,
    sender:{client_id:'12345678-1234-4234-8234-123456789abc',client_type:'pi',name:'Revisor',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},
    origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text},
    accepted_at:'2026-11-01T12:00:00.000Z',expires_at:'2026-11-02T12:00:00.000Z',correlation_id:null,reply_to_message_id:null};
}
const body = value => nativeDescription(envelope(value)).split(' · ').at(-1);
test('native notice labels another agent and previews literal text without changing the envelope',()=>{
  const e=envelope(),original=structuredClone(e);
  assert.equal(nativeDescription(e),'Psst · outro agente Revisor/12345678 · Olá, terminei a revisão.');
  assert.deepEqual(e,original);assert.equal(nativeDescription(e),nativeDescription(e));
  assert.equal(body('**literal** <tag> {"key":1}'), '**literal** <tag> {"key":1}');
});
test('native preview escapes ANSI CSI/OSC, C0/C1, line and direction controls',()=>{
  const value='\x1b[31mred\x1b[0m\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07';
  const shown=body(value);
  assert.equal(shown,'\\u001b[31mred\\u001b[0m\\u001b]8;;https://example.invalid\\u0007link\\u001b]8;;\\u0007');
  for(const char of ['\x00','\n','\r','\t','\x7f','\x85','\x9b','\u2028','\u2029','\u061c','\u200e','\u200f','\u202a','\u202b','\u202c','\u202d','\u202e','\u2066','\u2067','\u2068','\u2069','\u200b','\u2060','\ufeff']) {
    assert.equal(body('a'+char+'b'),'a\\u'+char.codePointAt(0).toString(16).padStart(4,'0')+'b');
  }
  const e=envelope('body');e.sender.name='peer\u202e\u061c';
  assert.equal(nativeDescription(e),'Psst · outro agente peer\\u202e\\u061c/12345678 · body');
  assert.equal(body('\\u001b'),'\\\\u001b','literal backslash is distinguishable from escaped control');
});
test('preview caps codepoints and UTF-8 bytes without broken Unicode or partial escape tokens',()=>{
  assert.equal(body('a'.repeat(PREVIEW_TEXT_LIMIT)),'a'.repeat(PREVIEW_TEXT_LIMIT));
  assert.equal(body('a'.repeat(PREVIEW_TEXT_LIMIT+1)),'a'.repeat(PREVIEW_TEXT_LIMIT-1)+'…');
  assert.equal(body('a'.repeat(PREVIEW_TEXT_LIMIT-3)+'\x1b'),'a'.repeat(PREVIEW_TEXT_LIMIT-3)+'…');
  assert.equal(body('a'.repeat(PREVIEW_TEXT_LIMIT-6)+'\x1bZ'),'a'.repeat(PREVIEW_TEXT_LIMIT-6)+'…');
  assert.equal(body('a'.repeat(PREVIEW_TEXT_LIMIT-6)+'\x1b'),'a'.repeat(PREVIEW_TEXT_LIMIT-6)+'\\u001b');
  const e=envelope('😀'.repeat(1000));e.sender.name='😀'.repeat(50);
  const shown=nativeDescription(e);
  assert.ok(shown.isWellFormed());assert.ok([...shown].length<240);assert.ok(Buffer.byteLength(shown)<900);
  assert.ok(shown.includes('😀'.repeat(PREVIEW_SENDER_LIMIT-1)+'…/12345678'));
  assert.ok(shown.endsWith('😀'.repeat(PREVIEW_TEXT_LIMIT-1)+'…'));
  assert.equal(body('👩‍💻 café'),'👩‍💻 café','ordinary Unicode and joiners are not rewritten');
});
test('preview does not broaden envelope identity, origin or content validation',()=>{
  const e=envelope();assert.throws(()=>nativeDescription({...e,origin:'human'}));
  assert.throws(()=>nativeDescription({...e,authority:'human_approval'}));
  assert.throws(()=>nativeDescription({...e,sender:{...e.sender,client_id:'SYSTEM'}}));
  assert.throws(()=>nativeDescription({...e,content:{type:'application/json',text:'{}'}}));
});
