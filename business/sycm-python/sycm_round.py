"""Durable checkpoints contain completion metadata, never cached API data."""
import hashlib
import json
import uuid
from pathlib import Path


def fingerprint(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def product_key(item):
    return json.dumps([item['row'], item['name'], str(item.get('code') or '')], ensure_ascii=False)


def save_round(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def prepare_round(path, workbook, source, products, mode, dates, resume=False):
    identity = {'workbook': str(workbook.resolve()), 'mode': mode,
                'dates': list(dates), 'products': [product_key(p) for p in products]}
    if resume:
        state = json.loads(Path(path).read_text(encoding='utf-8'))
        if any(state.get(k) != v for k, v in identity.items()):
            raise ValueError('表格、商品范围或统计日期已变化，请开始新一轮更新')
        if state.get('fingerprint') != fingerprint(source):
            raise ValueError('总表已被修改或替换，请开始新一轮更新，避免错误跳过')
    else:
        state = dict(identity, id=uuid.uuid4().hex, completed={}, fingerprint=fingerprint(source))
        save_round(path, state)
    done = state['completed']
    return state, [p for p in products if product_key(p) not in done]


def checkpoint(path, state, destination, results):
    for result in results:
        state['completed'][product_key(result)] = {'item_id': result.get('item_id')}
    state['fingerprint'] = fingerprint(destination)
    save_round(path, state)
