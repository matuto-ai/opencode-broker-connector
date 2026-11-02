import { projectMetadata } from './project-metadata.mjs';
const label = (value, max = 256) => typeof value === 'string' && value.trim() && [...value].length <= max
  && value.isWellFormed() && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value) ? value.trim() : null;
export function nativeMetadata(info, config = {}, env = process.env) {
  const project = projectMetadata(config, env, info.location.directory);
  const provider = label(info.model?.providerID, 128), id = label(info.model?.id);
  let model = provider && id ? { provider, id, source: 'observed' } : { provider: null, id: null, source: 'unknown' };
  if (model.source === 'unknown') {
    const fallback = label(env.OPENCODE_MANAGED_MODEL, 385), slash = fallback?.indexOf('/') ?? -1;
    const configuredProvider = slash > 0 ? label(fallback.slice(0, slash), 128) : null;
    const configuredID = slash > 0 ? label(fallback.slice(slash + 1)) : null;
    if (configuredProvider && configuredID) model = { provider: configuredProvider, id: configuredID, source: 'configured' };
  }
  return { name: label(config.name, 128) ?? 'OpenCode', project, model };
}
