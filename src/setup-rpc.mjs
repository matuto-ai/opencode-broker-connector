// Portable OpenCode 2.2.5 RPC definition. Plain JSON Schema deliberately avoids
// pulling the server SDK (and its Effect runtime) into the native TUI bundle.
const sessionID = { type: 'string', minLength: 1, maxLength: 256 };
const brokerURL = { type: 'string', minLength: 1, maxLength: 2048 };
const input = (properties = {}, required = []) => ({ type: 'object', properties: { sessionID, ...properties }, required: ['sessionID', ...required], additionalProperties: false });
const output = { type: 'object', additionalProperties: true };
export const SETUP_RPC = {
  id: 'matuto.psst.setup',
  methods: {
    status: { input: input({ broker_url: brokerURL }), output },
    setup: { input: input({ broker_url: brokerURL, reauthorize: { type: 'boolean' }, replacement_confirmed: { type: 'boolean' }, replacement_request_id: { type: 'string', minLength: 1, maxLength: 128 }, selection_revision: { type: ['string', 'null'], maxLength: 128 } }, ['broker_url']), output },
    cancel: { input: input(), output },
    connect: { input: input(), output },
    disconnect: { input: input(), output },
    doctor: { input: input(), output },
  },
  events: {},
};
export default SETUP_RPC;
