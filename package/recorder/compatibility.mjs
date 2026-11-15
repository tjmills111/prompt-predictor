import { createHash } from 'node:crypto';

export const requiredHooks = ['live', 'catch_up', 'submission', 'interaction'];

export function captureLocations(source, spec) {
  if (createHash('sha256').update(source).digest('hex') !== spec.sha256) throw Error('Source hash mismatch');
  return spec.hooks.map(hook => {
    const index = source.indexOf(hook.needle);
    if (index < 0 || source.indexOf(hook.needle, index + 1) >= 0) throw Error('Changed/ambiguous capture site: ' + hook.name);
    const offset = index + (hook.after ? hook.needle.length : 0), prefix = source.slice(0, offset);
    return { hook, lineNumber: prefix.split('\n').length - 1, columnNumber: offset - prefix.lastIndexOf('\n') - 1 };
  });
}

export function captureCompatibility(hooks, scriptNames, profile, error = null) {
  const missingHooks = requiredHooks.filter(hook => !hooks.has(hook));
  return { state: error ? 'incompatible' : missingHooks.length ? 'unsupported_or_loading' : 'compatible',
    profileVersion: profile.appVersion, missingHooks,
    missingScripts: Object.keys(profile.scripts).filter(name => !scriptNames.has(name)), error };
}
