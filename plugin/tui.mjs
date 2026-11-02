import { randomUUID } from 'node:crypto';
import { installationDirectory } from '../src/installation.mjs';
import { createPresenceWriter, presenceDirectory } from '../src/active-presence.mjs';

export default {
  id: 'matuto.psst',
  setup(ctx) {
    let writer, directory, last, lastWrite = 0, warned = false;
    const offline = () => {
      if (!warned) ctx.ui?.toast?.show?.({ title: 'Psst offline', message: 'Active-chat messaging requires a local TUI sharing the server private directory.', variant: 'warning' });
      warned = true;
    };
    if (ctx.app?.version !== '2.2.5' || typeof ctx.ui?.router?.current !== 'function' || typeof ctx.storage?.memory !== 'function') { offline(); return; }
    const [memory, update] = ctx.storage.memory('psst-active-owner', { initial: { owner: randomUUID(), seq: 0 } });
    const counter = { get seq() { return memory.seq; }, set seq(value) { update(draft => { draft.seq = value; }); } };
    const tick = () => {
      try {
        const route = ctx.ui.router.current(), location = ctx.location;
        if (!location) throw new Error('native_selection_location_unavailable');
        const nextDirectory = presenceDirectory(installationDirectory(), location);
        if (nextDirectory !== directory) {
          writer?.stop(); writer = undefined; directory = undefined;
          writer = createPresenceWriter({ directory: nextDirectory, owner: memory.owner, counter });
          directory = nextDirectory; last = undefined;
        }
        const selected = route.type === 'session' ? route.sessionID : null;
        if (selected !== last || Date.now() - lastWrite >= 1000) { writer.write(selected); last = selected; lastWrite = Date.now(); }
        warned = false;
      } catch { try { writer?.stop(); } catch {} writer = undefined; directory = undefined; offline(); }
    };
    tick(); const timer = setInterval(tick, 250); timer.unref?.();
    return () => { clearInterval(timer); try { writer?.stop(); } catch {} };
  },
};
