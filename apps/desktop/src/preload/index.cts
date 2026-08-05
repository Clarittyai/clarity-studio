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
  createProject: (name: string, request?: string, dir?: string) =>
    ipcRenderer.invoke('project:create', name, request, dir),
  chooseFolder: () => ipcRenderer.invoke('project:choose-folder'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  integrationStatus: (projectId: string, ids: string[]) =>
    ipcRenderer.invoke('integrations:status', projectId, ids),
  connectIntegration: (projectId: string, id: string, values: Record<string, string>) =>
    ipcRenderer.invoke('integrations:connect', projectId, id, values),
  disconnectIntegration: (projectId: string, id: string) =>
    ipcRenderer.invoke('integrations:disconnect', projectId, id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getNotify: (projectId: string) => ipcRenderer.invoke('notify:get', projectId),
  setNotify: (projectId: string, prefs: { desktop?: boolean; slack?: boolean }) =>
    ipcRenderer.invoke('notify:set', projectId, prefs),
  testNotify: (title: string, body: string) => ipcRenderer.invoke('notify:test', title, body),
  chooseAutomationsRoot: () => ipcRenderer.invoke('settings:choose-automations-root'),
  deleteProject: (projectId: string) => ipcRenderer.invoke('project:delete', projectId),
  importProject: () => ipcRenderer.invoke('project:import'),
  // The terminal. `onData` returns its own unsubscribe rather than exposing
  // ipcRenderer.off to the renderer — a listener that cannot be removed is a
  // leak every time the panel remounts.
  openTerminal: (projectId: string, request?: string, agentId?: string) =>
    ipcRenderer.invoke('terminal:open', projectId, request, agentId),
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
