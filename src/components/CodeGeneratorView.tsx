import React, { useState } from 'react';
import { Check, Code2, Copy, FileText, Loader2, Upload } from 'lucide-react';
import { CodeGenerationResult } from '../types/devsetup';

export const CodeGeneratorView: React.FC = () => {
  const [request, setRequest] = useState('');
  const [language, setLanguage] = useState('C++');
  const [assignmentText, setAssignmentText] = useState('');
  const [showAssignment, setShowAssignment] = useState(false);
  const [result, setResult] = useState<CodeGenerationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request, language, assignmentText: assignmentText.trim() || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Code generation failed.');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Code generation failed.');
    } finally {
      setLoading(false);
    }
  };

  const uploadAssignment = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAssignmentText(reader.result.slice(0, 20000));
        setShowAssignment(true);
      }
    };
    reader.readAsText(file);
  };

  const copyCode = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Code Generator</h1>
        <p className="mt-1 text-sm text-slate-600">
          Ask for a program such as “binary search in C++”. You receive copyable code and exact run steps.
        </p>
      </div>
      <form onSubmit={generate} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <textarea
          rows={3}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="I want code for binary search in C++"
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
        />
        {showAssignment && (
          <textarea
            rows={5}
            value={assignmentText}
            onChange={(event) => setAssignmentText(event.target.value)}
            placeholder="Paste the assignment here. The generator will provide the complete solution and explain it."
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-xs font-mono focus:border-blue-600 focus:outline-none"
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-slate-700">
              Language
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                className="ml-2 rounded border border-slate-300 px-2 py-1 text-xs"
              >
                <option>C++</option>
                <option>Python</option>
                <option>Java</option>
                <option>JavaScript</option>
              </select>
            </label>
            <button type="button" onClick={() => setShowAssignment((visible) => !visible)} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900">
              <FileText className="h-3.5 w-3.5" />
              {showAssignment ? 'Hide assignment' : 'Paste assignment'}
            </button>
            <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-slate-600 hover:text-slate-900">
              <Upload className="h-3.5 w-3.5" />
              Upload assignment
              <input type="file" accept=".txt,.md" onChange={uploadAssignment} className="hidden" />
            </label>
          </div>
          <button
            type="submit"
            disabled={loading || !request.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Code2 className="h-4 w-4" />}
            {loading ? 'Generating...' : 'Generate Code'}
          </button>
        </div>
      </form>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
      {result && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">{result.title}</h2>
              <p className="text-xs text-slate-500">{result.explanation}</p>
            </div>
            <button type="button" onClick={copyCode} className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2.5 py-1.5 text-xs">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy Code'}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100"><code>{result.code}</code></pre>
          <div className="grid gap-4 md:grid-cols-2 text-sm">
            <div>
              <h3 className="font-semibold text-slate-700">How to run</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-600">
                {result.runSteps.map((step, index) => <li key={index}>{step}</li>)}
              </ol>
            </div>
            <div>
              <h3 className="font-semibold text-slate-700">Run command</h3>
              <code className="mt-2 block rounded bg-slate-100 p-2 text-xs">{result.runCommand}</code>
              <p className="mt-2 text-xs text-emerald-700">Expected: {result.expectedOutput}</p>
            </div>
          </div>
          {result.walkthrough.length > 0 && (
            <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
              <h3 className="font-semibold text-blue-900">How the solution works</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-blue-900">
                {result.walkthrough.map((step, index) => <li key={index}>{step}</li>)}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
