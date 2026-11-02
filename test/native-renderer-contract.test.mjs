import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = name => readFileSync(new URL('./renderer-fixture/'+name,import.meta.url),'utf8');
const notice=read('session-notice.tsx'),row=read('inline-tool-row.tsx');
test('pinned official renderer selects synthetic description as literal generic notice text',()=>{
  for(const [name,sha] of Object.entries({
    'session-notice.tsx':'d93e768c835b12e8d4de9964f05c4f6895103d1f56caf2df6ffd42e474f9babb',
    'inline-tool-row.tsx':'f2a4c0385b7bb3513e89f8be444d4faf925e6a499821dafc6c0992bd88e51cee',
    'LICENSE':'625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b',
  })) assert.equal(createHash('sha256').update(read(name)).digest('hex'),sha);
  // Execute unchanged source selectors, not an invented renderer. Hook/JSX
  // mounting remains outside this cheap contract test and requires a real TUI.
  const start=notice.indexOf('  const metadata = '),end=notice.indexOf('  const status = ');
  assert.ok(start>0&&end>start);
  const select=new Function('props','stringValue',notice.slice(start,end)+'\nreturn {text:text(),description:description(),source:source(),completion:completion()}');
  const stringValue=value=>typeof value==='string'?value:undefined;
  for(const description of ['Psst agent message','Psst · new message · From: Revisor · pi · **literal** <tag> \\u001b']){
    assert.deepEqual(select({message:{type:'synthetic',text:'full model context, not the notice',description,metadata:{source:'psst'}}},stringValue),
      {text:description,description,source:'psst',completion:false});
  }
  assert.match(notice,/when=\{completion\(\)\}[\s\S]*fallback=\{\s*<InlineToolRow[^>]*complete=\{true\}>\s*\{text\(\)\}/);
  assert.match(row,/<text\s+flexGrow=\{1\}[\s\S]*?\{props\.failed && !props\.complete \? \(props\.failure \?\? props\.children\) : props\.children\}\s*<\/text>/);
});
