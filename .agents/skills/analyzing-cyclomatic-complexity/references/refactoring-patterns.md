# Refactoring Patterns to Reduce Cyclomatic Complexity

## Pattern 1: Extract Method

**When to use**: Function does multiple things or has high complexity

**Complexity reduction**: High (splits decision paths into separate functions)

### Before (Complexity: 12)

```typescript
function processOrder(order: Order): OrderResult {
  // Validation
  if (!order.items || order.items.length === 0) {
    return { success: false, error: "No items" };
  }

  // Price calculation
  let total = 0;
  for (const item of order.items) {
    if (item.discount) {
      total += item.price * (1 - item.discount);
    } else {
      total += item.price;
    }
  }

  // Tax calculation
  let tax = 0;
  if (order.location === "CA") {
    tax = total * 0.0725;
  } else if (order.location === "NY") {
    tax = total * 0.08875;
  } else if (order.location === "TX") {
    tax = total * 0.0625;
  }

  // Shipping calculation
  let shipping = 0;
  if (total < 50) {
    shipping = 10;
  } else if (total < 100) {
    shipping = 5;
  }

  return {
    success: true,
    total: total + tax + shipping,
    breakdown: { subtotal: total, tax, shipping },
  };
}
```

### After (Complexity: 2 + 3 + 2 + 2 = 9 total, max per function: 3)

```typescript
function processOrder(order: Order): OrderResult {
  const validation = validateOrder(order);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const subtotal = calculateSubtotal(order.items);
  const tax = calculateTax(subtotal, order.location);
  const shipping = calculateShipping(subtotal);

  return {
    success: true,
    total: subtotal + tax + shipping,
    breakdown: { subtotal, tax, shipping },
  };
}
// Complexity: 2

function validateOrder(order: Order): ValidationResult {
  if (!order.items || order.items.length === 0) {
    return { valid: false, error: "No items" };
  }
  return { valid: true };
}
// Complexity: 1

function calculateSubtotal(items: OrderItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.discount) {
      total += item.price * (1 - item.discount);
    } else {
      total += item.price;
    }
  }
  return total;
}
// Complexity: 3 (for loop + if)

function calculateTax(amount: number, location: string): number {
  const taxRates: Record<string, number> = {
    CA: 0.0725,
    NY: 0.08875,
    TX: 0.0625,
  };
  return amount * (taxRates[location] || 0);
}
// Complexity: 1 (no conditionals - lookup table)

function calculateShipping(subtotal: number): number {
  if (subtotal >= 100) return 0;
  if (subtotal >= 50) return 5;
  return 10;
}
// Complexity: 2
```

**Benefits:**

- Each function is simple and testable
- Clear separation of concerns
- Easy to modify tax rates without touching other logic
- Reusable functions

---

## Pattern 2: Guard Clauses (Early Returns)

**When to use**: Deeply nested conditionals checking preconditions

**Complexity reduction**: Medium (flattens structure, doesn't eliminate branches)

### Before (Complexity: 8)

```typescript
function sendNotification(user: User, message: Message): void {
  if (user) {
    if (user.preferences) {
      if (user.preferences.notificationsEnabled) {
        if (user.email) {
          if (message.priority === "high") {
            sendEmail(user.email, message);
          } else {
            if (user.preferences.lowPriorityEnabled) {
              sendEmail(user.email, message);
            }
          }
        }
      }
    }
  }
}
```

### After (Complexity: 5)

```typescript
function sendNotification(user: User, message: Message): void {
  if (!user) return;
  if (!user.preferences) return;
  if (!user.preferences.notificationsEnabled) return;
  if (!user.email) return;

  if (message.priority === "high") {
    sendEmail(user.email, message);
    return;
  }

  if (user.preferences.lowPriorityEnabled) {
    sendEmail(user.email, message);
  }
}
```

**Benefits:**

- Easier to read (linear flow)
- Clear preconditions at the top
- Reduced nesting depth
- Same decision points but clearer structure

---

## Pattern 3: Strategy Pattern (Polymorphism)

**When to use**: Large switch/if-else chains with similar operations

**Complexity reduction**: High (eliminates all conditional branches)

### Before (Complexity: 9)

```typescript
function calculateDiscount(type: string, basePrice: number): number {
  if (type === "new-customer") {
    return basePrice * 0.9; // 10% off
  } else if (type === "loyalty-bronze") {
    return basePrice * 0.85; // 15% off
  } else if (type === "loyalty-silver") {
    return basePrice * 0.8; // 20% off
  } else if (type === "loyalty-gold") {
    return basePrice * 0.75; // 25% off
  } else if (type === "employee") {
    return basePrice * 0.5; // 50% off
  } else if (type === "seasonal") {
    if (isHolidaySeason()) {
      return basePrice * 0.7; // 30% off
    }
    return basePrice * 0.95; // 5% off
  } else {
    return basePrice;
  }
}
```

### After (Complexity: 1)

```typescript
interface DiscountStrategy {
  calculate(basePrice: number): number;
}

const discountStrategies: Record<string, DiscountStrategy> = {
  "new-customer": { calculate: (price) => price * 0.9 },
  "loyalty-bronze": { calculate: (price) => price * 0.85 },
  "loyalty-silver": { calculate: (price) => price * 0.8 },
  "loyalty-gold": { calculate: (price) => price * 0.75 },
  employee: { calculate: (price) => price * 0.5 },
  seasonal: {
    calculate: (price) => price * (isHolidaySeason() ? 0.7 : 0.95),
  },
};

function calculateDiscount(type: string, basePrice: number): number {
  const strategy = discountStrategies[type];
  return strategy ? strategy.calculate(basePrice) : basePrice;
}
// Complexity: 1 (ternary only)
```

**Benefits:**

- Easy to add new discount types (Open/Closed Principle)
- No modification of calculateDiscount function
- Testable strategies in isolation
- Clear separation of policies

---

## Pattern 4: Simplify Boolean Logic

**When to use**: Nested if statements with simple boolean conditions

**Complexity reduction**: Low-Medium (combines conditions)

### Before (Complexity: 4)

```typescript
function canAccessResource(user: User, resource: Resource): boolean {
  if (user.isAdmin) {
    return true;
  }
  if (user.isOwner(resource)) {
    if (resource.isPublished) {
      return true;
    }
  }
  if (resource.isPublic) {
    if (user.isAuthenticated) {
      return true;
    }
  }
  return false;
}
```

### After (Complexity: 1)

```typescript
function canAccessResource(user: User, resource: Resource): boolean {
  return (
    user.isAdmin ||
    (user.isOwner(resource) && resource.isPublished) ||
    (resource.isPublic && user.isAuthenticated)
  );
}
```

**Benefits:**

- More concise
- Logical structure clear
- Single expression easier to test

**Caution**: Don't over-use - complex boolean expressions can be less readable than explicit if statements.

## See also

- [More Refactoring Patterns](../../../../.gemini/skills/analyzing-cyclomatic-complexity/references/refactoring-patterns-more.md) — Patterns 5–7 (Lookup Tables, Decompose Conditional, Replace Nested Conditionals with Polymorphism)
- [Refactoring Anti-Patterns](../../../../.gemini/skills/analyzing-cyclomatic-complexity/references/refactoring-anti-patterns.md) — when extracting hurts more than it helps

## References

- Martin Fowler: "Refactoring: Improving the Design of Existing Code"
- [Reducing Cyclomatic Complexity - Medium](https://medium.com/@brooknovak/reducing-cyclomatic-complexity-in-your-code-bb132d1665a2)
- [LinearB: How to Reduce Cyclomatic Complexity](https://linearb.io/blog/reduce-cyclomatic-complexity)
