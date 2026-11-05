# Dakort

Claude Code and Codex on your phone, from anywhere, with your real sessions.

Dakort is a small server you run on your own computer. It shows the
sessions you already have in the terminal, lets you read what the agent
did while you were away, send the next message, allow or refuse what it
asks permission for, open the files it wrote (PDFs, Word documents, code),
and keep several projects going at once. Your phone reaches it over your
own Tailscale network; nothing is exposed to the internet.

The name is Albanian for "agreed", from the French d'accord. Half of what
you do in it is tap Allow.

## Install

Coming with the first release:

```
brew install dakort-app/tap/dakort     # macOS
winget install dakort                  # Windows
scoop install dakort                   # Windows, alternatively
apt install ./dakort_*.deb             # Debian and Ubuntu, from the release page
```

Then, once:

```
dakort setup
```

That installs it as a background service that runs at boot, finds the
Claude Code and Codex CLIs, shows the address for your phone as a QR code,
and opens the page, which asks you to choose a password.
`dakort setup -uninstall` removes the service.

When a newer release is out, the page says so. Then, on the computer:

```
dakort update
```

It fetches the release, checks it, and restarts the service with it once
nothing is running. (After an update through brew, winget or scoop, run
`dakort setup` again instead; it does the same hand-over with the new
binary.)

## What it needs

- [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex),
  installed and signed in. Dakort drives the real CLIs; it is not an agent
  of its own.
- [Tailscale](https://tailscale.com) on the computer and the phone, to
  reach it from outside the house. Without it, Dakort listens on the
  computer only.

## Building from source

Go 1.27 and Node 22.

```
cd web && npm ci && npm run build && cd ..
go build ./cmd/dakort
```

## License

MIT.
