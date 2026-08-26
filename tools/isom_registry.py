"""Load and enforce OMapMaker's versioned ISOM symbol registry."""
from __future__ import annotations

import json
from pathlib import Path


REGISTRY_PATH = Path(__file__).resolve().parents[1] / 'isom_symbols.js'
REGISTRY_PREFIX = 'window.OMAPMAKER_ISOM_REGISTRY = '
REGISTRY_SUFFIX = ';'


def load_registry(path=REGISTRY_PATH):
    text = Path(path).read_text(encoding='utf-8').strip()
    if not text.startswith(REGISTRY_PREFIX) or not text.endswith(REGISTRY_SUFFIX):
        raise RuntimeError('ISOM-registret har ett ogiltigt filformat')
    registry = json.loads(text[len(REGISTRY_PREFIX):-len(REGISTRY_SUFFIX)])
    if not isinstance(registry.get('registryVersion'), int) or registry['registryVersion'] < 1:
        raise RuntimeError('ISOM-registret saknar en giltig version')
    return registry


REGISTRY = load_registry()
REGISTRY_VERSION = REGISTRY['registryVersion']
MANUAL_TYPES = REGISTRY['manualTypes']
ALIASES = REGISTRY.get('aliases', {})


def canonical_manual_type(object_type):
    value = str(object_type or '')
    return ALIASES.get(value, value)


def manual_definition(category, object_type):
    object_type = canonical_manual_type(object_type)
    definition = MANUAL_TYPES.get(object_type)
    if not definition or definition.get('category') != category:
        return object_type, None
    return object_type, definition


def normalize_manual_classification(category, object_type, *, require_publishable=True):
    object_type, definition = manual_definition(category, object_type)
    if not definition:
        raise ValueError('Objekttypen finns inte i OMapMakers symbolregister')
    if require_publishable and not definition.get('publishable'):
        raise ValueError('Objekttypen saknar säker ISOM-koppling och måste klassificeras om före publicering')
    return object_type, str(definition.get('symbol') or '')


def normalize_stored_classification(category, object_type, symbol):
    """Normalize historical data without discarding ambiguous observations."""
    object_type, definition = manual_definition(category, object_type)
    if not definition:
        return object_type, ''
    return object_type, str(definition.get('symbol') or '')
