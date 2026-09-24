import { createBirpc } from 'birpc';
import { assertReducerBundleContract, type ReducerBundleContract } from '@dreamboard-games/sdk/reducer-contract';
import { canonicalizePluginRuntimeJson } from '@dreamboard-games/sdk/plugin-runtime-contract';
import type { WorkerApi, WorkerRequest } from './contract.js';
let game: ReducerBundleContract | undefined;
async function execute(request: WorkerRequest): Promise<string> {
  if (!game) {
    const url = URL.createObjectURL(new Blob([request.source], {type:'text/javascript'}));
    try {
      const module = await import(url);
      assertReducerBundleContract(module.default, 'browser worker');
      game = module.default;
    } finally { URL.revokeObjectURL(url); }
  }
  let result: unknown;
  if (request.operation === 'initialize') result = await game!.initialize(request.input);
  else if (request.operation === 'dispatch') result = await game!.dispatch(request.input);
  else if (request.operation === 'project') result = await game!.project(request.input);
  else result = await game!.boardStatic();
  const json = JSON.stringify(canonicalizePluginRuntimeJson(result));
  if (new TextEncoder().encode(json).length > 8 * 1024 * 1024) throw new Error('Game response exceeds 8 MiB');
  return json;
}
const api: WorkerApi = { async execute(request) {
  try { return await execute(request); } catch (error) { throw new Error(String(error).slice(0,4096)); }
} };
createBirpc<object, WorkerApi>(api, {
  post: data => self.postMessage(data),
  on: receive => { self.onmessage = event => receive(event.data); },
  resolver: name => name === 'execute' ? api.execute : undefined,
});
