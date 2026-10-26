/** Raised when this computer cannot show a native folder dialog (no GUI session, no `zenity`, and so on). */
export class FolderPickerUnavailableError extends Error {}

const PROMPT = 'Pilih direktori workspace agent'
const TIMEOUT_MS = 300_000
const UNAVAILABLE = 'Pemilih folder tidak tersedia di komputer server ini. Ketik path folder secara manual.'

function command(): string[] {
  if (process.platform === 'darwin') {
    // `tell me to activate` brings the dialog in front of the browser without needing any Automation permission.
    return ['osascript', '-e', 'tell me to activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}")`]
  }
  if (process.platform === 'win32') {
    return ['powershell', '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${PROMPT}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`]
  }
  return ['zenity', '--file-selection', '--directory', `--title=${PROMPT}`]
}

function launch(signal: AbortSignal) {
  try {
    return Bun.spawn(command(), { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', signal })
  } catch {
    throw new FolderPickerUnavailableError(UNAVAILABLE)
  }
}

/**
 * Opens the operating system's own folder dialog on the machine that runs this server (the app is single-user and
 * loopback-only, so that is the user's screen). Resolves to the chosen path, or null when the dialog is cancelled or
 * the request is aborted.
 */
export async function pickFolder(signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null
  const stop = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
  const child = launch(stop)
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (stop.aborted) return null
  const chosen = output.trim()
  if (code === 0) return chosen ? chosen.replace(/(.)\/+$/, '$1') : null
  // macOS reports a cancelled dialog as error -128; zenity exits 1 with no message.
  if (errors.includes('(-128)') || (!errors.trim() && code === 1)) return null
  throw new FolderPickerUnavailableError(UNAVAILABLE)
}
