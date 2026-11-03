import { nativeMetadata } from './native-metadata.mjs';
import { createPresenceReader, presenceDirectory } from './active-presence.mjs';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { canonical } from '../vendor/broker/src/protocol.mjs';
import { createOpenCodeAdapter, nativeToolDefinitions } from './opencode-adapter.mjs';
import { createNativeDelivery, nativeSessionBinding, HOST_VERSION } from './native-delivery.mjs';
import { openNativeIncarnation } from './native-incarnation.mjs';
import { openNativeInbox } from './native-inbox.mjs';
import { withNativeLock } from './native-lock.mjs';
import { installationDirectory } from './installation.mjs';
import { createToolScope } from './tool-scope.mjs';
import { createNativeSetup, SETUP_TOOLS } from './native-setup.mjs';
import { recoverHostAnchor, readNativeBindings, assertExistingBinding } from './identity-recovery.mjs';

const validID = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const display = value => JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
  char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);

/** Current native OpenCode setup. Never upgrades or mutates the host.
 * No receive/ack fallback is registered: incoming delivery is native automatic.
 */
export async function setupNativePlugin({ ctx, reference, tool, loadSettings, clientFactory,
  setupOptions = {}, metadataOptions = {}, setupEnabled = true, deliveryFactory = createNativeDelivery, adapterFactory = createOpenCodeAdapter, presenceFactory = createPresenceReader, onDiagnostic = () => {} }) {
  if (ctx?.app?.version !== HOST_VERSION || ['get', 'synthetic', 'context', 'hook'].some(k => typeof ctx?.session?.[k] !== 'function')
    || typeof ctx?.storage?.get !== 'function' || typeof ctx?.storage?.set !== 'function' || typeof ctx?.storage?.scan !== 'function'
    || typeof ctx?.tool?.transform !== 'function' || typeof ctx?.event?.subscribe !== 'function') throw new Error('psst_host_capability_unavailable');
  const directory = realpathSync(ctx.location.directory);
  const hostID = await withNativeLock(setupOptions.directory ?? installationDirectory(), 'host-anchor', async () => {
    return recoverHostAnchor({ storage: ctx.storage, session: ctx.session, settings: await loadSettings(), directory, workspaceID: ctx.location.workspaceID });
  });
  const registryPrefix = 'psst-v2-session:' + createHash('sha256').update(canonical({ directory, workspaceID: ctx.location.workspaceID ?? null })).digest('hex') + ':';
  if (!validID(hostID)) throw new Error('psst_host_binding_unavailable');
  const sessions = new Map(), blocked = new Set(), archived = new Set(), controller = new AbortController(), registrations = [], toolScope = createToolScope();
  let disposed = false, events, setup, presenceTimer, synchronizing;
  const presence = presenceFactory({ directory: presenceDirectory(setupOptions.directory ?? installationDirectory(), ctx.location, { create: true }) });
  const selected = sessionID => { try { return presence.selected().has(sessionID); } catch { return false; } };
  const diagnostic = code => { try { onDiagnostic({ code }); } catch {} };
  async function getInfo(sessionID, signal = controller.signal) {
    if (!validID(sessionID) || signal.aborted || disposed) throw new Error('native_session_mismatch');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    let listener;
    const info = await Promise.race([
      ctx.session.get({ sessionID }, { signal: bounded }),
      new Promise((_, reject) => { listener = () => reject(new Error('native_session_unavailable'));
        if (bounded.aborted) listener(); else bounded.addEventListener('abort', listener, { once: true }); }),
    ]).finally(() => bounded.removeEventListener('abort', listener));
    if (bounded.aborted || disposed || info?.id !== sessionID || info.parentID || info.time?.archived
      || realpathSync(info.location.directory) !== directory || info.location.workspaceID !== ctx.location.workspaceID) throw new Error('native_session_mismatch');
    return info;
  }
  async function close(sessionID) {
    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.closing) return state.closing;
    state.controller.abort();
    state.closing = (async () => {
      await state.starting?.catch(() => {});
      await state.delivery?.stop();
      await state.adapter?.stop();
      if (!state.adapter) state.inbox?.close();
      state.incarnation?.close();
      if (sessions.get(sessionID) === state) sessions.delete(sessionID);
    })();
    return state.closing;
  }
  async function connect(sessionID) {
    if (disposed || blocked.has(sessionID) || archived.has(sessionID)) throw new Error('native_plugin_closed');
    if (!selected(sessionID)) throw new Error('native_session_not_selected');
    let state = sessions.get(sessionID);
    if (state) { await state.starting; if (state.closing) throw new Error('native_session_closing'); return state; }
    if (sessions.size >= 64) throw new Error('native_session_limit');
    state = { controller: new AbortController(), lifetime: Symbol('native host session') };
    sessions.set(sessionID, state);
    state.starting = (async () => {
      const info = await getInfo(sessionID, state.controller.signal);
      const nativeBinding = nativeSessionBinding(info, hostID);
      const settings = await loadSettings();
      if (!settings || disposed || blocked.has(sessionID) || state.controller.signal.aborted) throw new Error('psst_connect_required');
      const valid = async () => {
        if (disposed || !selected(sessionID) || blocked.has(sessionID) || state.controller.signal.aborted || sessions.get(sessionID) !== state
          || settings.enrollment && Date.parse(settings.enrollment.expiresAt) <= Date.now()) return null;
        try {
          const now = await getInfo(sessionID, state.controller.signal);
          return selected(sessionID) && !state.controller.signal.aborted && canonical(nativeSessionBinding(now, hostID)) === canonical(nativeBinding) ? now : null;
        } catch { return null; }
      };
      assertExistingBinding(settings, nativeBinding);
      state.incarnation = settings.broker.registrationVersion === 2 ? openNativeIncarnation({ reference, settings, binding: nativeBinding }) : null;
      state.inbox = state.incarnation?.inbox ?? openNativeInbox({ reference, settings, binding: nativeBinding });
      await ctx.storage.set(registryPrefix + sessionID, { sessionID, binding: nativeBinding, enabled: true });
      if (blocked.has(sessionID)) await ctx.storage.set(registryPrefix + sessionID, { sessionID, enabled: false });
      if (!await valid()) throw new Error('native_session_mismatch');
      for (let attempt = 0; attempt < 2; attempt++) {
      state.client = clientFactory ? clientFactory(state.inbox) : new reference.BrokerClient({ ...settings.broker, inbox: state.inbox });
      const binding = { sessionID, directory, worktree: directory, lifetime: state.lifetime, signal: state.controller.signal };
      state.adapter = adapterFactory({ reference, tool, client: state.client, binding,
        currentBinding: async () => await valid() ? binding : null, closeSessionOnStop: false,
        observeMetadata: async () => { const current = await valid(); if (!current) return null; const metadata = nativeMetadata(current, { ...settings, ...metadataOptions });
          return canonical(metadata) === canonical(state.inbox.getState('metadata')) ? null : metadata; },
        operationContext: context => ({ operationId: canonical({ hostID, sessionID, messageID: context.messageID, callID: context.callID }), operationStartedAt: context.operationStartedAt }),
        onDiagnostic: entry => {
          diagnostic(entry.code);
          if (entry.code === 'native_binding_unavailable' || entry.code === 'session_expired' && state.delivery) queueMicrotask(() => void close(sessionID).catch(() => {}));
          if (['unauthenticated', 'forbidden', 'registration_upgrade_required', 'retry_window_elapsed'].includes(entry.code)) { blocked.add(sessionID); queueMicrotask(() => void close(sessionID).catch(() => {})); }
        } });
      try { await state.adapter.start(nativeMetadata(info, { ...settings, ...metadataOptions })); break; }
      catch (error) {
        if (attempt !== 0 || error.code !== 'session_expired' || !state.incarnation || !state.client.expiredIdentityConfirmed) throw error;
        await state.adapter.stop();
        if (!await valid()) throw new Error('native_session_mismatch');
        state.inbox = await state.incarnation.replace({ client: state.client, verifySession: async () => !!await valid(), signal: state.controller.signal });
        state.adapter = undefined;
      }
      }
      if (!await valid()) throw new Error('native_session_mismatch');
      state.delivery = deliveryFactory({ session: ctx.session, client: state.client, inbox: state.inbox, binding: nativeBinding,
        signal: state.controller.signal, verify: valid, available: () => selected(sessionID), onDiagnostic: entry => { state.deliveryStatus = entry.code; diagnostic(entry.code); } });
      state.delivery.start();
      return state;
    })();
    try { return await state.starting; }
    catch (error) {
      // Storage uncertainty is terminal for automatic restore in this plugin
      // lifetime. A deliberate restart re-reads the durable pointer first.
      if (error.code === 'native_incarnation_uncertain') blocked.add(sessionID);
      state.controller.abort(); await state.delivery?.stop(); await state.adapter?.stop();
      if (!state.adapter) state.inbox?.close();
      state.incarnation?.close();
      if (sessions.get(sessionID) === state) sessions.delete(sessionID);
      throw error;
    }
  }
  const catalog = nativeToolDefinitions(reference.TOOL_DEFINITIONS).filter(def => def.name !== 'broker_receive');
  async function dispose() {
    if (disposed) return;
    disposed = true; clearInterval(presenceTimer); controller.abort();
    for (const state of sessions.values()) state.controller.abort();
    await setup?.stop();
    await toolScope.close();
    await Promise.all([...sessions.keys()].map(close));
    await Promise.all(registrations.map(item => item.dispose()));
    await events?.catch(() => {});
  }
  const status = sessionID => { const state = sessions.get(sessionID); return { host_version: HOST_VERSION, mode: 'native_automatic', connected: !!state?.delivery && selected(sessionID), availability: selected(sessionID) ? 'selected' : 'inactive', client_id: state?.client?.inbox?.identity?.client_id ?? null, last_delivery_status: state?.deliveryStatus ?? null, receipt_semantics: 'durable_native_admission_not_model_read' }; };
  if (setupEnabled) setup = createNativeSetup({ storage: ctx.storage, verify: async id => { try { return await getInfo(id); } catch { return null; } }, connect, status, signal: controller.signal, ...setupOptions });
  try {
    // Read all known tombstones before publishing hooks/tools or starting any
    // manifest restoration. A disabled session must never be resurrected.
    let cursor, scanned = 0;
    do {
      const saved = await ctx.storage.scan({ prefix: registryPrefix, limit: 64, ...(cursor ? { after: cursor } : {}) });
      for (const entry of saved.entries) {
        if (++scanned > 256) throw new Error('native_registry_scan_limit');
        const record = entry.value;
        if (record?.enabled === false && validID(record.sessionID)) {
          if (record.reason === 'archived') archived.add(record.sessionID); else blocked.add(record.sessionID);
        }
      }
      cursor = saved.next;
    } while (cursor && !disposed);
    registrations.push(await ctx.tool.transform(editor => {
      // Preflight the entire catalog before mutating the host editor.
      for (const definition of [...(setup ? SETUP_TOOLS : []), ...catalog]) if (editor.get(definition.name)) throw new Error('psst_tool_conflict');
      for (const definition of setup ? SETUP_TOOLS : []) {
        if (editor.get(definition.name)) throw new Error('psst_tool_conflict');
        editor.add({ ...definition, async execute(args, context) {
          try { return { content: display(await setup.invoke(definition.name, args, context)) }; }
          catch { return { content: display({ state: 'setup_blocked', next_step: 'Check setup status; do not paste credentials or automatically replace the request.' }) }; }
        } });
      }
      for (const definition of catalog) {
        if (editor.get(definition.name)) throw new Error('psst_tool_conflict');
        editor.add({ name: definition.name, description: definition.description, input: definition.inputSchema,
          // CodeMode children share the outer execute ID. Outgoing effects must
          // use direct native calls, which have durable individual IDs/times.
          ...(['broker_send', 'broker_resend'].includes(definition.name) ? { options: { codemode: false } } : {}),
          async execute(args, context) {
            return toolScope.run(async operationSignal => {
            try {
              if (!(context?.signal instanceof AbortSignal) || context.signal.aborted || !validID(context.messageID) || !validID(context.id)) throw new Error('native_session_mismatch');
              const state = await connect(context.sessionID);
              let operationStartedAt;
              if (['broker_send', 'broker_resend'].includes(definition.name)) {
                const bounded = AbortSignal.any([context.signal, operationSignal, controller.signal, AbortSignal.timeout(2000)]);
                let listener;
                const messages = await Promise.race([ctx.session.context({ sessionID: context.sessionID }, { signal: bounded }),
                  new Promise((_, reject) => { listener = () => reject(new Error('native_context_unavailable')); if (bounded.aborted) listener(); else bounded.addEventListener('abort', listener, { once: true }); })
                ]).finally(() => bounded.removeEventListener('abort', listener));
                const message = messages.find(item => item.id === context.messageID && item.type === 'assistant');
                const call = message?.content?.find(item => item.type === 'tool' && item.id === context.id && item.name === definition.name);
                operationStartedAt = call?.time?.created;
                if (!Number.isSafeInteger(operationStartedAt) || operationStartedAt <= 0) throw new Error('native_original_tool_timestamp_unavailable');
              }
              const content = await state.adapter.tools[definition.name].execute(args, { sessionID: context.sessionID,
                messageID: context.messageID, callID: context.id, ...(operationStartedAt ? { operationStartedAt } : {}), directory, worktree: directory, abort: AbortSignal.any([context.signal, operationSignal, controller.signal]) });
              return { content };
            } catch { return { content: display({ error: { code: 'session_mismatch', effect: 'unknown' } }) }; }
            }, context?.signal).catch(() => ({ content: display({ error: { code: 'session_mismatch', effect: 'unknown' } }) }));
          } });
      }
    }));
    // Prompt observation only, no mutation of human draft, selection or prompt.
    registrations.push(await ctx.session.hook('prompt', event => { void connect(event.sessionID).catch(() => diagnostic('native_connection_unavailable')); }));
    events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (disposed) break;
        if (event.type === 'location.shutdown' && event.location?.directory === directory) { void dispose(); break; }
        const sessionID = event.data?.sessionID;
        setup?.event(event);
        const state = sessions.get(sessionID);
        state?.delivery?.event(event);
        if (['session.deleted', 'session.archived', 'session.moved'].includes(event.type)) {
          if (event.type === 'session.archived') archived.add(sessionID); else blocked.add(sessionID); state?.controller.abort();
          if (validID(sessionID)) await ctx.storage.set(registryPrefix + sessionID, { sessionID, enabled: false, reason: event.type === 'session.archived' ? 'archived' : 'disabled' });
          await close(sessionID);
        }
        if (event.type === 'session.unarchived' && archived.has(sessionID) && !blocked.has(sessionID)) {
          archived.delete(sessionID);
          await ctx.storage.set(registryPrefix + sessionID, { sessionID, enabled: true });
        }
        if (event.type === 'session.created') void connect(sessionID).catch(() => diagnostic('native_connection_unavailable'));
      }
    })().catch(() => { if (!disposed) { diagnostic('native_event_stream_unavailable'); void dispose(); } });
    // Selection never creates a binding. It only restores an already persisted,
    // independently checked native identity. New sessions connect through their
    // verified native prompt/tool/setup context, not through a lease file.
    const synchronize = async () => {
      if (disposed || synchronizing) return;
      synchronizing = (async () => {
        let active; try { active = presence.selected(); } catch { active = new Set(); diagnostic('native_selection_unavailable'); }
        await Promise.all([...sessions.keys()].filter(id => !active.has(id)).map(close));
        if (disposed) return;
        const settings = await loadSettings();
        for (const record of readNativeBindings(settings)) {
          const b = record.binding;
          if (active.has(b.sessionID) && b.hostID === hostID && b.location.directory === directory
            && b.location.workspaceID === ctx.location.workspaceID && !blocked.has(b.sessionID)) {
            if (archived.has(b.sessionID)) {
              try { await getInfo(b.sessionID); archived.delete(b.sessionID); } catch { continue; }
            }
            await connect(b.sessionID).catch(() => diagnostic('native_restore_unavailable'));
          }
        }
      })().catch(() => diagnostic('native_selection_unavailable'));
      try { await synchronizing; } finally { synchronizing = undefined; }
    };
    await synchronize();
    presenceTimer = setInterval(() => void synchronize(), 500); presenceTimer.unref?.();
    void setup?.resume().catch(() => diagnostic('native_setup_restore_unavailable'));
    return { dispose, connect, status };
  } catch (error) { await dispose(); throw error; }
}
