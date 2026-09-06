"""Read-only report adapter; no browser-supplied filesystem paths."""
import json
from pathlib import Path

def stored_audit(root=None):
    root = Path(root) if root else Path(__file__).resolve().parents[1] / 'strategy-lab' / 'reports'
    reports = []
    for file in root.glob('stored-audit-*.json'):
        try:
            data = json.loads(file.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or not isinstance(data.get('strategies'), dict):
                continue
            if data.get('assumptions', {}).get('mode') != 'OFFLINE_RESEARCH_ONLY':
                continue
            if not isinstance(data.get('generatedAt'), str):
                continue
            reports.append((data['generatedAt'], file.name, data))
        except (ValueError, OSError, TypeError, AttributeError):
            continue
    if not reports:
        return {'ok': False, 'error': 'No readable stored-data audit. Run scripts/audit-stored-strategies.mjs.'}
    _, name, data = max(reports, key=lambda item: item[0])
    return {'ok': True, 'report': name, 'generatedAt': data['generatedAt'],
            'assumptions': data.get('assumptions', {}), 'files': data.get('files', []),
            'errors': data.get('errors', []), 'strategies': {key: {
                'summary': val.get('summary', {}), 'signals': val.get('signals', 0),
                'unresolved': val.get('unresolved', 0), 'gates': val.get('gates', {})}
                for key, val in data['strategies'].items() if isinstance(val, dict)}}
