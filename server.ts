import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { SOFTWARE_KNOWLEDGE_BASE } from './src/data/knowledgeBase.ts';

dotenv.config();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const configuredPruneApiKey = process.env.PRUNE_API_KEY?.trim();
const pruneApiKey =
  configuredPruneApiKey && configuredPruneApiKey !== 'prune_your_api_key'
    ? configuredPruneApiKey
    : undefined;
const pruneGeminiUrl =
  process.env.PRUNE_GEMINI_URL?.trim() ||
  'https://api.withprune.com/v1/proxy/gemini/generateContent';
const pruneModel = process.env.PRUNE_MODEL?.trim() || 'gemini-3.5-flash-lite';
const pruneUsage = {
  requests: 0,
  cacheHits: 0,
  lastMetadata: null as unknown,
};
const ai = !pruneApiKey && geminiApiKey
  ? new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

type GenerateParams = Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>;

type GeneratedResponse = { text?: string };

function parseGeneratedJson(text: string | undefined) {
  const raw = (text || '{}').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('The AI provider returned a response that was not valid JSON.');
  }
}

function findCatalogItem(name: unknown) {
  if (typeof name !== 'string') return undefined;
  const normalized = name.trim().toLowerCase();
  return SOFTWARE_KNOWLEDGE_BASE.find(
    (item) =>
      item.name.toLowerCase() === normalized ||
      item.id.toLowerCase() === normalized ||
      normalized.includes(item.name.toLowerCase()) ||
      item.name.toLowerCase().includes(normalized)
  );
}

function sanitizeScanForAi(scan: unknown) {
  if (!scan || typeof scan !== 'object') return scan;
  const value = scan as Record<string, unknown>;
  return {
    os: value.os,
    osVersion: value.osVersion,
    architecture: value.architecture,
    packageManagers: value.packageManagers,
    tools: Array.isArray(value.tools)
      ? value.tools.map((tool) => {
          if (!tool || typeof tool !== 'object') return tool;
          const item = tool as Record<string, unknown>;
          return {
            name: item.name,
            installed: item.installed,
            version: item.version,
            status: item.status,
          };
        })
      : [],
    vscodeExtensions: value.vscodeExtensions,
    envVars: value.envVars,
  };
}

function toPruneMessages(contents: unknown, systemInstruction?: unknown) {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }> = [];
  if (typeof systemInstruction === 'string' && systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }

  if (typeof contents === 'string') {
    messages.push({ role: 'user', content: contents });
    return messages;
  }

  if (Array.isArray(contents)) {
    for (const item of contents as Array<{ role?: string; parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }>) {
      const parts = item.parts ?? [];
      const content = parts
        .map((part) =>
          part.inlineData?.data
            ? {
                type: 'image_url',
                image_url: {
                  url: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
                },
              }
            : { type: 'text', text: part.text || '' }
        );
      messages.push({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
      });
    }
  }
  return messages;
}

async function generateThroughPrune(params: GenerateParams): Promise<GeneratedResponse> {
  const schemaHint = params.config?.responseSchema
    ? `\nReturn ONLY valid JSON matching this schema. Do not use markdown fences or introductory text:\n${JSON.stringify(params.config.responseSchema)}`
    : '';
  const response = await fetch(pruneGeminiUrl, {
    method: 'POST',
    headers: {
      'X-Prune-Key': pruneApiKey!,
      'Content-Type': 'application/json',
      'X-Prune-Feature-Id': 'devsetup-ai',
    },
    body: JSON.stringify({
      model: pruneModel,
      messages: toPruneMessages(
        params.contents,
        `${typeof params.config?.systemInstruction === 'string' ? params.config.systemInstruction : ''}${schemaHint}`
      ),
      maxOutputTokens: params.config?.maxOutputTokens,
      temperature: params.config?.temperature,
      ...(params.config?.responseMimeType === 'application/json'
        ? { response_format: { type: 'json_object' } }
        : {}),
    }),
  });

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    text?: string;
    response?: { text?: string };
    error?: { message?: string };
    prune_metadata?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      `Prune API error (${response.status}): ${body.error?.message || JSON.stringify(body)}`
    );
  }
  pruneUsage.requests += 1;
  if (response.headers.get('x-prune-cache-hit') === 'true') pruneUsage.cacheHits += 1;
  pruneUsage.lastMetadata = body.prune_metadata ?? null;
  return {
    text:
      body.choices?.[0]?.message?.content ||
      body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') ||
      body.response?.text ||
      body.text,
  };
}

async function generateWithFallback(
  params: GenerateParams
) {
  if (!ai && !pruneApiKey) {
    throw new Error(
      'Configure GEMINI_API_KEY or PRUNE_API_KEY in .env and restart the server.'
    );
  }

  const models = ['gemini-3.5-flash-lite'];
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      if (pruneApiKey) return await generateThroughPrune(params);
      return await ai!.models.generateContent({ ...params, model });
    } catch (err) {
      lastError = err;
      const errText = `${err instanceof Error ? err.message : ''} ${JSON.stringify(err)}`;
      if (!errText.includes('503') && !errText.includes('UNAVAILABLE')) {
        throw err;
      }
      if (i < models.length - 1) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  throw lastError;
}

const WINDOWS_COMPANION_PS1 = `# DevSetup AI - Local Companion Agent (Windows 10/11)
# Scans your actual local development environment and serves it on http://127.0.0.1:4789/scan
# Also outputs devsetup-scan.json in the current directory.

$ErrorActionPreference = "SilentlyContinue"
$companionToken = [guid]::NewGuid().ToString("N")
$allowedOrigins = @("http://127.0.0.1:3000", "http://localhost:3000")
$activityPath = Join-Path (Get-Location) "devsetup-activity.log"
Write-Host "Companion session token: $companionToken" -ForegroundColor Magenta
Write-Host "Paste this token into DevSetup AI before connecting." -ForegroundColor Yellow

function Write-Activity($event) {
    Add-Content -Path $activityPath -Value ("{0} {1}" -f (Get-Date).ToString("o"), $event)
}

function Get-CmdVersion($cmd, $argsList) {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $found) {
        return @{ installed = $false; version = $null; path = $null }
    }
    try {
        $out = & $cmd $argsList 2>&1 | Select-Object -First 1
        return @{ installed = $true; version = "$out".Trim(); path = $found.Source }
    } catch {
        return @{ installed = $true; version = "Detected (version unknown)"; path = $found.Source }
    }
}

function Get-ScanJson {
Write-Host "Scanning local development environment..." -ForegroundColor Cyan

$os = Get-CimInstance Win32_OperatingSystem
$python = Get-CmdVersion "python" "--version"
$node = Get-CmdVersion "node" "-v"
$npm = Get-CmdVersion "npm" "-v"
$git = Get-CmdVersion "git" "--version"
$gcc = Get-CmdVersion "gcc" "--version"
$gpp = Get-CmdVersion "g++" "--version"
$java = Get-CmdVersion "java" "-version"
$javac = Get-CmdVersion "javac" "-version"
$code = Get-CmdVersion "code" "--version"
$winget = Get-CmdVersion "winget" "--version"
$pip = Get-CmdVersion "pip" "--version"
$docker = Get-CmdVersion "docker" "--version"
$mysql = Get-CmdVersion "mysql" "--version"

$vscodeExt = @()
if ($code.installed) {
    $vscodeExt = & code --list-extensions 2>$null
}

$tools = @(
    @{ name = "Python"; installed = $python.installed; version = $python.version; path = $python.path; source = "companion"; status = $(if ($python.installed) { "ok" } else { "missing" }) },
    @{ name = "Node.js"; installed = $node.installed; version = $node.version; path = $node.path; source = "companion"; status = $(if ($node.installed) { "ok" } else { "missing" }) },
    @{ name = "Git"; installed = $git.installed; version = $git.version; path = $git.path; source = "companion"; status = $(if ($git.installed) { "ok" } else { "missing" }) },
    @{ name = "GCC"; installed = $gcc.installed; version = $gcc.version; path = $gcc.path; source = "companion"; status = $(if ($gcc.installed) { "ok" } else { "missing" }) },
    @{ name = "G++"; installed = $gpp.installed; version = $gpp.version; path = $gpp.path; source = "companion"; status = $(if ($gpp.installed) { "ok" } else { "missing" }) },
    @{ name = "Java Runtime"; installed = $java.installed; version = $java.version; path = $java.path; source = "companion"; status = $(if ($java.installed) { "ok" } else { "missing" }) },
    @{ name = "Java Compiler (javac)"; installed = $javac.installed; version = $javac.version; path = $javac.path; source = "companion"; status = $(if ($javac.installed) { "ok" } else { "missing" }) },
    @{ name = "VS Code"; installed = $code.installed; version = $code.version; path = $code.path; source = "companion"; status = $(if ($code.installed) { "ok" } else { "missing" }) },
    @{ name = "Docker"; installed = $docker.installed; version = $docker.version; path = $docker.path; source = "companion"; status = $(if ($docker.installed) { "ok" } else { "missing" }) },
    @{ name = "MySQL"; installed = $mysql.installed; version = $mysql.version; path = $mysql.path; source = "companion"; status = $(if ($mysql.installed) { "ok" } else { "missing" }) }
)

$scanResult = @{
    scannedAt = (Get-Date).ToString("o")
    os = $os.Caption
    osVersion = $os.Version
    architecture = $env:PROCESSOR_ARCHITECTURE
    hostname = $env:COMPUTERNAME
    shell = "PowerShell $($PSVersionTable.PSVersion)"
    packageManagers = @{
        winget = $winget.version
        pip = $pip.version
        npm = $npm.version
        conda = $null
        choco = $null
    }
    tools = $tools
    pathEntries = ($env:PATH -split ";" | Where-Object { $_ -ne "" })
    vscodeExtensions = @($vscodeExt)
    envVars = @{
        JAVA_HOME = $env:JAVA_HOME
        PYTHONPATH = $env:PYTHONPATH
        NODE_ENV = $env:NODE_ENV
    }
}

$json = $scanResult | ConvertTo-Json -Depth 6
$json | Out-File -FilePath "devsetup-scan.json" -Encoding utf8
Write-Host "Saved scan to devsetup-scan.json" -ForegroundColor Green
return $json
}

$json = Get-ScanJson

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:4789/")
$listener.Start()
Write-Host "DevSetup Companion listening on http://127.0.0.1:4789 (Press Ctrl+C to stop)" -ForegroundColor Yellow

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Companion-Token")
    $response.Headers.Add("Content-Type", "application/json")
    $origin = $request.Headers["Origin"]
    if ($origin -and ($allowedOrigins -notcontains $origin)) {
        $response.StatusCode = 403
        $response.Close()
        continue
    }
    if ($origin) {
        $response.Headers.Add("Access-Control-Allow-Origin", $origin)
        $response.Headers.Add("Vary", "Origin")
    }
    if ($request.HttpMethod -eq "OPTIONS") {
        $response.StatusCode = 204
        $response.Close()
        continue
    }
    $protectedPath = @("/execute", "/scan", "/activity") -contains $request.Url.AbsolutePath
    if ($protectedPath -and $request.Headers["X-Companion-Token"] -ne $companionToken) {
        $response.StatusCode = 401
        $response.Close()
        continue
    }
    if ($request.HttpMethod -eq "POST" -and $request.Url.AbsolutePath -eq "/execute") {
        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
        $body = $reader.ReadToEnd() | ConvertFrom-Json
        $cmd = "$($body.command)"
        $approval = Read-Host "Approve this command on this PC? (y/N) $cmd"
        Write-Activity("approval=$approval command=$cmd")
        if ($approval -notmatch '^(?i)y(es)?$') {
            $resObj = @{ success = $false; output = "Command rejected at the companion console."; exitCode = 403 } | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($resObj)
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
            continue
        }
        $env:PATH | Out-File -FilePath "devsetup-path-backup.txt" -Encoding utf8
        Write-Host "Executing approved command: $cmd" -ForegroundColor Cyan
        try {
            if ($cmd -match '(?i)[;&|<>\`$()]') {
                throw "Command contains shell control characters and was blocked."
            }
            $parts = [regex]::Matches($cmd, '"[^"]*"|\S+') | ForEach-Object { $_.Value.Trim('"') }
            $allowedExecutables = @("winget", "pip", "npm", "node", "python", "python3", "gcc", "g++", "javac", "java", "docker", "mysql", "code", "cmake", "mvn")
            if ($parts.Count -lt 1 -or $allowedExecutables -notcontains $parts[0].ToLowerInvariant()) {
                throw "Executable is not in the DevSetup allowlist."
            }
            $commandArgs = if ($parts.Count -gt 1) { @($parts[1..($parts.Count - 1)]) } else { @() }
            $out = & $parts[0] @commandArgs 2>&1 | Out-String
            Write-Activity("result=success command=$cmd")
            $resObj = @{ success = $true; output = $out.Trim(); exitCode = 0 } | ConvertTo-Json
        } catch {
            Write-Activity("result=failure command=$cmd error=$($_.Exception.Message)")
            $resObj = @{ success = $false; output = $_.Exception.Message; exitCode = 1 } | ConvertTo-Json
        }
        $buffer = [System.Text.Encoding]::UTF8.GetBytes($resObj)
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.Close()
        continue
    }
    if ($request.HttpMethod -eq "GET" -and $request.Url.AbsolutePath -eq "/activity") {
        $activity = if (Test-Path $activityPath) { Get-Content $activityPath | Select-Object -Last 100 } else { @() }
        $json = @{ entries = @($activity) } | ConvertTo-Json -Depth 4
    }
    if ($request.HttpMethod -eq "GET" -and $request.Url.AbsolutePath -eq "/scan") {
        $json = Get-ScanJson
    }
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.ContentLength64 = $buffer.Length
    $response.OutputStream.Write($buffer, 0, $buffer.Length)
    $response.Close()
}
`;

app.get('/api/knowledge-base', (_req, res) => {
  res.json(SOFTWARE_KNOWLEDGE_BASE);
});

app.get('/api/companion/script', (req, res) => {
  const format = req.query.format === 'raw' ? 'raw' : 'download';
  if (format === 'raw') {
    res.type('text/plain').send(WINDOWS_COMPANION_PS1);
    return;
  }
  res.setHeader('Content-Disposition', 'attachment; filename="devsetup-companion.ps1"');
  res.type('text/plain').send(WINDOWS_COMPANION_PS1);
});

app.post('/api/agent/analyze', async (req, res) => {
  try {
    const { prompt, assignmentText, assignmentImage, localScan } = req.body as {
      prompt: string;
      assignmentText?: string;
      assignmentImage?: string;
      localScan?: unknown;
    };

    if (!prompt || !prompt.trim()) {
      res.status(400).json({ error: 'Please describe what you want to set up or build.' });
      return;
    }

    const kbSummary = SOFTWARE_KNOWLEDGE_BASE.map(
      (item) =>
        `${item.name}: ${item.recommendedVersion}, install="${item.installCommand}", verify="${item.verifyCommand}"`
    ).join('\n');

    const systemInstruction = `You are DevSetup AI, a universal student software setup and environment engineering agent.
Your job:
1. Understand the student's natural-language request and any uploaded assignment/project text.
2. Identify ONLY the software, languages, compilers, IDEs, databases, and packages actually needed (distinguish mandatory vs optional). If an equivalent tool is ALREADY installed in the local scan (e.g., VS Code is already installed when no specific IDE was named, or conda/pip already satisfies Python), DO NOT recommend downloading a redundant competing tool.
3. Compare against the student's actual local environment scan if provided. If no local scan is provided, set envStatus to "not_scanned" — NEVER invent or fake installed software.
4. Use official software sources and verified commands (winget, pip, npm, or official GUI installers). Never invent download URLs or destructive/unverified shell scripts.
5. Generate a clear, ordered setup plan where system-modifying actions have requiresApproval=true and each step's description explicitly states its system impact (what is installed, modified in PATH, or written to disk).
6. Provide a small, realistic sample test program and exact beginner-friendly run steps, including which editor or terminal menu to open.
7. Include an uninstallCommand for every requirement when a safe official uninstall command is known; otherwise leave it empty.

Reference Knowledge Base:
${kbSummary}`;

    const userContent = [
      `Student Request: ${prompt}`,
      assignmentText ? `Uploaded Assignment / Project Document:\n${assignmentText}` : '',
      localScan
        ? `Actual Local Environment Scan (privacy-filtered):\n${JSON.stringify(sanitizeScanForAi(localScan))}`
        : 'Local Environment Scan: Not yet connected.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const imageMatch = assignmentImage?.match(/^data:(image\/[^;]+);base64,(.+)$/);
    const contents = imageMatch
      ? [
          {
            role: 'user',
            parts: [
              { text: userContent },
              { inlineData: { mimeType: imageMatch[1], data: imageMatch[2] } },
            ],
          },
        ]
      : userContent;

    const response = await generateWithFallback({
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            projectTitle: { type: Type.STRING },
            summary: { type: Type.STRING },
            clarifyingQuestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            requirements: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  category: { type: Type.STRING },
                  requiredVersion: { type: Type.STRING },
                  mandatory: { type: Type.BOOLEAN },
                  purpose: { type: Type.STRING },
                  officialUrl: { type: Type.STRING },
                  installMethod: { type: Type.STRING },
                  installCommand: { type: Type.STRING },
                  verifyCommand: { type: Type.STRING },
                  uninstallCommand: { type: Type.STRING },
                  requiresAdminOrGui: { type: Type.BOOLEAN },
                  envStatus: { type: Type.STRING },
                  detectedVersion: { type: Type.STRING },
                  configSteps: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  'name',
                  'category',
                  'requiredVersion',
                  'mandatory',
                  'purpose',
                  'officialUrl',
                  'installMethod',
                  'installCommand',
                  'verifyCommand',
                  'uninstallCommand',
                  'requiresAdminOrGui',
                  'envStatus',
                ],
              },
            },
            setupPlan: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  stepNumber: { type: Type.INTEGER },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  command: { type: Type.STRING },
                  requiresApproval: { type: Type.BOOLEAN },
                  verifyCommand: { type: Type.STRING },
                },
                required: ['stepNumber', 'title', 'description', 'requiresApproval'],
              },
            },
            sampleProject: {
              type: Type.OBJECT,
              properties: {
                filename: { type: Type.STRING },
                language: { type: Type.STRING },
                code: { type: Type.STRING },
                runCommand: { type: Type.STRING },
                expectedOutput: { type: Type.STRING },
                runSteps: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                whereToRun: { type: Type.STRING },
              },
              required: [
                'filename',
                'language',
                'code',
                'runCommand',
                'expectedOutput',
                'runSteps',
                'whereToRun',
              ],
            },
            nextSteps: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['projectTitle', 'summary', 'requirements', 'setupPlan', 'sampleProject', 'nextSteps'],
        },
        maxOutputTokens: 1800,
        temperature: 0.1,
      },
    });

    const parsed = parseGeneratedJson(response.text);
    if (Array.isArray(parsed.requirements)) {
      parsed.requirements = parsed.requirements.map((requirement: Record<string, unknown>) => {
        const catalogItem = findCatalogItem(requirement.name);
        return {
          ...requirement,
          installCommand: catalogItem?.installCommand || '',
          verifyCommand: catalogItem?.verifyCommand || '',
          officialUrl: catalogItem?.officialUrl || '',
          uninstallCommand: '',
        };
      });
    }
    if (Array.isArray(parsed.setupPlan)) {
      parsed.setupPlan = parsed.setupPlan.map((step: Record<string, unknown>) => ({
        ...step,
        approved: false,
        completed: false,
      }));
    }
    res.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to analyze setup requirements.',
    });

  }
});

app.post('/api/agent/code', async (req, res) => {
  try {
    const { request, language, context, assignmentText } = req.body as {
      request: string;
      language?: string;
      context?: string;
      assignmentText?: string;
    };

    if (!request || !request.trim()) {
      res.status(400).json({ error: 'Describe the code you want to generate.' });
      return;
    }

    const response = await generateWithFallback({
      contents: [
        `Generate a complete beginner-friendly program for: ${request.trim()}`,
        language ? `Required language: ${language}` : '',
        context ? `Additional context: ${context}` : '',
        assignmentText ? `Assignment to solve completely:\n${assignmentText.slice(0, 20000)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      config: {
        systemInstruction:
          'Solve the requested assignment completely when an assignment is provided. Include clear explanations of how the solution works, important decisions, and safe runnable code. Prefer standard library code and never include destructive commands.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            language: { type: Type.STRING },
            filename: { type: Type.STRING },
            explanation: { type: Type.STRING },
            walkthrough: { type: Type.ARRAY, items: { type: Type.STRING } },
            code: { type: Type.STRING },
            runCommand: { type: Type.STRING },
            runSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
            expectedOutput: { type: Type.STRING },
          },
          required: [
            'title',
            'language',
            'filename',
            'explanation',
            'walkthrough',
            'code',
            'runCommand',
            'runSteps',
            'expectedOutput',
          ],
        },
        maxOutputTokens: 1600,
        temperature: 0.1,
      },
    });

    res.json(parseGeneratedJson(response.text));
  } catch (err) {
    console.error('Code generation error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to generate code.',
    });
  }
});

app.post('/api/agent/troubleshoot', async (req, res) => {
  try {
    const { errorOutput, context, localScan } = req.body as {
      errorOutput: string;
      context?: string;
      localScan?: unknown;
    };

    if (!errorOutput || !errorOutput.trim()) {
      res.status(400).json({ error: 'Please paste the terminal or compiler error output.' });
      return;
    }

    const systemInstruction = `You are DevSetup AI's Intelligent Troubleshooting Engine.
Analyze the student's actual terminal/IDE error output, classify it, explain the root cause in beginner-friendly language, recommend a safe fix, list exact commands that require user approval, and provide a verification command to confirm the fix worked.`;

    const userContent = [
      `Error Output:\n${errorOutput}`,
      context ? `What the student was trying to do: ${context}` : '',
      localScan ? `Local Environment Scan:\n${JSON.stringify(localScan)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await generateWithFallback({
      contents: userContent,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            classification: { type: Type.STRING },
            severity: { type: Type.STRING },
            plainEnglishCause: { type: Type.STRING },
            recommendedFix: { type: Type.STRING },
            proposedCommands: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING },
                  command: { type: Type.STRING },
                  requiresApproval: { type: Type.BOOLEAN },
                },
                required: ['label', 'command', 'requiresApproval'],
              },
            },
            verifyCommand: { type: Type.STRING },
            preventionTip: { type: Type.STRING },
          },
          required: [
            'classification',
            'severity',
            'plainEnglishCause',
            'recommendedFix',
            'proposedCommands',
            'verifyCommand',
            'preventionTip',
          ],
        },
      },
    });

    const parsed = parseGeneratedJson(response.text);
    res.json(parsed);
  } catch (err) {
    console.error('Troubleshoot error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to analyze error output.',
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'devsetup-ai',
    aiProvider: pruneApiKey ? 'prune' : geminiApiKey ? 'gemini' : 'unconfigured',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/usage', (_req, res) => {
  res.json({
    provider: pruneApiKey ? 'prune' : 'gemini',
    requests: pruneUsage.requests,
    cacheHits: pruneUsage.cacheHits,
    lastMetadata: pruneUsage.lastMetadata,
  });
});

function buildKbFallbackReply(userMessage: string): string {
  const lower = userMessage.toLowerCase();
  const matches = SOFTWARE_KNOWLEDGE_BASE.filter(
    (item) =>
      lower.includes(item.id.toLowerCase()) ||
      lower.includes(item.name.toLowerCase()) ||
      item.name
        .toLowerCase()
        .split(/[\s/+()-]+/)
        .some((word) => word.length > 2 && lower.includes(word))
  );

  const selected = matches.length > 0 ? matches.slice(0, 4) : SOFTWARE_KNOWLEDGE_BASE.slice(0, 3);
  const lines = selected.map(
    (item) =>
      `### ${item.name} (${item.recommendedVersion})\n- **Install**: \`${item.installCommand || 'See official installer'}\`\n- **Verify**: \`${item.verifyCommand}\`\n- **Official Source**: ${item.officialUrl}\n- **Note**: ${item.notes}`
  );

  return `## DevSetup AI — Recommended Environment Setup\n\n${lines.join('\n\n')}\n\n> Run \`devsetup-companion.ps1\` locally to auto-scan your PC and execute approved commands safely.`;
}

// --- Synced Local Scan & Generated Setup Artifacts ---
const DEVSETUP_SCAN_FILE = path.resolve(process.cwd(), '.devsetup-scan.json');
let latestSyncedScan: Record<string, unknown> | null = null;

try {
  if (fs.existsSync(DEVSETUP_SCAN_FILE)) {
    latestSyncedScan = JSON.parse(fs.readFileSync(DEVSETUP_SCAN_FILE, 'utf8'));
  }
} catch {
  latestSyncedScan = null;
}

const generatedArtifacts = new Map<string, Record<string, { content: string; contentType: string }>>();

app.post('/api/companion/sync-scan', (req, res) => {
  const scan = req.body;
  if (!scan || typeof scan !== 'object' || !Array.isArray(scan.tools)) {
    res.status(400).json({ ok: false, error: 'Invalid scan payload.' });
    return;
  }
  latestSyncedScan = scan as Record<string, unknown>;
  try {
    fs.writeFileSync(DEVSETUP_SCAN_FILE, JSON.stringify(latestSyncedScan), 'utf8');
  } catch {
    // ignore read-only fs
  }
  res.json({ ok: true, hostname: scan.hostname || 'local-pc', toolsCount: scan.tools.length });
});

app.get('/api/companion/sync-scan', (_req, res) => {
  res.json({ synced: Boolean(latestSyncedScan), scan: latestSyncedScan });
});

app.get('/api/artifacts/:id/:filename', (req, res) => {
  const bundle = generatedArtifacts.get(req.params.id);
  const file = bundle?.[req.params.filename];
  if (!file) {
    res.status(404).send('Artifact not found or expired.');
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.type(file.contentType).send(file.content);
});

function buildPowerShellSetupScript(
  projectTitle: string,
  requirements: Array<{
    name: string;
    mandatory: boolean;
    installCommand: string;
    verifyCommand: string;
    envStatus: string;
  }>,
  sampleProject?: { filename: string; code: string; runCommand: string }
): string {
  const lines: string[] = [
    `# DevSetup AI - Automated Environment Setup & Verification Script`,
    `# Project: ${projectTitle}`,
    `# Generated: ${new Date().toISOString()}`,
    `$ErrorActionPreference = "Continue"`,
    `Write-Host "=== DevSetup AI: ${projectTitle} ===" -ForegroundColor Cyan`,
    ``,
  ];

  for (const req of requirements) {
    const catalogItem = findCatalogItem(req.name);
    const trustedCommand = catalogItem?.installCommand || '';
    if (req.envStatus === 'installed') {
      lines.push(`Write-Host "[OK] ${req.name} already installed." -ForegroundColor Green`);
      continue;
    }
    if (!trustedCommand) {
      lines.push(`Write-Host "[SKIP] ${req.name} is not in the verified software catalog." -ForegroundColor Red`);
      continue;
    }
    lines.push(`# ${req.mandatory ? 'Mandatory' : 'Optional'}: ${req.name}`);
    lines.push(`$ans = Read-Host "Install ${req.name} using '${trustedCommand}'? (Y/n)"`);
    lines.push(`if ($ans -eq "" -or $ans -match "^[Yy]") {`);
    lines.push(`    Write-Host "Installing ${req.name}..." -ForegroundColor Yellow`);
    lines.push(`    ${trustedCommand}`);
    lines.push(`}`);
    lines.push(``);
  }

  if (sampleProject?.filename && sampleProject?.code) {
    const b64 = Buffer.from(sampleProject.code, 'utf8').toString('base64');
    lines.push(`# Create & Run Verification Sample Program`);
    lines.push(`$samplePath = Join-Path (Get-Location) "${sampleProject.filename}"`);
    lines.push(`[System.IO.File]::WriteAllBytes($samplePath, [System.Convert]::FromBase64String("${b64}"))`);
    lines.push(`Write-Host "Created sample file: $samplePath" -ForegroundColor Cyan`);
    lines.push(`Write-Host "Running verification: ${sampleProject.runCommand}" -ForegroundColor Yellow`);
    lines.push(`${sampleProject.runCommand}`);
  }

  return lines.join('\n');
}

async function startServer() {
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error.' });
      return;
    }
    next(err);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DevSetup AI server running on http://localhost:${PORT}`);
  });
}

startServer();
