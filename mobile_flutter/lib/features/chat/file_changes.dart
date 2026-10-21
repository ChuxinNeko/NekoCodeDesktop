import '../../core/protocol.dart';
import 'transcript_rows.dart';

class ChangedFile {
  const ChangedFile(this.path, this.additions, this.deletions);
  final String path;
  final int additions, deletions;
}

class TurnChanges {
  const TurnChanges({
    required this.checkpointId,
    required this.promptId,
    required this.files,
  });
  final String checkpointId, promptId;
  final List<ChangedFile> files;
  int get additions => files.fold(0, (sum, f) => sum + f.additions);
  int get deletions => files.fold(0, (sum, f) => sum + f.deletions);
}

int _count(dynamic value) => value is num ? value.toInt().clamp(0, 1 << 40) : 0;
int _live(int count, bool live) => live && count >= 5 ? count ~/ 5 * 5 : count;
List<String> _lines(String text, bool streaming) {
  // Legacy desktops may trim args; never count the transport notice as code.
  final cut = text.indexOf('\n…（另有 ');
  if (cut >= 0) {
    text = text.substring(0, cut);
    streaming = true;
  }
  final lines = text.replaceAll('\r\n', '\n').split('\n');
  if (streaming || lines.last.isEmpty) lines.removeLast();
  return lines;
}

ChangedFile fileEditStats(Json cell, {bool active = false}) {
  final args = object(cell['args'] ?? cell['input']);
  final path = string(args['path'], string(args['file_path']));
  if (cell['status'] == 'error') return ChangedFile(path, 0, 0);
  var added = 0, removed = 0;
  final stats = cell['changeStats'];
  if (stats is Map) {
    added = _count(stats['insertions']);
    removed = _count(stats['deletions']);
  } else {
    final name = string(cell['toolName']);
    final streaming = cell['inputStreaming'] == true;
    if (name == 'write' || name == 'writeFile') {
      if (args['content'] is String) {
        added = _lines(args['content'], streaming).length;
      }
    } else if (name == 'edit') {
      final diff = string(object(cell['details'])['diff']);
      if (diff.isNotEmpty) {
        for (final line in diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) added++;
          if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }
      } else {
        final edits = [
          ...records(args['edits']),
          if (args['oldText'] is String || args['newText'] is String) args,
        ];
        for (final edit in edits) {
          if (edit['oldText'] is String) {
            removed += _lines(edit['oldText'], streaming).length;
          }
          if (edit['newText'] is String) {
            added += _lines(edit['newText'], streaming).length;
          }
        }
      }
    }
  }
  final live = active && cell['status'] != 'done';
  return ChangedFile(path, _live(added, live), _live(removed, live));
}

ChangedFile stageChanges(List<TranscriptRow> items, {required bool active}) {
  var added = 0, removed = 0;
  for (final item in items) {
    if (item.kind != 'tool') continue;
    final stats = fileEditStats(item.cell!, active: active);
    added += stats.additions;
    removed += stats.deletions;
  }
  return ChangedFile('', added, removed);
}

TurnChanges _checkpoint(Json checkpoint) => TurnChanges(
  checkpointId: string(checkpoint['id']),
  promptId: string(checkpoint['cellId']),
  files: [
    for (final file in records(checkpoint['files']))
      ChangedFile(
        string(file['path']),
        _count(file['additions']),
        _count(file['deletions']),
      ),
  ],
);

/// New desktops send a complete-turn hint before cutting the history window.
/// Fall back to local projection for older desktops; never reuse a previous turn.
TurnChanges? snapshotTurnChanges(Json snapshot) {
  final hint = snapshot['currentTurnChanges'];
  if (hint is Map) {
    final summary = _checkpoint(object(hint));
    final prompt = records(
      snapshot['cells'],
    ).where((c) => c['type'] == 'user').lastOrNull;
    if (summary.files.isNotEmpty &&
        (prompt == null || prompt['id'] == summary.promptId)) {
      return summary;
    }
  }
  return activeTurnChanges(
    records(snapshot['cells']),
    records(snapshot['checkpoints']),
    live: snapshot['streaming'] == true,
    cwd: string(object(snapshot['session'])['cwd']),
  );
}

String normalizeChangedPath(String path, String cwd) {
  var value = path.replaceAll('\\', '/').replaceFirst(RegExp(r'^\./'), '');
  final root = cwd.replaceAll('\\', '/').replaceFirst(RegExp(r'/+$'), '');
  if (root.isNotEmpty &&
      value.toLowerCase().startsWith('${root.toLowerCase()}/')) {
    value = value.substring(root.length + 1);
  }
  return value;
}

/// Always anchor to the latest user prompt; never leak a previous turn's files.
TurnChanges? activeTurnChanges(
  List<Json> cells,
  List<Json> checkpoints, {
  required bool live,
  String cwd = '',
}) {
  final index = cells.lastIndexWhere((c) => c['type'] == 'user');
  if (index < 0) return null;
  final prompt = string(cells[index]['id']);
  final checkpoint = checkpoints
      .where((c) => c['cellId'] == prompt)
      .firstOrNull;
  if (checkpoint == null) return null;
  final summary = _checkpoint(checkpoint);
  if (!live) return summary.files.isEmpty ? null : summary;
  final edits = <String, ChangedFile>{};
  for (final cell in cells.skip(index + 1)) {
    if (cell['type'] != 'tool' ||
        cell['status'] == 'error' ||
        !['edit', 'write', 'writeFile'].contains(cell['toolName'])) {
      continue;
    }
    final stats = fileEditStats(cell, active: true);
    if (stats.path.isEmpty) continue;
    final path = normalizeChangedPath(stats.path, cwd);
    final old = edits[path];
    edits[path] = ChangedFile(
      path,
      (old?.additions ?? 0) + stats.additions,
      (old?.deletions ?? 0) + stats.deletions,
    );
  }
  final files = [
    for (final file in summary.files)
      edits.remove(normalizeChangedPath(file.path, cwd)) ?? file,
    ...edits.values,
  ];
  return files.isEmpty
      ? null
      : TurnChanges(
          checkpointId: summary.checkpointId,
          promptId: prompt,
          files: files,
        );
}

Map<String, TurnChanges> completedTurnChanges(
  List<TranscriptRow> rows,
  List<Json> checkpoints, {
  required bool streaming,
  TurnChanges? currentHint,
}) {
  final byPrompt = <String, TurnChanges>{};
  for (final checkpoint in checkpoints) {
    if (checkpoint['cellId'] is String) {
      byPrompt.putIfAbsent(checkpoint['cellId'], () => _checkpoint(checkpoint));
    }
  }
  final cards = <String, TurnChanges>{};
  TurnChanges? current = rows.any((row) => row.kind == 'user')
      ? null
      : currentHint;
  for (var i = 0; i < rows.length; i++) {
    final row = rows[i];
    if (row.kind == 'user') current = byPrompt[row.cell?['id']];
    final ended = i + 1 == rows.length
        ? !streaming
        : rows[i + 1].kind == 'user';
    if (ended && current != null && current.files.isNotEmpty) {
      cards[row.id] = current;
    }
  }
  return cards;
}
