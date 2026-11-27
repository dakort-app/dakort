// commandLabel turns a shell command into a few plain words for its row
// ("Run Go tests", "Commit and push", "Look at files"), for the calls that
// came without Claude's own description. A row never shows the command
// itself until it is opened. The weightiest step names the whole line: a
// build or a test over the `cd` and `ls` around it.

type Rule = [rank: number, test: RegExp, label: string]

// git and its options before the subcommand (-C dir, -c key=value, -q).
const git = (sub: string) => new RegExp(String.raw`^git\s+((-[Cc]\s+\S+|-{1,2}[\w-]+(=\S+)?)\s+)*` + sub)

// Matched against each step of the command (split on &&, ||, ;, | and
// new lines), its leading `cd`, `env` and VAR=value words dropped.
const rules: Rule[] = [
  [90, git(String.raw`commit\b`), 'Commit changes'],
  [88, git(String.raw`push\b`), 'Push commits'],
  [86, /^(npx\s+|npm\s+exec\s+)?playwright\s+test\b/, 'Run browser checks'],
  [85, /^go\s+test\b/, 'Run Go tests'],
  [85, /^((npx|pnpm|yarn)\s+)?(vitest|jest)\b|^(npm|pnpm|yarn)\s+(run\s+)?test\b/, 'Run unit tests'],
  [85, /^(python3?\s+-m\s+)?pytest\b/, 'Run Python tests'],
  [85, /^cargo\s+test\b/, 'Run Rust tests'],
  [80, /^((npx|pnpm|yarn)\s+)?vite\s+build\b|^(npm|pnpm|yarn)\s+run\s+build\b/, 'Build the UI'],
  [80, /^go\s+build\b/, 'Build the Go code'],
  [80, /^cargo\s+build\b|^make\b/, 'Build the code'],
  [78, /^((npx|pnpm|yarn)\s+)?tsc\b/, 'Check types'],
  [75, /^(npm|pnpm|yarn)\s+(install|ci|add|i)\b|^(pip3?|uv)\s+(install|add|sync)\b|^brew\s+install\b/, 'Install packages'],
  [72, git(String.raw`(pull|fetch|merge|rebase|checkout|switch|reset|stash|cherry-pick|revert|branch|tag)\b`), 'Run git commands'],
  [70, git(String.raw`(status|diff|log|show|blame|ls-files|rev-parse|merge-base)\b`), 'Look at git changes'],
  [68, /^git\b/, 'Run git commands'],
  [66, /^gh\b/, 'Use GitHub'],
  [64, /^(docker|docker-compose|podman)\b/, 'Run Docker'],
  [62, /^(go\s+(vet|fmt|mod|run|generate)|gofmt)\b/, 'Run Go tools'],
  [60, /^(npm|pnpm|yarn)\s+run\b|^npx\b/, 'Run a project script'],
  [58, /^(python3?|node|deno|bun|ruby|perl|bash|sh|zsh|\.\/|uv\s+run)\b/, 'Run a script'],
  [56, /^(curl|wget|http)\b/, 'Fetch from the web'],
  [54, /^(rm|rmdir|trash)\b/, 'Delete files'],
  [52, /^(mkdir|cp|mv|touch|ln|chmod|tar|unzip|zip)\b/, 'Change files'],
  [50, /^(kill|pkill|killall|taskkill|lsof|ps|pgrep|netstat)\b/, 'Check processes'],
  [40, /^(ls|cat|head|tail|less|grep|rg|ag|find|fd|wc|tree|file|stat|du|df|sed|awk|sort|uniq|diff|cut|jq|readlink|realpath|which|type|Get-ChildItem|Get-Content|Select-String)\b/, 'Look at files'],
  [20, /^(sleep|wait)\b/, 'Wait'],
]

export function commandLabel(command: string): string {
  let best: Rule | undefined
  const seen = new Set<string>()
  for (let step of command.split(/&&|\|\||[;|\n]/)) {
    step = step.trim().replace(/^[({]\s*/, '')
    // Words that set up the step rather than do it.
    step = step.replace(/^((env|sudo|time|nohup|exec|command)\s+|[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/, '')
    if (!step || /^(cd|pushd|popd|set|export|source|\.|echo|printf|true|false|:)\b/.test(step)) continue
    const r = rules.find(([, re]) => re.test(step))
    if (!r) continue
    seen.add(r[2])
    if (!best || r[0] > best[0]) best = r
  }
  if (seen.has('Commit changes') && seen.has('Push commits')) return 'Commit and push'
  return best?.[2] ?? 'Run a command'
}
