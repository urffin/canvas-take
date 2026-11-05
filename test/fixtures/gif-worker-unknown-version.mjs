import '/dist/gif-worker-runtime.js';
const post = self.postMessage.bind(self);
self.postMessage = (message, transfer) => post(message.rawPreparationVersion === 1
    ? { ...message, rawPreparationVersion: 99 } : message, transfer);
