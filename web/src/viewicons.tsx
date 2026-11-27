// The file views' toolbar icons: the same set and stroke as icons.tsx.
// Each button names itself in aria-label and its tip.
import { Icon } from './icons'

export { PlusIcon, CloseIcon } from './icons'
export const EditIcon = () => <Icon name="pencil" />
export const SourceIcon = () => <Icon name="code" />
export const PreviewIcon = () => <Icon name="eye" />
export const TableIcon = () => <Icon name="table" />
export const PictureIcon = () => <Icon name="image" />
export const RevertIcon = () => <Icon name="undo-2" />
export const DownloadIcon = () => <Icon name="download" />
export const FindIcon = () => <Icon name="search" />
// What changed since the last commit: a page with a plus over a minus.
export const DiffIcon = () => <Icon name="file-diff" />
export const MinusIcon = () => <Icon name="minus" />
// Fit the page (arrows to top and bottom) or the width (to the sides).
export const FitPageIcon = () => <Icon name="unfold-vertical" />
export const FitWidthIcon = () => <Icon name="unfold-horizontal" />
export const OpenIcon = () => <Icon name="external-link" />
export const SyncIcon = () => <Icon name="crosshair" />
export const UpIcon = () => <Icon name="chevron-up" />
export const DownIcon = () => <Icon name="chevron-down" />
// flip: pointing left (a tab row's arrow to the tabs before). A tree's
// caret is the dense size.
export const ChevronIcon = ({ flip, sm }: { flip?: boolean; sm?: boolean }) => <Icon name={flip ? 'chevron-left' : 'chevron-right'} sm={sm} />
