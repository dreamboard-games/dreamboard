import { createBirpc } from 'birpc';
import type { WorkerApi, WorkerRequest } from './contract.js';
declare const __WORKER_SOURCE__: string;
// The frame owns worker creation: a worker created by the trusted parent would
// inherit the parent's origin, storage, and credentials even after transfer.
export function createSandbox(timeoutMs:number) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.sandbox.add('allow-scripts');
  const channel = new MessageChannel();
  const source = JSON.stringify(__WORKER_SOURCE__).replaceAll('<','\\u003c');
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src data:; connect-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'"><script>
addEventListener('message', function connect(event) {
  if (event.source !== parent || !event.ports[0]) return;
  removeEventListener('message', connect);
  const port = event.ports[0];
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(${source});
  const worker = new Worker(url, {type:'module'});
  let timer;
  worker.onmessage = event => { clearTimeout(timer); port.postMessage(event.data); };
  worker.onerror = event => { clearTimeout(timer); worker.terminate(); port.postMessage({fatal:'Game worker failed: ' + event.message}); };
  port.onmessage = event => {
    if (event.data === 'dispose') { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); port.close(); return; }
    timer = setTimeout(() => { worker.terminate(); port.postMessage({fatal:'Game execution timed out'}); }, ${timeoutMs});
    worker.postMessage(event.data);
  };
  port.postMessage('ready');
});
</script>`;
  let stop:(error:Error)=>void = () => {};
  const ready = new Promise<void>((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Game sandbox failed to start')),timeoutMs);
    stop = error => { clearTimeout(timer); reject(error); };
    channel.port1.onmessage = event => {
      if(event.data === 'ready') { clearTimeout(timer); resolve(); }
    };
  });
  frame.onload = () => frame.contentWindow!.postMessage('connect','*',[channel.port2]);
  document.body.append(frame);
  let disposed = false;
  const rpc = createBirpc<WorkerApi,object>({}, {
    post: data => channel.port1.postMessage(data),
    on: receive => { void ready.then(() => {
      channel.port1.onmessage = event => {
        if(event.data?.fatal) close(new Error(event.data.fatal));
        else receive(event.data);
      };
    }).catch(() => {}); },
    resolver:()=>undefined,
    timeout:timeoutMs + 1000,
  });
  function close(error = new Error('Game sandbox disposed')) {
    if(disposed) return;
    disposed = true;
    stop(error);
    rpc.$close(error);
    channel.port1.postMessage('dispose');
    channel.port1.close();
    frame.remove();
  }
  return {
    async execute(request:WorkerRequest) {
      try { await ready; return await rpc.execute(request); }
      catch(error) { close(); throw error; }
    },
    close,
  };
}
