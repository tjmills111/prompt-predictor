import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generationHealth } from './status.mjs';
const runtime = process.env.COMPOSER_RECORDER_HOME || path.join(os.homedir(), 'AppData/Local/GreyPredictionComposer/capture');
const file = path.join(runtime, 'generation.json');
const action = process.argv[2] ?? 'status';
if (action === 'enable' || action === 'disable') {
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled: action === 'enable', updatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(action === 'enable' ? 'Sol 6.1/High predictions requested. Run status to verify renderer activation.' : 'Prediction adapter disabled; existing native prediction routing will be restored.');
} else if (action === 'status') {
  let configured = false; try { configured = JSON.parse(fs.readFileSync(file, 'utf8')).enabled === true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let status; try { status = JSON.parse(fs.readFileSync(path.join(runtime, 'status.json'), 'utf8')); } catch {}
  let processAlive = false; try { if (status?.pid) { process.kill(status.pid, 0); processAlive = true; } } catch {}
  console.log(JSON.stringify(generationHealth(configured, status, { processAlive }), null, 2));
} else throw Error('Use enable, disable or status');
