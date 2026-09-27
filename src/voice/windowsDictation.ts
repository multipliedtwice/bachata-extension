import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const speechScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $engine.SetInputToDefaultAudioDevice()
  [Console]::WriteLine('READY')
  while ($true) {
    $result = $engine.Recognize([TimeSpan]::FromSeconds(3))
    if ($null -ne $result -and -not [string]::IsNullOrWhiteSpace($result.Text)) {
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result.Text))
      [Console]::WriteLine('TEXT:' + $encoded)
    }
  }
} catch {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
  [Console]::WriteLine('ERROR:' + $encoded)
  exit 1
} finally {
  if ($null -ne $engine) { $engine.Dispose() }
}
`;

export type DictationStatus = "listening" | "stopped" | "error";

export const startWindowsDictation = (
  onText: (text: string) => void,
  onStatus: (status: DictationStatus, detail?: string) => void,
): { stop: () => void } => {
  if (process.platform !== "win32") {
    throw new Error("Local voice input is available on Windows only");
  }
  const command = Buffer.from(speechScript, "utf16le").toString("base64");
  const child: ChildProcessWithoutNullStreams = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", command],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stopped = false;
  let reportedError = false;
  let ready = false;
  let buffer = "";
  const startupTimeout = setTimeout(() => {
    if (stopped || ready) return;
    reportedError = true;
    onStatus("error", "The speech recognizer did not start within 45 seconds");
    child.kill();
  }, 45_000);
  const reportLine = (line: string): void => {
    if (stopped) return;
    if (line === "READY") {
      ready = true;
      clearTimeout(startupTimeout);
      onStatus("listening");
    } else if (line.startsWith("TEXT:")) {
      try {
        const text = Buffer.from(line.slice(5), "base64").toString("utf8").trim();
        if (text) onText(text);
      } catch { /* A malformed recognizer line does not change the draft. */ }
    } else if (line.startsWith("ERROR:")) {
      reportedError = true;
      onStatus("error", Buffer.from(line.slice(6), "base64").toString("utf8"));
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 16_384) buffer = buffer.slice(-16_384);
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      reportLine(buffer.slice(0, boundary).trim());
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
    }
  });
  child.on("error", (error) => {
    clearTimeout(startupTimeout);
    if (!stopped) {
      reportedError = true;
      onStatus("error", error.message);
    }
  });
  child.on("exit", (code) => {
    clearTimeout(startupTimeout);
    if (stopped || reportedError) return;
    if (code !== 0) onStatus("error", "Speech recognition stopped unexpectedly");
    else onStatus("stopped");
  });
  return { stop: () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimeout);
    child.kill();
    onStatus("stopped");
  } };
};
