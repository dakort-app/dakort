// Claude Code's built-in commands that do nothing useful here. Dakort runs
// the CLI headless, one process per turn: these open the terminal's own
// screens or set something for that one process, so sent as a prompt the
// turn hangs on "Sending..." or ends silent. People type them from habit,
// so the composer answers them instead of sending (the "/" menu already
// leaves them out; commands.go keeps the ones measured to work).
const instead: Record<string, string> = {
  model: 'Pick the model with the model chip under the box.',
  effort: 'Set the effort in the model chip under the box.',
  fast: 'Pick the model with the model chip under the box.',
  permissions: 'Pick the mode with the mode chip under the box.',
  'allowed-tools': 'Pick the mode with the mode chip under the box.',
  clear: 'Start a new session with New session.',
  reset: 'Start a new session with New session.',
  new: 'Start a new session with New session.',
  resume: 'Open an earlier session from History.',
  continue: 'Open an earlier session from History.',
  exit: 'Close the tab instead.',
  quit: 'Close the tab instead.',
}

const terminalOnly = new Set([
  'config',
  'settings',
  'mcp',
  'login',
  'logout',
  'help',
  'agents',
  'hooks',
  'memory',
  'ide',
  'theme',
  'vim',
  'terminal-setup',
  'status',
  'statusline',
  'doctor',
  'add-dir',
  'export',
  'bug',
  'feedback',
  'plugin',
  'plugins',
  'output-style',
  'privacy-settings',
  'upgrade',
  'release-notes',
  'install-github-app',
  'rewind',
  'checkpoint',
  'todos',
  'tasks',
  'bashes',
  'sandbox',
])

// slashBlock says why a typed message is not sent, or '' to send it. Only
// a message that is the command alone or the command and its arguments
// counts; known lets a skill or custom command of the same name through.
export function slashBlock(text: string, known: (name: string) => boolean = () => false): string {
  const m = /^\/([a-z][a-z-]*)(\s|$)/.exec(text.trim())
  if (!m || known(m[1])) return ''
  const name = m[1]
  if (instead[name]) return `/${name} does not work in Dakort. ${instead[name]}`
  if (terminalOnly.has(name)) return `/${name} opens a screen in the terminal's Claude Code, which Dakort cannot show. Run it in a terminal.`
  return ''
}
