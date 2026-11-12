import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinConfig } from "../../src/commands/scan-zones/config.ts";
import { scanFile, scanText } from "../../src/commands/scan-zones/scan.ts";
import type { FileInput, Zone } from "../../src/commands/scan-zones/types.ts";

const config = builtinConfig();

// Fixtures sit under a test path, so each scan names a source path where content signals run.
const fixture = (name: string) => readFileSync(new URL(`fixtures/webhooks/${name}`, import.meta.url), "utf8");

function zonesOf(line: string, path: string): Zone[] {
  return scanText(config, path, `${line}\n`).zones;
}

function removal(path: string, line: string): FileInput {
  return { path, content: "\n", added: new Set(), removed: [{ line: 1, text: line }], deleted: false };
}

describe("webhook receivers", () => {
  it("flags every webhook line in a WordPress receiver", () => {
    const scan = scanText(config, "includes/webhook.php", fixture("receiver.php"));
    const authLines = scan.matches.filter((match) => match.zone === "auth").map((match) => match.text);
    expect(authLines).toEqual(
      expect.arrayContaining([
        "'/webhook',",
        "'permission_callback' => 'acme_verify_webhook_signature',",
        "$secret   = get_option( 'acme_webhook_secret' );",
        "$provided = (string) $request->get_header( 'X-Acme-Signature' );",
        "return hash_equals( $expected, $provided );",
      ]),
    );
    expect(scan.zones).toEqual(expect.arrayContaining(["auth", "authz", "crypto"]));
  });

  it("flags every webhook line in an Express receiver", () => {
    const scan = scanText(config, "src/webhooks.js", fixture("receiver.js"));
    const authLines = new Set(scan.matches.filter((match) => match.zone === "auth").map((match) => match.line));
    expect([...authLines]).toEqual([2, 6, 7]);
  });

  it("stays quiet on a WordPress notice that only names webhooks", () => {
    expect(scanText(config, "includes/notice.php", fixture("notice.php")).zones).toEqual([]);
  });

  it("stays quiet on a component that only names webhooks", () => {
    expect(scanText(config, "src/WebhookDeliveries.jsx", fixture("deliveries.jsx")).zones).toEqual([]);
  });

  it.each([
    ["a.php", "add_action( 'admin_post_nopriv_acme_event', 'acme_event' );", "authz"],
    ["a.php", "add_action( 'woocommerce_api_acme_gateway', array( $this, 'ipn' ) );", "authz"],
    ["a.php", "$sig = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';", "auth"],
    ["a.php", "$event = \\Stripe\\Webhook::constructEvent( $payload, $header, $secret );", "auth"],
    ["a.php", "if ( $signature == $expected ) {", "crypto"],
    ["a.js", "app.post('/api/webhook', handler);", "auth"],
    ["a.js", "const signature = request.headers.get('stripe-signature');", "auth"],
    ["a.js", "const event = stripe.webhooks.constructEvent(body, header, secret);", "auth"],
    ["a.ts", "const ok = await isValidWebhook(request);", "auth"],
  ] as const)("flags %s: %s as %s", (path, line, zone) => {
    expect(zonesOf(line, path)).toContain(zone);
  });

  it.each([
    ["a.php", "echo esc_html__( 'Webhook', 'acme' );"],
    ["a.php", "$url = get_option( 'acme_webhook_url' );"],
    ["a.php", "update_user_meta( $id, 'email_signature', $text );"],
    ["a.js", "const title = 'Webhook deliveries';"],
    ["a.js", "const hooks = await listWebhooks(account);"],
  ])("stays quiet on %s: %s", (path, line) => {
    expect(zonesOf(line, path)).not.toContain("auth");
  });

  it.each([
    ["a.php", "if ( ! hash_equals( $expected, $provided ) ) {"],
    ["a.php", "$provided = $request->get_header( 'X-Acme-Signature' );"],
    ["a.js", "if (!verifyWebhookSignature(body, header)) return res.sendStatus(401);"],
  ])("lists the removed check in %s: %s as a weakened control", (path, line) => {
    expect(scanFile(config, removal(path, line)).removed.map((match) => match.zone)).toContain("auth");
  });

  it("names Next.js webhook route files as auth by path", () => {
    expect(scanText(config, "app/api/webhooks/stripe/route.ts", "").zones).toContain("auth");
    expect(scanText(config, "pages/api/stripe-webhook.ts", "").zones).toContain("auth");
    expect(scanText(config, "app/api/orders/route.ts", "").zones).not.toContain("auth");
  });
});
