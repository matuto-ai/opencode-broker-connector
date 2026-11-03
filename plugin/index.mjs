import { tool } from '../src/tool-schema.mjs';
import { loadBrokerReference } from '../src/reference.mjs';
import { readExistingConnection } from '../src/enrollment.mjs';
import { readInstallation } from '../src/installation.mjs';
import { setupNativePlugin } from '../src/native-plugin.mjs';

// Structurally the public @opencode/plugin Plugin.define({ id, setup }) contract.
// define is identity-only; the package never installs a host, runtime or CLI.
export default {
  id: 'matuto.psst',
  async setup(ctx) {
    const reference = await loadBrokerReference();
    const connectionFile = ctx.options?.connectionFile ?? process.env.PSST_CONFIG_FILE;
    const runtime = await setupNativePlugin({ ctx, reference, tool, metadataOptions: ctx.options ?? {}, setupEnabled: !connectionFile,
      loadSettings: readOptions => connectionFile ? readExistingConnection(connectionFile, readOptions) : readInstallation(undefined, readOptions) });
    return runtime.dispose;
  },
};
