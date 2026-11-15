import React, { useState } from 'react';
import { FolderPlus, Laptop, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  LocalEnvironmentScan,
  SavedProject,
  SetupReport,
} from '../types/devsetup';

interface MyEnvironmentViewProps {
  localScan: LocalEnvironmentScan | null;
  projects: SavedProject[];
  reports: SetupReport[];
  onScanLoaded: (scan: LocalEnvironmentScan) => void;
  onAddProject: (project: SavedProject) => void;
  onDeleteProject: (id: string) => void;
  onNavigateCompanion: () => void;
}

export const MyEnvironmentView: React.FC<MyEnvironmentViewProps> = ({
  localScan,
  projects,
  reports,
  onScanLoaded,
  onAddProject,
  onDeleteProject,
  onNavigateCompanion,
}) => {
  const [showNewProject, setShowNewProject] = useState(false);
  const [projName, setProjName] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [projTools, setProjTools] = useState('');
  const [removingTool, setRemovingTool] = useState<string | null>(null);
  const [removeOutputs, setRemoveOutputs] = useState<Record<string, { success: boolean; output: string }>>({});

  const handleCreateProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!projName.trim()) return;
    onAddProject({
      id: `proj-${Date.now()}`,
      name: projName.trim(),
      description: projDesc.trim() || 'Student development environment',
      createdAt: new Date().toISOString(),
      tools: projTools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      status: 'needs_setup',
    });
    setProjName('');
    setProjDesc('');
    setProjTools('');
    setShowNewProject(false);
  };

  const installedTools = localScan?.tools.filter((t) => t.installed) ?? [];
  const missingTools = localScan?.tools.filter((t) => !t.installed) ?? [];

  const removeCommandFor = (name: string) => {
    const ids: Record<string, string> = {
      Python: 'Python.Python.3.12',
      'Node.js': 'OpenJS.NodeJS',
      Git: 'Git.Git',
      GCC: 'MSYS2.MSYS2',
      'G++': 'MSYS2.MSYS2',
      'Java Runtime': 'EclipseAdoptium.Temurin.21.JDK',
      'Java Compiler (javac)': 'EclipseAdoptium.Temurin.21.JDK',
      'VS Code': 'Microsoft.VisualStudioCode',
      Docker: 'Docker.DockerDesktop',
      MySQL: 'Oracle.MySQL',
    };
    return ids[name] ? `winget uninstall --id ${ids[name]} --silent` : `winget uninstall --name "${name}"`;
  };

  const removeSoftware = async (name: string) => {
    const command = removeCommandFor(name);
    if (!window.confirm(`Remove ${name} and its registered installation?\n\n${command}\n\nThis may require administrator approval.`)) return;
    setRemovingTool(name);
    try {
      const response = await fetch('http://127.0.0.1:4789/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const data = await response.json();
      setRemoveOutputs((previous) => ({
        ...previous,
        [name]: { success: Boolean(data.success), output: data.output || 'Removal command completed.' },
      }));
      if (data.success) {
        const scanResponse = await fetch('http://127.0.0.1:4789/scan');
        if (scanResponse.ok) onScanLoaded(await scanResponse.json());
      }
    } catch {
      setRemoveOutputs((previous) => ({
        ...previous,
        [name]: {
          success: false,
          output: 'Could not reach Local Companion. Start devsetup-companion.ps1 before removing software.',
        },
      }));
    } finally {
      setRemovingTool(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            My Development Environment
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Overview of your scanned local tools, package managers, saved course projects, and setup reports.
          </p>
        </div>
        <button
          type="button"
          onClick={onNavigateCompanion}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <Laptop className="w-3.5 h-3.5" />
          {localScan ? 'Refresh Local Scan' : 'Connect Local Companion'}
        </button>
      </div>

      {/* System Overview */}
      {!localScan ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 max-w-xl">
            <h2 className="text-base font-semibold text-slate-900">
              No Local Environment Scan Yet
            </h2>
            <p className="text-sm text-slate-600">
              DevSetup AI never displays fake or simulated software. Run the lightweight Windows Local Companion script on your laptop to inspect your actual installed compilers, runtimes, IDEs, and PATH.
            </p>
          </div>
          <button
            type="button"
            onClick={onNavigateCompanion}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
          >
            Set Up Local Companion
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500">Operating System</div>
              <div className="mt-1 text-sm font-semibold text-slate-900 truncate">
                {localScan.os}
              </div>
              <div className="mt-0.5 text-xs font-mono text-slate-500 tabular-nums">
                {localScan.architecture}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500">Installed Tools</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                {installedTools.length}
              </div>
              <div className="mt-0.5 text-xs text-emerald-700">Detected on PATH</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500">Missing Tools</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                {missingTools.length}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">Not found on PATH</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500">VS Code Extensions</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                {localScan.vscodeExtensions.length}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">Installed</div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-3">Tool</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Detected Version</th>
                  <th className="px-4 py-3">Executable Path</th>
                  <th className="px-4 py-3 text-right">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {localScan.tools.map((tool) => (
                  <tr key={tool.name} className="hover:bg-slate-50/70">
                    <td className="px-4 py-2.5 font-medium text-slate-900">{tool.name}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span
                        className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${
                          tool.installed
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 bg-slate-50 text-slate-600'
                        }`}
                      >
                        {tool.installed ? 'Installed' : 'Not Installed'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-700 tabular-nums">
                      {tool.version || '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500 max-w-xs truncate">
                      {tool.path || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {tool.installed && (
                        <button
                          type="button"
                          onClick={() => removeSoftware(tool.name)}
                          disabled={removingTool === tool.name}
                          className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {removingTool === tool.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          Remove
                        </button>
                      )}
                      {removeOutputs[tool.name] && (
                        <pre className={`mt-2 max-w-xs whitespace-pre-wrap text-left text-[11px] ${
                          removeOutputs[tool.name].success ? 'text-emerald-700' : 'text-red-700'
                        }`}>{removeOutputs[tool.name].output}</pre>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            Removal runs the official Windows package-manager uninstall command and then rescans your PC. Shared dependencies are kept when removing them would break other software; only package-owned files are removed automatically.
          </p>
        </div>
      )}

      {/* Saved Projects */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Saved Projects</h2>
          <button
            type="button"
            onClick={() => setShowNewProject(!showNewProject)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            New Project
          </button>
        </div>

        {showNewProject && (
          <form
            onSubmit={handleCreateProject}
            className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                type="text"
                required
                value={projName}
                onChange={(e) => setProjName(e.target.value)}
                placeholder="Project name (e.g., C++ Data Structures)"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
              />
              <input
                type="text"
                value={projTools}
                onChange={(e) => setProjTools(e.target.value)}
                placeholder="Tools comma-separated (e.g., VS Code, G++, CMake)"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
            <input
              type="text"
              value={projDesc}
              onChange={(e) => setProjDesc(e.target.value)}
              placeholder="Short description"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewProject(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                Save Project
              </button>
            </div>
          </form>
        )}

        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
            <FolderPlus className="w-6 h-6 text-slate-400 mx-auto" />
            <p className="mt-2 text-sm font-medium text-slate-900">No saved projects yet</p>
            <p className="mt-1 text-xs text-slate-500">
              Generate a setup plan in the Setup Agent or create a project above to track your coursework environments.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((proj) => (
              <div
                key={proj.id}
                className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{proj.name}</h3>
                    <button
                      type="button"
                      onClick={() => onDeleteProject(proj.id)}
                      className="text-slate-400 hover:text-red-600 p-1"
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 line-clamp-2">{proj.description}</p>
                  {proj.tools.length > 0 && (
                    <div className="mt-3 text-xs text-slate-500">
                      {proj.tools.join(' · ')}
                    </div>
                  )}
                </div>
                <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 tabular-nums">
                  <span>{new Date(proj.createdAt).toLocaleDateString()}</span>
                  <span
                    className={
                      proj.status === 'ready' ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'
                    }
                  >
                    {proj.status === 'ready' ? 'Ready' : 'Needs Setup'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Previous Setup Reports */}
      {reports.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Recent Setup Reports</h2>
          <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {reports.map((rep) => (
              <div key={rep.id} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">{rep.projectTitle}</div>
                  <div className="text-xs text-slate-500">{rep.summary}</div>
                </div>
                <div className="text-right text-xs text-slate-500 tabular-nums shrink-0">
                  <div>{new Date(rep.createdAt).toLocaleDateString()}</div>
                  <div>
                    {rep.installedCount} installed · {rep.missingCount} missing
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
