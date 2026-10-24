// Quem entregou a última resposta da API: o gateway põe x-served-by (pod) e
// x-service-version em toda resposta. O carimbo postal da interface lê daqui.
import { useSyncExternalStore } from 'react';

let last = null;
const listeners = new Set();

export function recordDelivery(res, ms) {
  const pod = res.headers.get('x-served-by');
  if (!pod) return;
  last = { pod, version: res.headers.get('x-service-version') || '', ms: Math.round(ms), at: new Date() };
  listeners.forEach((l) => l());
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

export const useDelivery = () => useSyncExternalStore(subscribe, () => last);
