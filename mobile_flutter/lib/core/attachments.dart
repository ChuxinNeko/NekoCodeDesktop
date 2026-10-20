import 'dart:typed_data';

/// 一次最多附加的数量与单个大小上限（与电脑端 mobile-uploads.ts 保持一致）。
const maxAttachments = 8;
const maxAttachmentBytes = 10 * 1024 * 1024;

const _mimeTypes = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
  'gif': 'image/gif',
  'bmp': 'image/bmp',
  'heic': 'image/heic',
  'pdf': 'application/pdf',
  'txt': 'text/plain',
  'md': 'text/markdown',
  'json': 'application/json',
  'csv': 'text/csv',
  'zip': 'application/zip',
};

String mimeTypeOf(String name) {
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return _mimeTypes[ext] ?? 'application/octet-stream';
}

/// 电脑端能直接作为图片交给模型的格式；其他图片（如 HEIC）按普通文件发送。
bool isPromptImage(String mimeType) => const {
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
}.contains(mimeType);

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

enum AttachmentStatus { uploading, done, failed }

/// 输入框里一个待发送的附件：选中后立即分片上传到电脑。
class PendingAttachment {
  PendingAttachment({required this.name, required this.bytes, String? mimeType})
    : mimeType = mimeType ?? mimeTypeOf(name),
      key = '${DateTime.now().microsecondsSinceEpoch}-${name.hashCode}';

  final String key, name, mimeType;
  final Uint8List bytes;
  AttachmentStatus status = AttachmentStatus.uploading;
  double progress = 0;
  String? uploadId, error;

  int get size => bytes.length;
  bool get isImage => isPromptImage(mimeType);
}
