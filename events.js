import { EventEmitter } from 'node:events';

// App-wide change notifications, so modules can react without importing each other.
//   'meta-changed'     (fileIds)          title / folder / tags changed here
//   'speakers-synced'  (fileId, names)    new speaker names are in Plaud
export const bus = new EventEmitter();
