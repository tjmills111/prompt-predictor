import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPredictionEngine } from './engine.mjs';
import { installBrowserAdapter } from './browser-adapter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export class GenerationManager {
  constructor(runtime, manifest) { this.configFile = path.join(runtime, 'generation.json'); this.spec = manifest.generation; }
  enabled() { try { return JSON.parse(fs.readFileSync(this.configFile, 'utf8')).enabled === true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  profile() {
    const source = fs.readFileSync(path.join(here, 'engine.mjs'), 'utf8') + fs.readFileSync(path.join(here, 'browser-adapter.mjs'), 'utf8');
    return { ...this.spec, revision: createHash('sha256').update(source + JSON.stringify(this.spec)).digest('hex') };
  }
  async arm(c, script, source) {
    if (!this.enabled() || script.url.split('/').pop() !== this.spec.catchupScript || c.generationRouteArmed) return;
    const needle = this.spec.catchupNeedle, offset = source.indexOf(needle);
    if (offset < 0 || source.indexOf(needle, offset + 1) >= 0) throw Error('Prediction request routing site changed');
    const prefix = source.slice(0, offset), lineNumber = prefix.split('\n').length - 1, columnNumber = offset - prefix.lastIndexOf('\n') - 1;
    const possible = await c.call('Debugger.getPossibleBreakpoints', { start: { scriptId: script.scriptId, lineNumber, columnNumber }, end: { scriptId: script.scriptId, lineNumber, columnNumber: columnNumber + 60 }, restrictToFunction: true });
    if (!possible.locations[0]) throw Error('No prediction routing breakpoint');
    const local = this.spec.catchupServiceLocal ?? 'l';
    if (!/^[A-Za-z_$][\w$]*$/.test(local)) throw Error('Invalid reviewed catch-up service local');
    const bp = await c.call('Debugger.setBreakpoint', { location: possible.locations[0], condition: `(()=>{const a=globalThis.__COMPOSER_ASTRA_ADAPTER;if(a?.service)${local}=a.service;return false;})()` });
    c.breakpoints.push(bp.breakpointId); c.generationRouteArmed = true;
  }
  async ensure(c) {
    const evaluate = async expression => {
      const r = await c.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      if (!this.enabled()) {
        const hadAdapter = await evaluate('(async()=>{const a=globalThis.__COMPOSER_ASTRA_ADAPTER;await a?.dispose();return !!a;})()');
        if (hadAdapter) await evaluate(this.refreshExpression());
        c.generationState = { state: 'disabled' }; return;
      }
      if (!c.generationCompatible) { c.generationState = { state: 'unsupported_or_loading' }; return; }
      if (!c.generationRouteArmed && c.generationCatchupSource) await this.arm(c, c.generationCatchupSource.script, c.generationCatchupSource.source);
      const profile = this.profile();
      const current = await evaluate('globalThis.__COMPOSER_ASTRA_ADAPTER?.status()??null');
      if (current?.revision === profile.revision) { c.generationState = current; return; }
      c.generationState = await evaluate(`(async()=>{const create=${createPredictionEngine.toString()};const install=${installBrowserAdapter.toString()};return await install(${JSON.stringify(profile)},create);})()`);
      if (c.generationState?.state === 'active') {
        // A native query refresh lets the existing Cj/qf/wj path consume the new service result.
        await evaluate(this.refreshExpression());
      }
    } catch (error) { c.generationState = { state: 'error', error: String(error) }; }
  }
  refreshExpression() {
    const { moduleUrl, bindings } = this.spec;
    return `(async()=>{const m=await import(${JSON.stringify(moduleUrl)});const pick=b=>typeof b==='string'?m[b]:m.__webpack_require__(b.moduleId)[b.export];await pick(${JSON.stringify(bindings.consume)})(pick(${JSON.stringify(bindings.services)}).queryCache.invalidateQueryCache({queryKey:['cumberbatch'],reset:true}));return true;})()`;
  }
}
