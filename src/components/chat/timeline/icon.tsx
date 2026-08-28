import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AlignJustify,
  Bot,
  BookOpen,
  Brain,
  Check,
  Circle,
  SquareCode,
  ClipboardList,
  ListTree,
  Clock,
  Columns2,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FilePen,
  FileSearch,
  FileText,
  FileVideo,
  Folder,
  GitBranch,
  Globe,
  Hourglass,
  Info,
  List,
  ListChecks,
  ListTodo,
  Pencil,
  Search,
  SquareCheck,
  SquareTerminal,
  TriangleAlert,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Layers,
  LoaderCircle,
  Undo2,
  X,
  Wrench,
  MessageSquarePlus,
  Minus,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ScanSearch,
  WrapText,
  CircleHelp,
  CircleX,
  CircleDot,
  CircleCheckBig,
  ChevronsUp,
  MessageCircle,
  RotateCcw,
  type LucideProps,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Icon names used by the ported chat/markdown components (upstream names). */
export type IconName =
  | 'file-copy'
  | 'check'
  | 'download'
  | 'add'
  | 'subtract'
  | 'refresh'
  | 'text-wrap'
  | 'file-image'
  | 'pencil'
  | 'file-edit'
  | 'file-text'
  | 'terminal-box'
  | 'folder-6'
  | 'menu-search'
  | 'file-search'
  | 'global'
  | 'list-check-3'
  | 'list-check-2'
  | 'book'
  | 'ai-agent'
  | 'brain-4'
  | 'survey'
  | 'scan-2'
  | 'file-list-2'
  | 'task'
  | 'git-branch'
  | 'tools'
  | 'align-justify'
  | 'layout-column'
  // MessageBody additions:
  | 'time'
  | 'arrow-go-back'
  | 'pushpin-2'
  | 'pushpin-2-fill'
  | 'brain-ai-3'
  | 'hourglass'
  | 'information'
  | 'error-warning'
  | 'chat-new'
  // ToolOutputDialog additions:
  | 'pencil-ai'
  | 'file-pdf'
  | 'search'
  | 'arrow-left-s'
  | 'arrow-right-s'
  | 'close'
  | 'loader-4'
  | 'arrow-up-s'
  | 'arrow-down-s'
  | 'stack'
  // Nearest lucide equivalents for upstream Remixicons:
  | 'list-unordered'
  | 'node-tree'
  | 'code-box'
  | 'question'
  | 'edit'
  | 'close-circle'
  | 'record-circle'
  | 'checkbox-circle'
  | 'arrow-up-double'
  | 'chat-3'
  | 'restart';

const ICON_REGISTRY: Record<IconName, React.ComponentType<LucideProps>> = {
  'file-copy': Copy,
  check: Check,
  download: Download,
  add: Plus,
  subtract: Minus,
  refresh: RefreshCw,
  'text-wrap': WrapText,
  'file-image': FileImage,
  // Nearest lucide equivalents for upstream Remixicons:
  pencil: Pencil,
  'file-edit': FilePen,
  'file-text': FileText,
  'terminal-box': SquareTerminal,
  'folder-6': Folder,
  'menu-search': Search,
  'file-search': FileSearch,
  global: Globe,
  'list-check-3': ListChecks,
  'list-check-2': ListTodo,
  book: BookOpen,
  'ai-agent': Bot,
  'brain-4': Brain,
  survey: ClipboardList,
  'scan-2': ScanSearch,
  'file-list-2': List,
  task: SquareCheck,
  'git-branch': GitBranch,
  tools: Wrench,
  'align-justify': AlignJustify,
  'layout-column': Columns2,
  // MessageBody additions — nearest lucide equivalents for upstream Remixicons:
  time: Clock,
  'arrow-go-back': Undo2,
  'pushpin-2': Pin,
  'pushpin-2-fill': PinOff,
  'brain-ai-3': Brain,
  hourglass: Hourglass,
  information: Info,
  'error-warning': TriangleAlert,
  'chat-new': MessageSquarePlus,
  // ToolOutputDialog additions — nearest lucide equivalents for upstream Remixicons:
  'pencil-ai': Pencil,
  'file-pdf': FileText,
  search: Search,
  'arrow-left-s': ChevronLeft,
  'arrow-right-s': ChevronRight,
  close: X,
  'loader-4': LoaderCircle,
  'arrow-up-s': ChevronUp,
  'arrow-down-s': ChevronDown,
  stack: Layers,
  'list-unordered': List,
  'node-tree': ListTree,
  'code-box': SquareCode,
  question: CircleHelp,
  edit: Pencil,
  'close-circle': CircleX,
  'record-circle': CircleDot,
  'checkbox-circle': CircleCheckBig,
  'arrow-up-double': ChevronsUp,
  'chat-3': MessageCircle,
  restart: RotateCcw,
};

export interface IconProps extends Omit<LucideProps, 'name'> {
  name: string;
}

/** Upstream `<Icon name=...>` shim. Unknown names render a neutral circle. */
export function Icon({ name, className, size, ...props }: IconProps) {
  const Component = (name in ICON_REGISTRY ? ICON_REGISTRY[name as IconName] : undefined) ?? Circle;
  return <Component aria-hidden="true" className={cn(className)} size={size} {...props} />;
}

const FILE_TYPE_ICON_BY_EXTENSION: Record<string, React.ComponentType<LucideProps>> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  json: FileJson,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  pdf: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  css: FilePen,
  scss: FilePen,
  html: FileCode,
  zip: FileArchive,
  gz: FileArchive,
  tar: FileArchive,
  mp3: FileAudio,
  wav: FileAudio,
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
};

export interface FileTypeIconProps extends LucideProps {
  filePath: string;
}

/** Extension → lucide file-type icon; unknown extensions render a plain File. */
export function FileTypeIcon({ filePath, ...props }: FileTypeIconProps) {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  const Component = FILE_TYPE_ICON_BY_EXTENSION[extension] ?? File;
  return <Component aria-hidden="true" {...props} />;
}

/**
 * Render an icon from the registry to a standalone SVG string (stroke inherits
 * `currentColor`, so DOM-built controls stay themed). Used by markdown decorate
 * passes that build HTML strings rather than React trees; upstream referenced
 * the shared sprite here instead.
 */
// oxlint-disable-next-line react/only-export-components -- non-component export lives beside its registry; fast-refresh granularity for this leaf shim is not a concern
export function iconToSvgString(name: IconName, className = 'size-3.5'): string {
  const Component = ICON_REGISTRY[name] ?? Circle;
  return renderToStaticMarkup(createElement(Component, { className, 'aria-hidden': true }));
}
