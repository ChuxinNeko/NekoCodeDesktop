import FilePreviewWorker from "./filePreviewHighlight.worker?worker&inline";
import { createFilePreviewHighlighter } from "./filePreviewHighlightClient";

// Blob-backed workers also work in packaged Electron's file:// renderer.
export const highlightFilePreview = createFilePreviewHighlighter(() => new FilePreviewWorker());
