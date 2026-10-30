import { EventEmitter } from 'node:events';

/** In-process event bus feeding the dashboard live stream. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emit(type, data = {}) {
  bus.emit('event', { type, data, at: Date.now() });
}
