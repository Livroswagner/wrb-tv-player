import { handleStreamProxy, onRequestOptions } from './index.js';

export async function onRequestGet(context) {
  return handleStreamProxy(context.request);
}

export async function onRequestHead(context) {
  return handleStreamProxy(context.request);
}

export { onRequestOptions };

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return onRequestOptions();
    return handleStreamProxy(request);
  }
};
