import { brandIcons, fileIcons } from 'virtual:icons'
import { fileIconName, GENERIC } from './fileicons'

// A few line icons, drawn here rather than taken from an icon set; file
// types and the agents' marks come from open sets (see vite.config.ts;
// from a contributor's branch).

const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

// The side panel, as in VS Code's "toggle primary side bar".
export const SidebarIcon = () => (
  <svg {...base} aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
)

// A folder, so folders read as folders next to files.
export const FolderIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...base} width={size} height={size} className="folder-icon" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

export const HistoryIcon = () => (
  <svg {...base} aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
)

// Copy: two overlapping pages. Check: done.
export const CopyIcon = () => (
  <svg {...base} width={16} height={16} aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </svg>
)

export const CheckIcon = () => (
  <svg {...base} width={16} height={16} aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)

export const NewChatIcon = () => (
  <svg {...base} aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-3.1-6.3" />
    <path d="M12 8.5v7M8.5 12h7" />
  </svg>
)

export const SplitIcon = () => (
  <svg {...base} aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
)

export const UnsplitIcon = () => (
  <svg {...base} aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" strokeDasharray="2 2.5" />
    <path d="M14.5 12h4M16.5 10l2 2-2 2" />
  </svg>
)

// The theme switch shows what a tap gives: the moon in light, the sun in
// dark. Drawn, not the ☾ and ☼ characters, which each font shapes its own
// way (a thin crescent in Segoe UI) and none matched the icons beside them.
export const MoonIcon = () => (
  <svg {...base} aria-hidden="true">
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />
  </svg>
)

export const SunIcon = () => (
  <svg {...base} aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </svg>
)

// Open a project: a plus, the same weight as the icons beside it.
export const PlusIcon = () => (
  <svg {...base} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

// The browser: on the model chip while a session has Chrome on.
export const GlobeIcon = () => (
  <svg {...base} width={13} height={13} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" />
  </svg>
)

type Svg = { body: string; box: string }
// The sets' SVG bodies come from the build (vite.config.ts), not from users.
const Raw = ({ icon, size, className }: { icon: Svg; size: number; className: string }) => (
  <svg className={className} width={size} height={size} viewBox={icon.box} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon.body }} />
)

// A file's type, as in VS Code's Material Icon Theme.
export const FileIcon = ({ path, size = 16 }: { path: string; size?: number }) => (
  <Raw icon={fileIcons[fileIconName(path)] ?? fileIcons[GENERIC]} size={size} className="file-icon" />
)

// The agent a session runs: Claude's mark, or OpenAI's for Codex, both in
// Claude's orange so sessions stand apart from files.
export const AgentIcon = ({ provider, size = 14 }: { provider?: string; size?: number }) => (
  <Raw icon={provider === 'codex' ? brandIcons.openai : brandIcons.claude} size={size} className={'agent-icon ' + (provider === 'codex' ? 'codex' : 'claude')} />
)
