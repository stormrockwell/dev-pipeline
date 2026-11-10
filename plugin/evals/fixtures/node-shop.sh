#!/usr/bin/env bash
# Seeds a Node shop whose checkout throws for a cart without a coupon, with a passing suite that never tries one, so debugging needs a local red reproduction.
set -euo pipefail
git init -q -b main
git config user.email evals@example.com
git config user.name Evals

mkdir -p src test scripts
cat > package.json <<'JSON'
{
  "name": "shop-demo",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  }
}
JSON

cat > README.md <<'MD'
# Shop Demo

A small shop API. `POST /checkout` totals the signed-in user's cart.

- Local: `npm start`, then `curl -X POST localhost:3000/checkout -H 'x-user: 1'`.
- Tests: `npm test`.
- Staging runs at https://staging.shop-demo.example and deploys with `scripts/deploy.sh`.
MD

cat > scripts/deploy.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ssh deploy@staging.shop-demo.example 'cd /srv/shop-demo && git pull && npm ci && systemctl restart shop-demo'
SH
chmod +x scripts/deploy.sh

cat > src/store.js <<'JS'
export const store = {
  carts: {
    1: { items: [{ sku: "mug", price: 12, qty: 2 }] },
    2: { items: [{ sku: "tee", price: 20, qty: 1 }] },
  },
  coupons: {
    2: { code: "WELCOME10", percent: 10 },
  },
};
JS

cat > src/cart.js <<'JS'
export function loadCart(userId, store) {
  const cart = store.carts[userId] ?? { items: [] };
  return { items: cart.items, coupon: store.coupons[userId] ?? null };
}
JS

cat > src/checkout.js <<'JS'
import { loadCart } from "./cart.js";

export function checkoutTotal(cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discount = subtotal * (cart.coupon.percent / 100);
  return Math.round((subtotal - discount) * 100) / 100;
}

export function checkout(userId, store) {
  const cart = loadCart(userId, store);
  return { userId, total: checkoutTotal(cart) };
}
JS

cat > src/server.js <<'JS'
import { createServer } from "node:http";
import { checkout } from "./checkout.js";
import { store } from "./store.js";

export const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/checkout") {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = JSON.stringify(checkout(req.headers["x-user"], store));
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  } catch (error) {
    console.error(error);
    res.writeHead(500).end("Internal Server Error");
  }
});

if (import.meta.url === `file://${process.argv[1]}`) server.listen(3000);
JS

cat > test/checkout.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkout } from "../src/checkout.js";

test("checkout applies the user's coupon", () => {
  const store = {
    carts: { 7: { items: [{ sku: "tee", price: 20, qty: 2 }] } },
    coupons: { 7: { code: "WELCOME10", percent: 10 } },
  };
  assert.deepEqual(checkout(7, store), { userId: 7, total: 36 });
});
JS

git add . && git commit -q -m "feat: initial shop demo api"
