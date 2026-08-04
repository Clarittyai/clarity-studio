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
  start: (projectId: string) => ipcRenderer.invoke('project:start', projectId),
  stop: (projectId: string) => ipcRenderer.invoke('project:stop', projectId),
  runWorkflow: (projectId: string, workflowId?: string) =>
    ipcRenderer.invoke('workflow:run', projectId, workflowId),
});
