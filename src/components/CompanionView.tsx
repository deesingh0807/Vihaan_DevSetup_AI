import React, { useState } from 'react';
import { Check, Copy, Download, RefreshCw, Upload } from 'lucide-react';
import { LocalEnvironmentScan } from '../types/devsetup';

interface CompanionViewProps {
  localScan: LocalEnvironmentScan | null;
  onScanLoaded: (scan: LocalEnvironmentScan) => void;
}

export const CompanionView: React.FC<CompanionViewProps> = ({
  localScan,
  onScanLoaded,
}) => {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [companionToken, setCompanionToken] = useState(
    () => localStorage.getItem('devsetup_companion_token') || ''
  );

  const saveCompanionToken = (value: string) => {
    setCompanionToken(value);
    localStorage.setItem('devsetup_companion_token', value.trim());
  };

  const handleConnectLive = async () => {
    if (!companionToken.trim()) {
      setError('Run the downloaded PowerShell script first, then paste the "Companion session token" printed in that PowerShell window.');
      return;
    }
    setConnecting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch('http://127.0.0.1:4789/scan', {
        headers: { 'X-Companion-Token': companionToken.trim() },
      });
      if (!res.ok) throw new Error('Companion returned an error.');
      const data = (await res.json()) as LocalEnvironmentScan;
      onScanLoaded(data);
      setSuccessMsg(`Connected to ${data.hostname} (${data.os})`);
    } catch {
      setError(
        'Could not reach http://127.0.0.1:4789/scan. Make sure devsetup-companion.ps1 is running on your computer, or upload devsetup-scan.json below.'
      );
    } finally {
      setConnecting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.target?.result)) as LocalEnvironmentScan;
        if (!parsed.os || !Array.isArray(parsed.tools)) {
          throw new Error('Invalid scan file format.');
        }
        onScanLoaded(parsed);
        setSuccessMsg(`Imported scan from ${parsed.hostname || 'local machine'}`);
      } catch {
        setError('Invalid devsetup-scan.json file.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Local Companion Agent
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          A cloud AI cannot inspect your laptop directly. Run our lightweight Windows PowerShell companion script locally to scan your real compilers, runtimes, IDEs, and PATH.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">
              Step 1: Download & Run Companion (Windows 10/11)
            </h2>
            <p className="text-xs text-slate-600">
              Inspects Python, Node.js, Git, GCC/G++, Java/javac, VS Code, Docker, MySQL, and PATH without modifying anything.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await fetch('/api/companion/script?format=raw');
                  const text = await res.text();
                  if (text.trim().startsWith('<')) {
                    throw new Error('Received HTML instead of script');
                  }
                  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'devsetup-companion.ps1';
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                } catch {
                  setError('Failed to download script. Please redeploy or run from the dev URL.');
                }
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download devsetup-companion.ps1
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/companion/script?format=raw');
                const text = await res.text();
                navigator.clipboard.writeText(text);
                setSuccessMsg('Copied PowerShell script to clipboard! Paste into Notepad and save as devsetup-companion.ps1');
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy Script
            </button>
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
          <div className="font-medium text-slate-700">Run in Windows PowerShell 5.1:</div>
          <code className="block whitespace-pre-wrap font-mono text-slate-900">
            cd "$HOME\Downloads"{'\n'}$script = Get-ChildItem ".\devsetup-companion*.ps1" | Sort-Object LastWriteTime -Descending | Select-Object -First 1{'\n'}powershell.exe -ExecutionPolicy Bypass -File $script.FullName
          </code>
            <div className="pt-2 text-slate-600">
            If the file was saved somewhere else, replace <code className="font-mono">$HOME\Downloads</code> with that folder. You can also right-click the downloaded file, choose <strong>Properties</strong>, copy its folder location, and run <code className="font-mono">cd "that-folder"</code> first.
          </div>
          <div className="pt-1 text-slate-600">
            Copy the value after <code className="font-mono">Companion session token:</code> from that window and keep PowerShell open.
            </div>
          </div>
          <label className="block text-xs text-slate-600">
            Companion token (printed in the PowerShell window)
            <input
              type="password"
              value={companionToken}
              onChange={(e) => saveCompanionToken(e.target.value)}
              placeholder="Paste the session token"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
            />
          </label>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">
              Step 2: Connect or Import Scan
            </h2>
            <p className="text-xs text-slate-600">
              Fetch live results from the running companion or upload the generated <code className="font-mono">devsetup-scan.json</code> file.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleConnectLive}
              disabled={connecting}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${connecting ? 'animate-spin' : ''}`} />
              {connecting ? 'Connecting...' : 'Connect to Localhost:4789'}
            </button>

            <label className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              Upload devsetup-scan.json
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              {error}
            </div>
          )}

          {successMsg && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              <Check className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {localScan && (
            <div className="text-xs text-slate-500 tabular-nums">
              Last scanned: {new Date(localScan.scannedAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-xs text-blue-900">
        <strong>Secure companion:</strong> every command is token-authenticated, shown in the PowerShell console for approval, restricted to approved executables, and recorded locally in <code>devsetup-activity.log</code>.
      </div>
    </div>
  );
};
