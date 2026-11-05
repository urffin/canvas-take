import '/dist/gif-worker-runtime.js';
const handle = self.onmessage;
self.onmessage = event => {
    if (event.data.action === 'raw-frame-v1') self.postMessage({ rawStarted: true });
    handle(event);
};
