"""Server-owned permissions and product features; billing is deliberately separate."""

ROLE_PERMISSIONS = {
    'user': frozenset(),
    'admin': frozenset({'server:manage'}),
}

# Both tiers have the same features during beta. Payment never grants admin rights.
PLAN_FEATURES = {
    'free': frozenset({'maps:use'}),
    'paid': frozenset({'maps:use'}),
}


def capabilities(role, plan):
    if role not in ROLE_PERMISSIONS or plan not in PLAN_FEATURES:
        return []
    return sorted(ROLE_PERMISSIONS[role] | PLAN_FEATURES[plan])
