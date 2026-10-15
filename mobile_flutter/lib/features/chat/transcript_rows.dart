import '../../core/protocol.dart';

/// Mirrors src/shared/transcript.ts. Stable turn keys survive streaming IDs.
class TranscriptRow {
  TranscriptRow(this.kind, this.id, {this.cell, List<TranscriptRow>? items})
    : items = items ?? [];
  final String kind, id;
  final Json? cell;
  final List<TranscriptRow> items;
  int startedAt = 0, endedAt = 0;
}

int _stamp(dynamic value) => value is num ? value.toInt() : 0;
int _start(Json cell) =>
    _stamp(cell['thinkingStartedAt'] ?? cell['startedAt'] ?? cell['timestamp']);
int _end(Json cell) => _stamp(cell['thinkingEndedAt'] ?? cell['timestamp']);

List<TranscriptRow> transcriptRows(
  List<Json> cells, {
  required bool streaming,
}) {
  final rows = <TranscriptRow>[];
  TranscriptRow? open;
  var turn = 'start';
  var seq = 0;
  void close([int? end]) {
    if (open != null && end != null && end > open!.endedAt) {
      open!.endedAt = end;
    }
    open = null;
  }

  void add(String kind, Json cell) {
    if (open == null) {
      open = TranscriptRow('work', 'work-$turn-${seq++}')
        ..startedAt = _start(cell)
        ..endedAt = _end(cell);
      rows.add(open!);
    }
    open!.items.add(TranscriptRow(kind, '${cell['id']}-$kind', cell: cell));
    if (_start(cell) < open!.startedAt) open!.startedAt = _start(cell);
    if (_end(cell) > open!.endedAt) open!.endedAt = _end(cell);
  }

  for (final cell in cells) {
    final id = string(cell['id'], '${cell['timestamp']}');
    switch (cell['type']) {
      case 'user':
        close();
        turn = id;
        seq = 0;
        rows.add(TranscriptRow('user', id, cell: cell));
      case 'tool':
        add('tool', cell);
      case 'notice':
        if (open != null) {
          add('notice', cell);
        } else {
          rows.add(TranscriptRow('notice', id, cell: cell));
        }
      case 'assistant':
        if (string(cell['thinking']).isNotEmpty) add('thinking', cell);
        if (string(cell['text']).isNotEmpty ||
            cell['error'] != null ||
            cell['usage'] != null) {
          close(_end(cell));
          rows.add(TranscriptRow('message', '$id-message', cell: cell));
        }
    }
  }
  final unwrapped = <TranscriptRow>[
    for (final row in rows)
      if (row.kind == 'work' && !row.items.any((i) => i.kind == 'tool'))
        ...row.items
      else
        row,
  ];
  final out = <TranscriptRow>[];
  var start = 0;
  turn = 'start';
  void flush(int end, bool settled) {
    final segment = unwrapped.sublist(start, end);
    if (segment.isEmpty) return;
    final reply = segment.last;
    final process = segment.take(segment.length - 1).toList();
    if (!settled ||
        reply.kind != 'message' ||
        !process.any((r) => r.kind == 'work')) {
      out.addAll(segment);
      return;
    }
    final folded = TranscriptRow('work', 'turn-$turn');
    for (final row in process) {
      folded.items.addAll(row.kind == 'work' ? row.items : [row]);
    }
    folded.startedAt = folded.items
        .map((i) => _start(i.cell!))
        .reduce((a, b) => a < b ? a : b);
    folded.endedAt = [
      ...process.map((r) => r.kind == 'work' ? r.endedAt : _end(r.cell!)),
      _end(reply.cell!),
    ].reduce((a, b) => a > b ? a : b);
    out.addAll([folded, reply]);
  }

  for (var i = 0; i < unwrapped.length; i++) {
    final row = unwrapped[i];
    if (row.kind != 'user') continue;
    flush(i, true);
    out.add(row);
    turn = row.id;
    start = i + 1;
  }
  flush(unwrapped.length, !streaming);
  return out;
}

bool waitingOnModel(List<Json> cells, bool streaming) {
  if (!streaming) return false;
  if (cells.isEmpty) return true;
  final last = cells.last;
  return switch (last['type']) {
    'user' || 'notice' => true,
    'tool' => last['status'] == 'done' || last['status'] == 'error',
    'assistant' =>
      last['streaming'] == true &&
          string(last['text']).isEmpty &&
          string(last['thinking']).isEmpty,
    _ => false,
  };
}
