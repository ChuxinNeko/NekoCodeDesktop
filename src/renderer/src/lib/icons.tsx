import { type CSSProperties, type FC, type SVGProps } from "react";
import { PiSquareSplitHorizontal, PiSquareSplitVertical } from "react-icons/pi";
import { RiApps2Line } from "react-icons/ri";
import { SiGithub } from "react-icons/si";
import { VscMcp } from "react-icons/vsc";
import { cn } from "./utils";
import { CentralIcon, type CentralIconVariant } from "./central-icons";
import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconAlertTriangle,
  IconAppWindow,
  IconArchive,
  IconArrowBackUp,
  IconArrowBarToDown,
  IconArrowFork,
  IconArrowForwardUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowsLeftRight,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowsSort,
  IconArrowUp,
  IconArrowUpRight,
  IconBell,
  IconBlocks,
  IconBolt,
  IconBoltFilled,
  IconBook,
  IconBrain,
  IconBug,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleArrowUp,
  IconCircleCheck,
  IconCircleDot,
  IconCircleX,
  IconClock,
  IconCloudUpload,
  IconCode,
  IconColumns2,
  IconCopy,
  IconCornerDownRight,
  IconDeviceMobile,
  IconDots,
  IconDownload,
  IconEraser,
  IconExternalLink,
  IconEye,
  IconFile,
  IconFileDiff,
  IconFilter,
  IconFlag,
  IconFlask2,
  IconFolder,
  IconFolderOpen,
  IconFolders,
  IconGauge,
  IconGift,
  IconGitCommit,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconGitPullRequestDraft,
  IconGripVertical,
  IconHelpCircle,
  IconHistory,
  IconHome,
  IconInfoCircle,
  IconKeyboard,
  IconLayoutDistributeHorizontal,
  IconLayoutKanban,
  IconLayoutSidebar,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarRightCollapse,
  IconLink,
  IconListCheck,
  IconListDetails,
  IconLoader2,
  IconMaximize,
  IconMessage2,
  IconMessageDots,
  IconMicrophone,
  IconMinimize,
  IconMinus,
  IconDeviceLaptop,
  IconDeviceMobileRotated,
  IconPencil,
  IconPin,
  IconPinFilled,
  IconPlayerPause,
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlayerRecord,
  IconPlugOff,
  IconPower,
  IconPuzzle,
  IconMessageCircle,
  IconMoon,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconRobot,
  IconRotate2,
  IconSearch,
  IconSelector,
  IconStar,
  IconStarFilled,
  IconSun,
  IconTargetArrow,
  IconTextWrap,
  IconTrash,
  IconUsers,
  IconWorld,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";

// Keep the existing icon API stable while the app moves from Lucide to Tabler.
export type LucideIcon = FC<SVGProps<SVGSVGElement>>;

function adaptIcon(Component: TablerIcon): LucideIcon {
  return function AdaptedIcon(props) {
    return <Component {...(props as any)} />;
  };
}

// Wraps a Central icon asset behind the LucideIcon API. Rendering via CSS mask
// avoids stroke-on-stroke alpha summation that gave hand-drawn SVGs a
// "stamped twice" look on shared vertices (the previous PinIcon bug).
function centralIconWrapper(name: string, variant?: CentralIconVariant): LucideIcon {
  return function CentralIconWrapper({ className, style, ...rest }) {
    const ariaLabelRaw = (rest as { ["aria-label"]?: unknown })["aria-label"];
    const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        name={name}
        variant={variant}
        className={typeof className === "string" ? className : undefined}
        style={style as CSSProperties | undefined}
        label={label}
      />
    );
  };
}

export const AppsIcon: LucideIcon = (props) => (
  <RiApps2Line className={props.className} style={props.style} />
);
// Composer stacked-panel glyphs (subagent strip / workflow run card).
export const BackgroundTrayIcon: LucideIcon = adaptIcon(IconArrowBarToDown);
export const ContextCompactionIcon: LucideIcon = adaptIcon(IconArrowsMinimize);
export const PanelExpandIcon: LucideIcon = adaptIcon(IconArrowsMaximize);
export const PanelCollapseIcon: LucideIcon = adaptIcon(IconMinimize);
export const BackToParentIcon: LucideIcon = adaptIcon(IconArrowBackUp);
export const WorkflowIcon: LucideIcon = adaptIcon(IconClock);
export const SteerIcon: LucideIcon = adaptIcon(IconCornerDownRight);
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const HANDOFF_ICON_NAME = "arrow-left-right";
export const HandoffIcon: LucideIcon = adaptIcon(IconArrowsLeftRight);
export const SkillCubeIcon: LucideIcon = adaptIcon(IconBlocks);
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon: LucideIcon = adaptIcon(IconPlus);
/** 2x3 dot grip for drag-to-reorder handles (provider rows, sidebar nav customize). */
export const DragHandleIcon: LucideIcon = adaptIcon(IconGripVertical);
/** Sliders glyph for "customize this surface" entries. */
export const CustomizeIcon: LucideIcon = adaptIcon(IconAdjustmentsHorizontal);
export const EraserIcon: LucideIcon = adaptIcon(IconEraser);
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpRightIcon = adaptIcon(IconArrowUpRight);
export const SortIcon: LucideIcon = adaptIcon(IconArrowsSort);
// Single source for the robot/agent glyph. Sourced from the Central icon set so
// every robot affordance (reasoning rows, agent-task rows, agent mention chips,
// subagent menus, agent-activity headers) renders one identical icon. Use
// BotIcon in React; AGENT_ROBOT_ICON_NAME for imperative DOM via
// createCentralIconElement.
export const AGENT_ROBOT_ICON_NAME = "robot";
export const BotIcon: LucideIcon = adaptIcon(IconRobot);
export const BookIcon: LucideIcon = adaptIcon(IconBook);
export const BugIcon = adaptIcon(IconBug);
export const CameraIcon = adaptIcon(IconCamera);
export const CheckIcon = adaptIcon(IconCheck);
export const ChevronDownIcon = adaptIcon(IconChevronDown);
export const ChevronLeftIcon = adaptIcon(IconChevronLeft);
export const ChevronRightIcon = adaptIcon(IconChevronRight);
export const ChevronUpIcon = adaptIcon(IconChevronUp);
export const ChevronsUpDownIcon = adaptIcon(IconSelector);
export const CircleAlertIcon = adaptIcon(IconAlertCircle);
export const CircleCheckIcon = adaptIcon(IconCircleCheck);
export const CircleIcon = adaptIcon(IconCircle);
export const CircleDotIcon = adaptIcon(IconCircleDot);
export const CircleXIcon = adaptIcon(IconCircleX);
// User-input rows: a question-mark circle while the agent waits for an answer,
// and an up-arrow circle once the answer is submitted. Sourced from the Central
// set so they sit visually beside the other timeline glyphs (robot, search, …).
export const CircleQuestionIcon: LucideIcon = adaptIcon(IconHelpCircle);
export const ArrowUpCircleIcon: LucideIcon = adaptIcon(IconCircleArrowUp);
export const CloudSyncIcon = adaptIcon(IconRefresh);
export const Columns2Icon = adaptIcon(IconColumns2);
export const ChangesIcon = adaptIcon(IconFileDiff);
export const COPY_ICON_NAME = "square-behind-square-6";
export const CopyIcon = adaptIcon(IconCopy);
export const LinkIcon = adaptIcon(IconLink);
export const DiffIcon = adaptIcon(IconFileDiff);
export const DownloadIcon = adaptIcon(IconDownload);
// The clock doubles as the automation glyph everywhere it appears (meta chip,
// Automations nav, slash command, created card, environment section), so it is
// sourced from the Central icon set rather than the Tabler stroke icon.
export const BELL_ICON_NAME = "notes";
export const BellIcon: LucideIcon = adaptIcon(IconBell);
export const ClockIcon = adaptIcon(IconClock);
export const EllipsisIcon = adaptIcon(IconDots);
export const ExternalLinkIcon = adaptIcon(IconExternalLink);
export const EyeIcon = adaptIcon(IconEye);
// Markdown Source/Preview toggle glyphs, sourced from the Central set so the
// file-preview header controls share one visual language with the rest of the
// chrome (raw source = code brackets, rendered preview = open eye).
export const CodeIcon: LucideIcon = adaptIcon(IconCode);
export const EYE_OPEN_ICON_NAME = "eye-open";
export const EyeOpenIcon: LucideIcon = adaptIcon(IconEye);
export const PaperclipIcon = adaptIcon(IconPaperclip);
export const ArchiveIcon = adaptIcon(IconArchive);
export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);
export const FlagIcon = adaptIcon(IconFlag);
export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const FolderIcon = adaptIcon(IconFolder);
export const FolderOpenIcon = adaptIcon(IconFolderOpen);
// Stacked "folders" glyph used as the single representation of a file tree /
// explorer surface (right-dock explorer, editor Files activity, diff file-tree
// toggle). Central "reversed" outline asset so it matches the rest of the chrome.
export const FoldersIcon: LucideIcon = adaptIcon(IconFolders);
// Speedometer for per-call token usage: it reads as throughput, which is what
// the panel behind it is mostly about.
export const GaugeIcon = adaptIcon(IconGauge);
export const GiftIcon: LucideIcon = adaptIcon(IconGift);
export const GitCommitIcon: LucideIcon = adaptIcon(IconGitCommit);
export const GitBranchIcon: LucideIcon = centralIconWrapper("branch");
// Forking a thread reuses the branch glyph: the Central "fork" asset reads as a
// second, unrelated icon next to it, so fork and branch share one visual.
export const GitForkIcon: LucideIcon = GitBranchIcon;
export const GitMergeIcon: LucideIcon = adaptIcon(IconGitMerge);
export const GitMergedSimpleIcon: LucideIcon = adaptIcon(IconGitMerge);
export const PushIcon: LucideIcon = adaptIcon(IconCloudUpload);
export const GitHubIcon: LucideIcon = (props) => (
  <SiGithub className={props.className} style={props.style} />
);
export const GitPullRequestIcon = adaptIcon(IconGitPullRequest);
// Pull-request state glyphs from the same three-node Central family as "pull-request",
// so draft/closed/merged read as variations of one icon rather than four styles.
export const GitPullRequestDraftIcon: LucideIcon = adaptIcon(IconGitPullRequestDraft);
export const GitPullRequestClosedIcon: LucideIcon = adaptIcon(IconGitPullRequestClosed);
export const GitMergeConflictIcon: LucideIcon = adaptIcon(IconAlertTriangle);
// Three descending-width lines — the app's one "filter controls" glyph (pull
// request list filters, and anywhere else that opens a filter popover).
export const FilterIcon: LucideIcon = adaptIcon(IconFilter);
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = adaptIcon(IconUsers);
// One globe for the whole app (browser rows, web search, favicon fallback,
// local servers): the Central glyph, so it matches the other work-row icons.
export const GlobeIcon: LucideIcon = adaptIcon(IconWorld);
export const WebSearchIcon: LucideIcon = GlobeIcon;
// Handset glyph for the iOS Simulator dock pane.
export const DeviceMobileIcon: LucideIcon = adaptIcon(IconDeviceMobile);
// Hardware-button glyphs for the simulator's control rail.
export const DeviceHomeIcon: LucideIcon = adaptIcon(IconHome);
export const DeviceShutterIcon: LucideIcon = adaptIcon(IconCamera);
// Simulator toolbar: start/stop a screen recording, turn the view, power the
// device off, and let go of it. The two Tabler glyphs have no Central
// equivalent that reads as unambiguously as a rotating handset and a power symbol.
export const DeviceRecordIcon: LucideIcon = adaptIcon(IconPlayerRecord);
export const DeviceRecordStopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const DeviceRotateIcon = adaptIcon(IconDeviceMobileRotated);
export const DevicePowerIcon = adaptIcon(IconPower);
export const DeviceDetachIcon = adaptIcon(IconPlugOff);
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = adaptIcon(IconPuzzle);
// Single hammer/build glyph (tool-call rows, codex provider, "build" scripts).
// Sourced from the Central set so it matches the other work-row icons (pencil,
// terminal, skill cube) it sits beside, instead of the Tabler wrench it used to be.
export const HammerIcon: LucideIcon = centralIconWrapper("hammer");
export const HistoryIcon = adaptIcon(IconHistory);
export const InfoIcon = adaptIcon(IconInfoCircle);
export const KanbanIcon = adaptIcon(IconLayoutKanban);
export const KeyboardIcon: LucideIcon = adaptIcon(IconKeyboard);
export const ListChecksIcon = adaptIcon(IconListCheck);
export const ListTodoIcon = adaptIcon(IconListDetails);
export const Loader2Icon = adaptIcon(IconLoader2);
export const LoaderCircleIcon = adaptIcon(IconLoader2);
export const LoaderIcon = adaptIcon(IconLoader2);
export const Maximize2 = adaptIcon(IconMaximize);
export const Minimize2 = adaptIcon(IconMinimize);
export const MessageCircleIcon = adaptIcon(IconMessageCircle);
export const MinusIcon = adaptIcon(IconMinus);
export const ChatBubbleIcon: LucideIcon = adaptIcon(IconMessageCircle);
// Canonical side-chat glyph — every sidechat surface (right dock pane, environment
// panel rows, tabs) must use this one so the feature reads consistently.
export const SidechatIcon: LucideIcon = adaptIcon(IconMessage2);
export const MicIcon: LucideIcon = adaptIcon(IconMicrophone);
// The Central set ships no sidebar glyphs in this repo, so the panel toggles
// bind to the Tabler sidebar icons instead of masking a missing asset.
export const PanelLeftIcon = adaptIcon(IconLayoutSidebarLeftCollapse);
export const PanelRightCloseIcon = adaptIcon(IconLayoutSidebarRightCollapse);
export const WindowIcon: LucideIcon = adaptIcon(IconAppWindow);
export const LayoutSidebarIcon: LucideIcon = adaptIcon(IconLayoutSidebar);
export const PENCIL_ICON_NAME = "pencil";
export const PencilIcon: LucideIcon = adaptIcon(IconPencil);
export const PIN_ICON_NAME = "pin";
export const PinIcon: LucideIcon = adaptIcon(IconPin);
// Solid pin from the fill set — used wherever a pin reflects "pinned" status
// (project + thread rows and their hover cards) rather than a neutral action.
export const PinFilledIcon: LucideIcon = adaptIcon(IconPinFilled);
export const PauseIcon: LucideIcon = adaptIcon(IconPlayerPauseFilled);
export const PlayIcon: LucideIcon = adaptIcon(IconPlayerPlayFilled);
// Outline transport glyphs (Central "reversed" set) for surfaces that read as a
// row of neutral actions rather than playback state — e.g. the composer goal strip.
export const PauseOutlineIcon: LucideIcon = adaptIcon(IconPlayerPause);
export const PlayOutlineIcon: LucideIcon = adaptIcon(IconPlayerPlay);
/** Outline trash can from the Central set (Trash2 is the legacy Tabler glyph). */
export const TrashCanIcon: LucideIcon = centralIconWrapper("trash-can");
// Persistent thread goal ("Pursuing goal" strip, /goal surfaces).
export const GoalIcon: LucideIcon = adaptIcon(IconTargetArrow);
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon: LucideIcon = adaptIcon(IconSearch);
// Single source for the settings gear. Every settings affordance renders this
// one Central glyph so gears stay identical across the chrome.
export const SettingsIcon: LucideIcon = centralIconWrapper("settings-gear-4");
export const StarIcon = adaptIcon(IconStar);
export const StarFilledIcon = adaptIcon(IconStarFilled);
export const SunIcon = adaptIcon(IconSun);
export const MoonIcon = adaptIcon(IconMoon);
export const DeviceLaptopIcon = adaptIcon(IconDeviceLaptop);
export const StopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const StopFilledIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
);
const TemporaryThreadGlyph = adaptIcon(IconMessageDots);
// Dotted "annotation" chat bubble — the temporary thread marker shown on the
// composer toggle and beside temporary threads in the sidebar.
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-3.5 shrink-0", className)} {...props} />
);
export const TERMINAL_ICON_NAME = "console";
export const TerminalIcon = centralIconWrapper(TERMINAL_ICON_NAME);
export const TerminalSquare = centralIconWrapper("console");
export const TerminalSquareIcon = centralIconWrapper("console");
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
// Single source for every "reset / restore default / revert" affordance (settings
// row resets, Restore defaults, effort-slider reset, space reset, file revert):
// the Central reversed counter-clockwise arrow, never a Tabler/Lucide rotate glyph.
export const ResetIcon: LucideIcon = adaptIcon(IconRestore);
export const Redo2Icon = adaptIcon(IconArrowForwardUp);
export const WorktreeIcon = adaptIcon(IconArrowFork);
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
// Single source for the fast-mode glyph. Every fast-mode affordance (composer
// trait badges, the effort-header toggle, the /fast command) renders this one solid
// lightning bolt from the Central fill set instead of mixing Tabler/Ionicons bolts.
export const FastModeIcon: LucideIcon = adaptIcon(IconBoltFilled);
// Outline twin of FastModeIcon (Central reversed set) for the inactive toggle state.
export const FastModeOutlineIcon: LucideIcon = adaptIcon(IconBolt);
