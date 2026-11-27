import { ArrowDownIcon as LArrowDown, ArrowLeftIcon as LArrowLeft, ArrowRightIcon as LArrowRight, ArrowUpIcon as LArrowUp, BotIcon as LBot, BoxIcon as LBox, BracesIcon as LBraces, CheckIcon as LCheck, ChevronDownIcon as LChevronDown, ChevronLeftIcon as LChevronLeft, ChevronRightIcon as LChevronRight, ChevronUpIcon as LChevronUp, CircleXIcon as LCircleX, ClipboardIcon as LClipboard, ClockIcon as LClock, CodeIcon as LCode, Columns2Icon as LColumns2, CopyIcon as LCopy, CornerDownLeftIcon as LCornerDownLeft, CrosshairIcon as LCrosshair, DownloadIcon as LDownload, EllipsisIcon as LEllipsis, ExternalLinkIcon as LExternalLink, EyeIcon as LEye, FileDiffIcon as LFileDiff, FilesIcon as LFiles, FolderIcon as LFolder, FolderPlusIcon as LFolderPlus, GitBranchIcon as LGitBranch, GlobeIcon as LGlobe, HistoryIcon as LHistory, ImageIcon as LImage, InfoIcon as LInfo, KeyboardOffIcon as LKeyboardOff, MinusIcon as LMinus, MoonIcon as LMoon, PanelLeftIcon as LPanelLeft, PanelRightCloseIcon as LPanelRightClose, PencilIcon as LPencil, PlusIcon as LPlus, QrCodeIcon as LQrCode, RefreshCwIcon as LRefreshCw, SearchIcon as LSearch, SquareIcon as LSquare, SquarePenIcon as LSquarePen, SquareTerminalIcon as LSquareTerminal, SunIcon as LSun, TableIcon as LTable, TextSelectIcon as LTextSelect, Trash2Icon as LTrash2, TriangleAlertIcon as LTriangleAlert, TypeIcon as LType, Undo2Icon as LUndo2, UnfoldHorizontalIcon as LUnfoldHorizontal, UnfoldVerticalIcon as LUnfoldVertical, XIcon as LX, SettingsIcon as LSettings, ArrowDownWideNarrowIcon as LArrowDownWideNarrow, CopyMinusIcon as LCopyMinus, type LucideIcon } from 'lucide-react'
import { brandIcons, fileIcons } from 'virtual:icons'
import { fileIconName, GENERIC } from './fileicons'
import { ICON_STROKE } from './iconpaths'

// One icon set: Lucide, from lucide-react (the views built as markup take
// the same icons from the lucide package, iconpaths.ts). One stroke for
// every icon, 1.75 on Lucide's 24 grid: 1.17 px at 16 px, about the stem of
// the 13 px text beside it, so icons and labels weigh the same (Lucide's
// own 2 reads heavier than the text; 1.5 is a hairline at 14). index.css
// sets the same stroke on the icons inside shadcn's components. Sizes come
// from the CSS (.i, .i-sm): 16 px in buttons and rows, 14 in dense rows
// and marks, a step up on touch. File types and the agents' marks come
// from open sets (see vite.config.ts) and keep their own drawing. e2e:
// every icon has this stroke.

export { ICON_STROKE, iconHTML } from './iconpaths'

const set = {
  "panel-left": LPanelLeft,
  folder: LFolder,
  box: LBox,
  "folder-plus": LFolderPlus,
  history: LHistory,
  x: LX,
  "trash-2": LTrash2,
  pencil: LPencil,
  "square-terminal": LSquareTerminal,
  search: LSearch,
  copy: LCopy,
  "square-pen": LSquarePen,
  "columns-2": LColumns2,
  "panel-right-close": LPanelRightClose,
  moon: LMoon,
  sun: LSun,
  "arrow-down": LArrowDown,
  "refresh-cw": LRefreshCw,
  plus: LPlus,
  ellipsis: LEllipsis,
  info: LInfo,
  "qr-code": LQrCode,
  globe: LGlobe,
  code: LCode,
  eye: LEye,
  table: LTable,
  image: LImage,
  "undo-2": LUndo2,
  download: LDownload,
  "unfold-vertical": LUnfoldVertical,
  "unfold-horizontal": LUnfoldHorizontal,
  "external-link": LExternalLink,
  crosshair: LCrosshair,
  "arrow-up": LArrowUp,
  square: LSquare,
  "triangle-alert": LTriangleAlert,
  "corner-down-left": LCornerDownLeft,
  clock: LClock,
  check: LCheck,
  minus: LMinus,
  "chevron-up": LChevronUp,
  "git-branch": LGitBranch,
  "file-diff": LFileDiff,
  files: LFiles,
  "chevron-down": LChevronDown,
  "chevron-left": LChevronLeft,
  "chevron-right": LChevronRight,
  "circle-x": LCircleX,
  braces: LBraces,
  bot: LBot,
  "keyboard-off": LKeyboardOff,
  clipboard: LClipboard,
  "arrow-left": LArrowLeft,
  "arrow-right": LArrowRight,
  "text-select": LTextSelect,
  type: LType,
  settings: LSettings,
  "arrow-down-wide-narrow": LArrowDownWideNarrow,
  "copy-minus": LCopyMinus,
} satisfies Record<string, LucideIcon>
export type IconName = keyof typeof set

// sm: the dense size (tab ×, tree carets, status marks). fill: a solid
// glyph drawn from the same outline (Stop's square).
export const Icon = ({ name, sm, fill, className }: { name: IconName; sm?: boolean; fill?: boolean; className?: string }) => {
  const L = set[name]
  return (
    <L
      className={'i' + (sm ? ' i-sm' : '') + (fill ? ' i-fill' : '') + (className ? ' ' + className : '')}
      size={sm ? 14 : 16}
      strokeWidth={ICON_STROKE}
      aria-hidden="true"
    />
  )
}

type P = { sm?: boolean }
const named = (name: IconName) => ({ sm }: P) => <Icon name={name} sm={sm} />

export const SidebarIcon = named('panel-left')
export const FolderIcon = ({ sm }: P) => <Icon name="folder" sm={sm} className="folder-icon" />
// A project, wherever projects are listed (the sidebar, Open project,
// home): its own quiet mark, so it never reads as a folder of the tree.
export const ProjectIcon = ({ sm }: P) => <Icon name="box" sm={sm} className="project-icon" />
// Changes, wherever they are named (the activity bar, a phone's sheet):
// a file's diff, not git's branch, since Dakort shows changes and does no
// source control. The branch glyph stays beside the branch's name.
export const ChangesIcon = named('file-diff')
export const HistoryIcon = named('history')
export const CloseIcon = named('x')
export const TrashIcon = named('trash-2')
export const PencilIcon = named('pencil')
export const TerminalIcon = named('square-terminal')
// A git branch, beside a repository's branch name.
export const BranchIcon = named('git-branch')
export const FilesIcon = named('files')
export const ChevronDownIcon = named('chevron-down')
export const SearchIcon = named('search')
export const CopyIcon = named('copy')
export const CheckIcon = named('check')
export const NewChatIcon = named('square-pen')
export const SplitIcon = named('columns-2')
export const UnsplitIcon = named('panel-right-close')
// The theme switch shows what a tap gives: the moon in light, the sun in dark.
export const MoonIcon = named('moon')
export const SunIcon = named('sun')
export const PlusIcon = named('plus')
export const MoreIcon = named('ellipsis')
export const InfoIcon = named('info')
// Other devices: a QR code, which is what the panel behind it shows.
export const DevicesIcon = named('qr-code')
export const SettingsIcon = named('settings')
export const SortIcon = named('arrow-down-wide-narrow')
export const CollapseAllIcon = named("copy-minus")
// The browser: on the model chip while a session has Chrome on.
export const GlobeIcon = () => <Icon name="globe" sm />

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
