import { createToolScope } from './tool-scope.mjs';
import { isAbsolute, normalize } from 'node:path';
import { nativeToolDescription } from './collaboration-guidance.mjs';

const TOOL_NAMES = ['broker_list_clients', 'broker_send', 'broker_update_metadata', 'broker_message_status', 'broker_receive', 'broker_sent_history', 'broker_message_content', 'broker_resend', 'broker_cancel'];
// Reviewed SDK adds two cooperative presence tools. Native OpenCode keeps its
// eight transport tools; the plugin owns broker_identity. Do not widen this catalog during SDK rollout.
export function nativeToolDefinitions(definitions) {
  const known=[...TOOL_NAMES,'broker_presence_events','broker_acknowledge_presence_event'];
  if(!Array.isArray(definitions)||definitions.length!==known.length||new Set(definitions.map(d=>d.name)).size!==known.length||definitions.some(d=>!known.includes(d.name)))throw new Error('Shared tool catalog changed; review it before enabling this adapter.');
  return definitions.filter(d=>TOOL_NAMES.includes(d.name)).map(d => ({ ...d, description: nativeToolDescription(d) }));
}
const localId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const absolute = value => typeof value === 'string' && isAbsolute(value) && normalize(value) === value;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Adapt the shared bounded tool catalog to OpenCode's documented Zod shape.
// This is a native tool schema adapter, not another broker wire contract.
function nativeSchema(z, rule) {
  const nullableString = Array.isArray(rule.type) && rule.type.length === 2
    && rule.type.includes('string') && rule.type.includes('null');
  const allowed = rule.enum ? ['enum'] : rule.type === 'object'
    ? ['type', 'properties', 'required', 'additionalProperties'] : rule.type === 'integer'
    ? ['type', 'minimum', 'maximum'] : rule.type === 'boolean' ? ['type'] : ['type', 'maxLength', 'format'];
  if (Object.keys(rule).some(key => !allowed.includes(key))
    || Array.isArray(rule.type) && !nullableString
    || rule.format !== undefined && rule.format !== 'uuid'
    || rule.maxLength !== undefined && (!Number.isSafeInteger(rule.maxLength) || rule.maxLength < 1)) {
    throw new Error('Unsupported shared tool schema; update this adapter before enabling it.');
  }
  let schema;
  if (rule.enum) schema = z.enum(rule.enum);
  else if (rule.type === 'object') schema = z.object(nativeShape(z, rule)).strict();
  else if (rule.type === 'boolean') schema = z.boolean();
  else if (rule.type === 'integer') {
    schema = z.number().int().safe();
    if (rule.minimum !== undefined) schema = schema.min(rule.minimum);
    if (rule.maximum !== undefined) schema = schema.max(rule.maximum);
  } else if (rule.type === 'string' || Array.isArray(rule.type) && rule.type.includes('string')) {
    schema = z.string().refine(value => value.isWellFormed()
      && (rule.maxLength === undefined || [...value].length <= rule.maxLength), 'Use bounded, well-formed text.');
    if (rule.format === 'uuid') schema = schema.refine(value => uuid.test(value), 'Use an exact UUID address.');
    if (Array.isArray(rule.type) && rule.type.includes('null')) schema = schema.nullable();
  } else throw new Error('Unsupported shared tool schema; update this adapter before enabling it.');
  return schema;
}
export function nativeShape(z, schema) {
  if (schema.type !== 'object' || schema.additionalProperties !== false || !schema.properties
    || !Array.isArray(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties, key))
    || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))) {
    throw new Error('Unsupported shared tool schema; update this adapter before enabling it.');
  }
  return Object.fromEntries(Object.entries(schema.properties).map(([key, rule]) => {
    const value = nativeSchema(z, rule);
    return [key, schema.required?.includes(key) ? value : value.optional()];
  }));
}
function displayJSON(value) {
  const result = JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
  if (Buffer.byteLength(result) > 512 * 1024) throw new Error('bounded_result');
  return result;
}

/**
 * Outgoing native tools for ONE verified OpenCode host-session lifetime.
 * The trusted host owner supplies currentBinding() and aborts binding.signal on
 * exact host close. Session IDs, a server process, and an idle observation alone
 * are insufficient lifetime proof. No automatic plugin attachment is implied.
 */
export function createOpenCodeAdapter({ reference, tool, binding, currentBinding,
  client, inbox = client?.inbox, observeMetadata = null, onDiagnostic = () => {}, onHealthChange = () => {}, operationContext = null, closeSessionOnStop = true }) {
  if (!reference || typeof reference.AdapterRuntime !== 'function' || typeof reference.createTools !== 'function'
    || typeof reference.invokeTool !== 'function' || typeof reference.safeError !== 'function'
    || typeof reference.LocalError !== 'function' || !Array.isArray(reference.TOOL_DEFINITIONS)
    || typeof tool !== 'function' || !tool.schema || !client || !inbox
    || !binding || !localId(binding.sessionID) || !absolute(binding.directory) || !absolute(binding.worktree)
    || typeof binding.lifetime !== 'symbol' || !(binding.signal instanceof AbortSignal)
    || typeof closeSessionOnStop !== 'boolean'
    || operationContext !== null && typeof operationContext !== 'function'
    || typeof currentBinding !== 'function' || observeMetadata !== null && typeof observeMetadata !== 'function'
    || inbox.identity?.client_type !== 'opencode' || client.inbox !== inbox) {
    throw new Error('Invalid adapter configuration: provide a verified exact host binding and shared broker reference objects.');
  }
  const definitions = nativeToolDefinitions(reference.TOOL_DEFINITIONS);
  if (definitions.length !== TOOL_NAMES.length || definitions.some(definition => !TOOL_NAMES.includes(definition.name))
    || new Set(definitions.map(definition => definition.name)).size !== TOOL_NAMES.length) {
    throw new Error('Shared tool catalog changed; review it before enabling this adapter.');
  }
  const catalog = definitions.filter(definition => definition.name !== 'broker_receive').map(definition => {
    const args = nativeShape(tool.schema, definition.inputSchema);
    return { definition, args, validator: tool.schema.object(args).strict() };
  });
  const expected = Object.freeze({ sessionID: binding.sessionID, directory: binding.directory,
    worktree: binding.worktree, lifetime: binding.lifetime, signal: binding.signal });
  const identity = Object.freeze({ ...inbox.identity });
  const toolScope = createToolScope({ closedError: () => new reference.LocalError('session_mismatch', { effect: 'unknown' }), abortedError: () => new reference.LocalError('request_aborted') });
  const recoveryAbort = new AbortController();
  let recoveryPromise, metadataTail = Promise.resolve();
  let started = false, closed = false, startPromise, runtimeStartPromise, stopPromise;
  const diagnostic = code => { try { onDiagnostic({ code }); } catch { /* No raw exception data. */ } };
  function sameIdentity(candidate) {
    return candidate?.client_id === identity.client_id && candidate?.session_instance_id === identity.session_instance_id
      && candidate?.client_type === identity.client_type;
  }
  async function alive() {
    if (closed || expected.signal.aborted || !sameIdentity(inbox.identity)) return false;
    let now;
    try { now = await currentBinding(); } catch { return false; }
    return !closed && !expected.signal.aborted && sameIdentity(inbox.identity) && now?.sessionID === expected.sessionID
      && now?.directory === expected.directory && now?.worktree === expected.worktree
      && now?.lifetime === expected.lifetime && now?.signal === expected.signal;
  }
  // The generic reference defaults a failed liveness check to terminal close.
  // Native navigation/unload is resumable, including that internal stop path.
  class NativeRuntime extends reference.AdapterRuntime {
    stop(options = { closeSession: closeSessionOnStop }) { return super.stop(options); }
    async checkAlive() {
      const wasClosed = this.closed, alive = await super.checkAlive();
      if (!alive && !wasClosed) diagnostic('native_binding_unavailable');
      return alive;
    }
  }
  const runtime = new NativeRuntime({ client, inbox,
    verifySession: async candidate => sameIdentity(candidate) && await alive(), isAlive: alive,
    onDiagnostic: entry => diagnostic(entry.code), onHealthChange });
  async function stop() {
    if (stopPromise) return stopPromise;
    closed = true; started = false; recoveryAbort.abort();
    const toolsClosed = toolScope.close();
    expected.signal.removeEventListener('abort', onClose);
    // Fence transport lifetime synchronously, before any deferred tool drain.
    const runtimeStopped = runtime.stop({ closeSession: false });
    stopPromise = Promise.resolve().then(async () => {
      try {
        await runtimeStopped; // Cancel, but do not close a stale pre-reconnect epoch.
        await runtimeStartPromise?.catch(() => {});
        // Registration may have committed after cancellation. Keep
        // its journal open until a second close fences that exact late lease.
        await runtime.stop({ closeSession: closeSessionOnStop });
      } finally { await toolsClosed; await recoveryPromise?.catch(() => {}); inbox.close(); }
    });
    return stopPromise;
  }
  const onClose = () => { void stop().catch(() => diagnostic('adapter_close_failed')); };
  expected.signal.addEventListener('abort', onClose, { once: true });
  if (expected.signal.aborted) onClose();

  async function assertBound(context, effect = 'not_applied') {
    if (!await alive()) {
      onClose();
      throw new reference.LocalError('session_mismatch', { effect });
    }
    if (context && (context.sessionID !== expected.sessionID || context.directory !== expected.directory
      || context.worktree !== expected.worktree || !localId(context.messageID) || !(context.abort instanceof AbortSignal))) {
      throw new reference.LocalError('session_mismatch', { effect });
    }
    if (context?.abort?.aborted) throw new reference.LocalError('request_aborted', { effect });
  }
  async function start(metadata) {
    if (startPromise || started || closed) throw new reference.LocalError('owner_conflict');
    startPromise = (async () => {
      await assertBound();
      try {
        runtimeStartPromise = runtime.start(metadata);
        const result = await runtimeStartPromise;
        await assertBound(undefined, 'unknown');
        // No durable tool-call ID exists in this pinned ToolContext. Reconcile
        // private operations after exact-session reattachment, never guess from text/messageID.
        recoveryPromise = client.recoverOutgoing?.({ limit: 10, signal: AbortSignal.any([recoveryAbort.signal, expected.signal, AbortSignal.timeout(5000)]) });
        await recoveryPromise?.catch(() => diagnostic('outgoing_recovery_incomplete'));
        await assertBound(undefined, 'unknown');
        started = true;
        return result;
      } catch (error) {
        await stop().catch(() => diagnostic('adapter_close_failed'));
        throw error;
      }
    })();
    return startPromise;
  }
  const tools = Object.fromEntries(catalog.map(({ definition, args, validator }) => {
    return [definition.name, tool({ description: definition.description, args,
      async execute(arguments_, context) {
        return toolScope.run(async operationSignal => {
        try {
          if (!started || !context) throw new reference.LocalError('session_mismatch');
          await assertBound(context);
          const transport = runtime.status();
          if (transport.recovery === 'blocked') throw new reference.LocalError(transport.error_code, { effect: 'unknown' });
          const parsed = validator.safeParse(arguments_);
          if (!parsed.success) throw new reference.LocalError('invalid_configuration', { field: 'arguments' });
          // Per-invocation closure, never a mutable global current tool context.
          const scopedClient = { inbox, get attachment() { return client.attachment; },
            prepareSend: (...args_) => client.prepareSend(...args_),
            prepareResend: (...args_) => client.prepareResend(...args_) };
          for (const method of ['listClients', 'sendPrepared', 'updateMetadata', 'messageStatus', 'refreshOwnedMetadata', 'resendPrepared', 'sentHistory', 'messageContent', 'cancelMessage']) {
            scopedClient[method] = async (...args_) => {
              await assertBound(context);
              return client[method](...args_);
            };
          }
          const facade = reference.createTools({ client: scopedClient, inbox, observeMetadata,
            cooperativeBoundary: async read => { await assertBound(context); return read(); } });
          const invoke = async () => { await assertBound(context); return reference.invokeTool(facade, definition.name, parsed.data, { ...(operationContext ? operationContext(context) : {}), signal: AbortSignal.any([operationSignal, expected.signal]) }); };
          // Observed metadata is CAS-versioned. Serialize only metadata-writing
          // tools within this exact session; distinct sessions remain independent.
          let result;
          if (observeMetadata && ['broker_send', 'broker_update_metadata'].includes(definition.name)) {
            const pending = metadataTail.then(invoke); metadataTail = pending.catch(() => {}); result = await pending;
          } else result = await invoke();
          // Unknown/cancelled host results never get repackaged as acceptance.
          // The private outgoing ledger retains any uncertain operation and its key.
          try { await assertBound(context, 'unknown'); }
          catch (error) {
            const failure = reference.safeError(error);
            return displayJSON(failure);
          }
          return displayJSON(result);
        } catch (error) { return displayJSON(reference.safeError(error)); }
        }, context?.abort).catch(error => displayJSON(reference.safeError(error)));
      },
    })];
  }));
  return Object.freeze({ tools, start, stop, status: () => runtime.status(), localMode: 'native_automatic' });
}
