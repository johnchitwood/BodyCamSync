'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = ['dialog:openFolder', 'dialog:openFiles', 'cache:clear', 'compact:start', 'compact:cancel', 'recents:list', 'project:open', 'project:get', 'project:setNudge', 'project:setPrefs', 'proxy:build', 'proxy:cancel', 'proxy:remove', 'disk:free','hash:start', 'hash:cancel', 'shell:reveal', 'transcript:status', 'transcript:get', 'transcript:start', 'transcript:cancel', 'transcript:downloadModel', 'transcript:export', 'review:get', 'review:save', 'speakers:status', 'speakers:get', 'speakers:start', 'speakers:cancel', 'speakers:downloadModels', 'debug:capture', 'debug:write', 'debug:readB64','debug:quit', 'debug:resize'];
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : '';
};
const EVENTS =['analysis:progress', 'proxy:progress', 'hash:progress', 'transcript:progress', 'transcript:model', 'speakers:progress', 'speakers:model', 'menu:open', 'menu:openFiles', 'compact:progress'];

contextBridge.exposeInMainWorld('bcs', {
  invoke: (channel, ...args) => {
    if (!INVOKE.includes(channel)) throw new Error('blocked channel ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) throw new Error('blocked channel ' + channel);
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  debug: arg('bcs-debug') === '1',
  autotest: arg('bcs-autotest') || '',
});
