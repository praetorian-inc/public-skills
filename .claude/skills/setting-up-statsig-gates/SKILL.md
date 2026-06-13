---
name: setting-up-statsig-gates
description: Use when adding a Statsig feature gate to the Guard platform — covers Statsig console setup, React hook wiring with useGateValue, available user attributes for targeting, and the provider architecture
---

## Purpose

# Setting Up a Statsig Gate

Guide for adding a feature gate (feature flag) to the Guard platform using Statsig.

## Overview

Guard uses [Statsig](https://console.statsig.com/) for feature gating. The frontend SDK (`@statsig/react-bindings`) evaluates gates client-side using user attributes populated from the authenticated session. Gates are created in the Statsig console and consumed in React via the `useGateValue` hook.

## Step 1: Create the Gate in Statsig Console

1. Open the [Statsig Console](https://console.statsig.com/).
2. Navigate to **Feature Gates** → **Create**.
3. Name the gate with the `enable_` prefix (e.g. `enable_rbac`, `enable_evm_scores`).
4. Configure targeting rules using the available user attributes (see "Available User Attributes" below).
5. Save and enable the gate.

## Step 2: Consume the Gate in React

Import `useGateValue` from `@statsig/react-bindings` and pass the gate name:

```tsx
import { useGateValue } from '@statsig/react-bindings';

function MyComponent() {
  const isEnabled = useGateValue('enable_my_feature');

  if (!isEnabled) return null;

  return <NewFeature />;
}
```

### Prefer a named hook wrapper

For gates referenced in multiple places, wrap in a hook:

```tsx
// hooks/useMyFeatureEnabled.ts
import { useGateValue } from '@statsig/react-bindings';

export function useMyFeatureEnabled(): boolean {
  return useGateValue('enable_my_feature');
}
```

This keeps the gate string in one place and gives consumers a semantic name.

## Available User Attributes

`StatsigWrapper` (`src/components/statsig/StatsigWrapper.tsx`) populates the Statsig user from the authenticated session. These fields are available for targeting rules in the Statsig console:

| Statsig field | Source | Example |
|---------------|--------|---------|
| `userID` | `whoami.principal.name` | `user@example.com` |
| `email` | Same as `userID` | `user@example.com` |
| `custom.isPraetorian` | `whoami.principal.praetorian` | `true` |
| `custom.isAssuming` | `whoami.is_assuming` | `false` |
| `custom.tenantName` | `whoami.tenant.name` | `acme-corp` |
| `custom.tenantDisplayName` | `whoami.tenant.display_name` | `Acme Corp` |
| `custom.tenantCustomerType` | `whoami.tenant.customer_type` | `ENTERPRISE` |
| `custom.principalName` | `whoami.principal.name` | `user@example.com` |
| `custom.principalDisplayName` | `whoami.principal.display_name` | `Jane Doe` |
| `custom.principalAccessType` | `whoami.principal.access_type` | `sso` |
| `custom.principalSsoDomain` | `whoami.principal.sso_domain` | `acme.okta.com` |
| `custom.role` | `whoami.role` | `admin` |

### Common targeting examples

- **Praetorian-only rollout**: target where `custom.isPraetorian == true`.
- **Specific tenant**: target where `custom.tenantName == "acme-corp"`.
- **Percentage rollout**: use Statsig's built-in % rollout on `userID`.
- **Customer type**: target where `custom.tenantCustomerType == "ENTERPRISE"`.

## Provider Architecture

`StatsigWrapper` mounts inside the provider stack after `AuthProvider`, so `whoami` is always available:

```
AuthProvider
  └─ StatsigWrapper        ← useAuth() provides whoami
       └─ <Outlet />       ← useGateValue() works here
```

The client key comes from `VITE_STATSIG_CLIENT_KEY`. The wrapper uses `useClientAsyncInit` for async initialization and calls `client.updateUserSync()` when `whoami` changes (login, impersonation).

## Defaults

- Gates default to **false** when the SDK hasn't initialized yet or the key is missing.
- Unauthenticated users get `userID: 'anonymous'` with empty custom fields.
- Gate evaluation is client-side — no network call per check after initialization.

## Existing Gates

| Gate | Hook | Used for |
|------|------|----------|
| `enable_rbac` | `useRbacEnabled()` | RBAC enforcement |
| `enable_evm_scores` | inline in `CustomerMonitoringTab` | EVM score breakdown display |

## Checklist

- [ ] Gate created in Statsig console with `enable_` prefix
- [ ] Targeting rules configured using available user attributes
- [ ] `useGateValue('enable_...')` called inside a component under `StatsigWrapper`
- [ ] Named hook wrapper created if gate is used in more than one component
- [ ] Tested with gate on and off (toggle in Statsig console or use Statsig overrides)