/**
 * The only bridge between the renderer and anything real.
 *
 * Written as CommonJS (.cts) because a sandboxed preload script cannot be an
 * ES module — Electron requires CJS here.
 *
 * Every method is an explicit, named passthrough. Nothing generic like
 * `invoke(channel, ...args)` is exposed: that would hand the renderer the whole
 * IPC surface and make the allowlist in the main process pointless.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('studio', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  listRuns: (projectId: string) => ipcRenderer.invoke('runs:list', projectId),
  listSteps: (runId: string) => ipcRenderer.invoke('steps:list', runId),
  listTriggers: (projectId: string) => ipcRenderer.invoke('triggers:list', projectId),
  spend: (projectId: string, sinceMs: number) => ipcRenderer.invoke('spend:get', projectId, sinceMs),
  // These two were declared on the renderer's API and called on every project
  // screen, but never bridged — so in Electron they were `undefined`, and the
  // TypeError took the whole view down. Bridged now.
  manifest: (projectId: string) => ipcRenderer.invoke('manifest:get', projectId),
  agents: () => ipcRenderer.invoke('agents:list'),
  createProject: () => ipcRenderer.invoke('project:create'),
  importProject: () => ipcRenderer.invoke('project:import'),
  // The terminal. `onData` returns its own unsubscribe rather than exposing
  // ipcRenderer.off to the renderer — a listener that cannot be removed is a
  // leak every time the panel remounts.
  openTerminal: (projectId: string, request?: string) =>
    ipcRenderer.invoke('terminal:open', projectId, request),
  writeTerminal: (projectId: string, data: string) =>
    ipcRenderer.send('terminal:write', projectId, data),
  resizeTerminal: (projectId: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', projectId, cols, rows),
  closeTerminal: (projectId: string) => ipcRenderer.send('terminal:close', projectId),
  onTerminalData: (handler: (projectId: string, data: string) => void) => {
    const listener = (_e: unknown, projectId: string, data: string) => handler(projectId, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.off('terminal:data', listener);
  },
  onTerminalExit: (handler: (projectId: string, code: number) => void) => {
    const listener = (_e: unknown, projectId: string, code: number) => handler(projectId, code);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.off('terminal:exit', listener);
  },
  openExternal: (url: string) => ipcRenderer.send('shell:open-external', url),
  listKeys: () => ipcRenderer.invoke('keys:list'),
  setKey: (providerId: string, field: string, value: string) =>
    ipcRenderer.invoke('keys:set', providerId, field, value),
  removeKey: (providerId: string, field: string) =>
    ipcRenderer.invoke('keys:remove', providerId, field),
  watchProject: (projectId: string) => ipcRenderer.invoke('project:watch', projectId),
  unwatchProject: (projectId: string) => ipcRenderer.send('project:unwatch', projectId),
  onProjectChanged: (handler: (projectId: string, file: string) => void) => {
    const listener = (_e: unknown, projectId: string, file: string) => handler(projectId, file);
    ipcRenderer.on('project:changed', listener);
    return () => ipcRenderer.off('project:changed', listener);
  },
  llmCalls: (runId: string) => ipcRenderer.invoke('llm:list', runId),
  start: (projectId: string) => ipcRenderer.invoke('project:start', projectId),
  stop: (projectId: string) => ipcRenderer.invoke('project:stop', projectId),
  runWorkflow: (projectId: string, workflowId?: string) =>
    ipcRenderer.invoke('workflow:run', projectId, workflowId),
});
