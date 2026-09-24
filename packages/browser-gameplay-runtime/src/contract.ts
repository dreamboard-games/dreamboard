import type { ReducerBundleContract } from '@dreamboard-games/sdk/reducer-contract';
export type Operation = (
  { operation:'initialize'; input:Parameters<ReducerBundleContract['initialize']>[0] } |
  { operation:'dispatch'; input:Parameters<ReducerBundleContract['dispatch']>[0] } |
  { operation:'project'; input:Parameters<ReducerBundleContract['project']>[0] } |
  { operation:'boardStatic' }
);
export interface WorkerApi { execute(request:WorkerRequest):Promise<string> }

export type WorkerRequest = {source:string} & Operation;
